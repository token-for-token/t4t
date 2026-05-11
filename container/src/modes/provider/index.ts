import {Bee} from '@ethersphere/bee-js'
import {join} from 'node:path'
import type {ProviderConfig} from '../../lib/config'
import {
  claimJob,
  deactivateProvider,
  getProvider,
  makeChain,
  registerProvider,
  sendHeartbeat,
  updateOfferings,
  ensureAllowance,
} from '../../lib/chain'
import {logger} from '../../lib/logger'
import {PssTransport} from '../../lib/swarm'
import {providerTopic} from '../../lib/envelope'
import {PassthroughCipher} from '../../lib/crypto'
import {JobPostedIndex} from '../../lib/job-index'
import {JobsDb} from '../../lib/jobs-db'
import {OllamaClient} from '../../lib/ollama'
import {pssPubKeyFromWallet} from '../../lib/keys'
import type {Hex, ModelOffering} from '../../lib/types'
import {startAdminServer} from './admin'
import {processJob, type WorkerProgress} from './worker'
import {JobQueue, isJobNotify} from './listener'

const PROVIDER_INITIAL_STAKE = 100n * 10n ** 18n // 100 xBZZ

export async function runProvider(cfg: ProviderConfig): Promise<void> {
  const log = logger.child({mode: 'provider'})
  const bee = new Bee(cfg.BEE_API_URL)
  const chain = makeChain({
    rpcUrl: cfg.GNOSIS_RPC_URL,
    privateKey: cfg.walletKey,
    registry: cfg.REGISTRY_ADDRESS,
    escrow: cfg.ESCROW_ADDRESS,
    xbzz: cfg.XBZZ_ADDRESS,
  })

  // First-run register. Idempotent: we read state, then write if missing.
  const existing = await getProvider(chain, chain.address)
  if (!existing.owner || existing.owner === '0x0000000000000000000000000000000000000000') {
    await ensureAllowance(chain, cfg.REGISTRY_ADDRESS, PROVIDER_INITIAL_STAKE)
    const overlay = (await bee.getNodeAddresses().catch(() => null))?.overlay ?? '0x' + '00'.repeat(32)
    await registerProvider(chain, {
      pssPublicKey: pssPubKeyFromWallet(chain.address),
      swarmOverlay: ('0x' + overlay.toString().replace(/^0x/, '')) as Hex,
      metadataURI: '',
      initialStake: PROVIDER_INITIAL_STAKE,
    })
    log.info('registered on-chain')
  }

  const offerings: ModelOffering[] = cfg.T4T_OFFERED_MODELS.split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(modelId => ({
      modelId,
      pricePerKToken: cfg.T4T_PRICE_PER_KTOKEN_DEFAULT,
      maxContextTokens: 0n,
      maxLatencySeconds: 120,
    }))
  if (offerings.length > 0) {
    await updateOfferings(chain, offerings)
    log.info({count: offerings.length}, 'offerings published')
  }

  setInterval(() => {
    sendHeartbeat(chain).catch(err => log.warn({err}, 'heartbeat failed'))
  }, cfg.T4T_HEARTBEAT_INTERVAL_SECONDS * 1000)

  const cipher = new PassthroughCipher()
  const pss = new PssTransport({
    bee,
    postageBatchId: cfg.POSTAGE_BATCH_ID,
    logger: log,
    selfAddress: chain.address,
  })
  const queue = new JobQueue(cfg.T4T_MAX_CONCURRENT_JOBS)
  const ollama = new OllamaClient(cfg.OLLAMA_URL)
  const jobIndex = new JobPostedIndex(chain, chain.address, log)
  jobIndex.start()
  const db = new JobsDb({path: join(cfg.T4T_DATA_DIR, 'jobs.db')})
  const signMessage = async (msg: string) =>
    (await chain.wallet.signMessage({account: chain.wallet.account!, message: msg})) as Hex

  function persistProgress(p: WorkerProgress): void {
    const status = p.stage === 'acked' ? 'running' : p.stage === 'inferred' ? 'running' : 'delivered'
    db.recordProviderJob({
      jobId: p.jobIdRouting,
      client: p.client,
      modelId: p.modelId,
      status,
      receivedAt: p.timestamp, // overridden by COALESCE on upsert
      ackedAt: p.stage === 'acked' ? p.timestamp : null,
      completedAt: p.stage === 'delivered' ? p.timestamp : null,
      claimedAt: null,
      promptTokens: p.promptTokens ?? null,
      completionTokens: p.completionTokens ?? null,
      earnedXBZZ: null,
      errorMessage: null,
    })
  }

  pss.subscribe({
    topic: providerTopic(chain.address),
    onEnvelope: async env => {
      if (!isJobNotify(env)) return
      if (!queue.tryAcquire()) {
        log.warn({inFlight: queue.inFlight}, 'queue full; dropping notify')
        return
      }
      const jobIdRouting = env.body.jobId
      db.recordProviderJob({
        jobId: jobIdRouting,
        client: env.from,
        modelId: env.body.modelId,
        status: 'queued',
        receivedAt: Math.floor(Date.now() / 1000),
        ackedAt: null,
        completedAt: null,
        claimedAt: null,
        promptTokens: null,
        completionTokens: null,
        earnedXBZZ: null,
        errorMessage: null,
      })
      try {
        await processJob(
          {
            bee,
            postageBatchId: cfg.POSTAGE_BATCH_ID,
            pss,
            ollama,
            cipher,
            selfAddress: chain.address,
            signMessage,
            resolveClient: async clientAddr => {
              const p = await getProvider(chain, clientAddr).catch(() => null)
              if (!p || !p.active) return null
              return {swarmOverlay: p.swarmOverlay, pssPublicKey: p.pssPublicKey}
            },
            onDelivered: async ({jobIdRouting: routing, responseHash, completionTokens}) => {
              const onChainJobId = await waitForOnChainJobId(jobIndex, routing)
              if (!onChainJobId) {
                log.warn({jobIdRouting: routing}, 'no on-chain jobId after wait; skipping claim')
                db.recordProviderJob({
                  jobId: jobIdRouting,
                  client: env.from,
                  modelId: env.body.modelId,
                  status: 'failed',
                  receivedAt: 0,
                  ackedAt: null,
                  completedAt: null,
                  claimedAt: null,
                  promptTokens: null,
                  completionTokens: null,
                  earnedXBZZ: null,
                  errorMessage: 'no on-chain jobId observed before timeout',
                })
                return
              }
              const price = cfg.T4T_PRICE_PER_KTOKEN_DEFAULT
              const actual = (price * BigInt(completionTokens)) / 1000n
              await claimJob(chain, {
                jobId: onChainJobId,
                responseHash: ('0x' + responseHash) as Hex,
                actualPayment: actual,
              })
              log.info({onChainJobId, actual: actual.toString()}, 'claim submitted')
              db.recordProviderJob({
                jobId: jobIdRouting,
                client: env.from,
                modelId: env.body.modelId,
                status: 'claimed',
                receivedAt: 0,
                ackedAt: null,
                completedAt: null,
                claimedAt: Math.floor(Date.now() / 1000),
                promptTokens: null,
                completionTokens: null,
                earnedXBZZ: actual.toString(),
                errorMessage: null,
              })
            },
            onProgress: persistProgress,
            logger: log,
          },
          env,
        )
      } catch (err) {
        log.error({err}, 'job failed')
        db.recordProviderJob({
          jobId: jobIdRouting,
          client: env.from,
          modelId: env.body.modelId,
          status: 'failed',
          receivedAt: 0,
          ackedAt: null,
          completedAt: null,
          claimedAt: null,
          promptTokens: null,
          completionTokens: null,
          earnedXBZZ: null,
          errorMessage: String((err as Error)?.message ?? err),
        })
      } finally {
        queue.release()
      }
    },
  })

  startAdminServer({
    host: cfg.T4T_ADMIN_HOST,
    port: cfg.T4T_ADMIN_PORT,
    statusRefreshSeconds: cfg.T4T_STATUS_REFRESH_SECONDS,
    db,
    chain,
    bee,
    queue,
    logger: log,
  })

  if (cfg.T4T_DEACTIVATE_ON_SHUTDOWN) {
    let shuttingDown = false
    const onSignal = (sig: NodeJS.Signals) => {
      if (shuttingDown) return
      shuttingDown = true
      log.info({sig}, 'signal received — deactivating before exit')
      deactivateProvider(chain)
        .then(tx => log.info({tx}, 'deactivate tx sent'))
        .catch(err => log.error({err}, 'deactivate on shutdown failed'))
        .finally(() => process.exit(0))
    }
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)
  }

  log.info({offerings: offerings.length, concurrency: cfg.T4T_MAX_CONCURRENT_JOBS}, 'provider ready')
}

/**
 * Polls the JobPostedIndex briefly for the routing-id match. The PSS notify
 * may arrive before the chain event, so we give the indexer a short window
 * to catch up rather than dropping the claim outright.
 */
async function waitForOnChainJobId(
  index: JobPostedIndex,
  routingId: Hex,
  timeoutMs = 15_000,
  pollMs = 500,
): Promise<Hex | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = index.get(routingId)
    if (hit) return hit
    await new Promise(r => setTimeout(r, pollMs))
  }
  return null
}

