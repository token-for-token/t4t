import {Bee} from '@ethersphere/bee-js'
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
import {OllamaClient} from '../../lib/ollama'
import type {Hex, ModelOffering} from '../../lib/types'
import {processJob} from './worker'
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
      pssPublicKey: ('0x' + '00'.repeat(32)) as Hex, // TODO: derive from Bee or wallet
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
  const signMessage = async (msg: string) =>
    (await chain.wallet.signMessage({account: chain.wallet.account!, message: msg})) as Hex

  pss.subscribe({
    topic: providerTopic(chain.address),
    onEnvelope: async env => {
      if (!isJobNotify(env)) return
      if (!queue.tryAcquire()) {
        log.warn({inFlight: queue.inFlight}, 'queue full; dropping notify')
        return
      }
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
            onDelivered: async ({responseHash, completionTokens}) => {
              const onChainJobId = await resolveOnChainJobId(env.body.jobId)
              if (!onChainJobId) {
                log.warn('no on-chain jobId; skipping claim')
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
            },
            logger: log,
          },
          env,
        )
      } catch (err) {
        log.error({err}, 'job failed')
      } finally {
        queue.release()
      }
    },
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
 * Resolve the routing jobId (derived from requestHash) to the on-chain jobId
 * emitted by JobEscrow. v1 stub: index `JobPosted` events. Implementation
 * deferred — wire `pub.watchContractEvent` and a small map here.
 */
async function resolveOnChainJobId(_routingId: Hex): Promise<Hex | null> {
  // TODO: maintain a JobPosted event index keyed by requestHash, surface
  // the on-chain jobId here. Without it, claimJob can't be called.
  return null
}

