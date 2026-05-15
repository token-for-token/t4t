import {Bee} from '@ethersphere/bee-js'
import {join} from 'node:path'
import type {ProviderConfig} from '../../lib/config'
import {walletKeyFilePath} from '../../lib/config'
import {startOnboardingServer, isZeroAddress} from '../../lib/onboarding'
import {discoverUsableBatchId} from '../../lib/swarm'
import {privateKeyToAccount} from 'viem/accounts'
import {
  claimJob,
  deactivateProvider,
  getOfferings,
  getProvider,
  makeChain,
  readMinStake,
  readXbzzBalance,
  registerProvider,
  sendHeartbeat,
  updateOfferings,
  ensureAllowance,
} from '../../lib/chain'
import {logger} from '../../lib/logger'
import {PssTransport} from '../../lib/swarm'
import {providerTopic} from '../../lib/envelope'
import {EciesCipher} from '../../lib/crypto'
import {JobPostedIndex} from '../../lib/job-index'
import {JobsDb} from '../../lib/jobs-db'
import {InferenceClient} from '../../lib/inference'
import {loadOrCreatePssKey} from '../../lib/keys'
import type {Hex, ModelOffering} from '../../lib/types'
import {startAdminServer} from './admin'
import {processJob, type WorkerProgress} from './worker'
import {JobQueue, isJobNotify} from './listener'

// xBZZ has 16 decimals on Gnosis (NOT 18). MIN_STAKE in ProviderRegistry is
// `100 * 1e16` — 100 BZZ. Mismatch here used to silently produce a 10,000-BZZ
// stake request that crashed the container on transferFrom.
const PROVIDER_INITIAL_STAKE = 100n * 10n ** 16n // 100 xBZZ

export async function startProvider(cfg: ProviderConfig): Promise<void> {
  const log = logger.child({mode: 'provider'})

  // Onboarding-only mode covers two pre-flight states:
  //   1) no wallet yet → show create/import UI
  //   2) wallet exists but protocol addresses are still placeholder zeros →
  //      show "configure addresses" UI (won't try chain calls and crash-loop).
  const contractsMissing =
    isZeroAddress(cfg.REGISTRY_ADDRESS) ||
    isZeroAddress(cfg.ESCROW_ADDRESS) ||
    isZeroAddress(cfg.XBZZ_ADDRESS)
  const onboardingBase = {
    role: 'provider' as const,
    host: cfg.T4T_ADMIN_HOST,
    port: cfg.T4T_ADMIN_PORT,
    walletFilePath: walletKeyFilePath(cfg.T4T_DATA_DIR),
    existingAddress: cfg.walletKey ? privateKeyToAccount(cfg.walletKey).address : null,
    protocol: {registry: cfg.REGISTRY_ADDRESS, escrow: cfg.ESCROW_ADDRESS, xbzz: cfg.XBZZ_ADDRESS},
    logger: log,
  }
  if (!cfg.walletKey || contractsMissing) {
    startOnboardingServer(onboardingBase)
    return
  }

  const bee = new Bee(cfg.BEE_API_URL)

  // Resolve postage batch — env override wins, otherwise ask the Bee node for
  // a usable batch it already owns. No usable batch = onboarding (phase 3).
  const resolved = cfg.POSTAGE_BATCH_ID ?? (await discoverUsableBatchId(bee).catch(() => null))
  if (!resolved) {
    log.warn({beeUrl: cfg.BEE_API_URL}, 'no usable postage batch on Bee node — entering onboarding')
    startOnboardingServer({
      ...onboardingBase,
      stamp: {missing: true, beeUrl: cfg.BEE_API_URL},
      recheck: async () => (await discoverUsableBatchId(bee).catch(() => null)) !== null,
    })
    return
  }
  const postageBatchId: string = resolved
  log.info({postageBatchId, source: cfg.POSTAGE_BATCH_ID ? 'env' : 'bee'}, 'postage batch resolved')

  const chain = makeChain({
    rpcUrl: cfg.GNOSIS_RPC_URL,
    privateKey: cfg.walletKey,
    registry: cfg.REGISTRY_ADDRESS,
    escrow: cfg.ESCROW_ADDRESS,
    xbzz: cfg.XBZZ_ADDRESS,
  })

  // Open the db here (before any chain write) so register/allowance/heartbeat
  // txs all flow into the `transactions` table.
  const db = new JobsDb({path: join(cfg.T4T_DATA_DIR, 'jobs.db')})
  chain.onTx = e => db.recordTx({hash: e.hash, kind: e.kind, fromAddress: chain.address, toAddress: e.toAddress, note: e.note ?? null})

  const pssKeyPath = cfg.T4T_PSS_KEY_PATH ?? join(cfg.T4T_DATA_DIR, 'pss.key')
  const pssKeys = loadOrCreatePssKey(pssKeyPath)
  log.info({pssKeyPath, pssPubKeyX: pssKeys.publicKeyX}, 'PSS keypair loaded')

  // First-run register. Idempotent: we read state, then write if missing.
  const existing = await getProvider(chain, chain.address)
  if (!existing.owner || existing.owner === '0x0000000000000000000000000000000000000000') {
    // Pre-flight balance check — we'd otherwise crash on transferFrom with an
    // opaque revert. The contract's MIN_STAKE is the source of truth so we read
    // it instead of trusting our local constant.
    const minStake = await readMinStake(chain).catch(() => PROVIDER_INITIAL_STAKE)
    const balance = await readXbzzBalance(chain, chain.address).catch(() => 0n)
    if (balance < minStake) {
      log.warn(
        {address: chain.address, balance: balance.toString(), required: minStake.toString()},
        'wallet under-funded for provider registration — entering onboarding',
      )
      startOnboardingServer({
        ...onboardingBase,
        funding: {required: minStake, current: balance},
        // Auto-restart once the wallet is funded — no manual `docker compose restart`.
        recheck: async () => (await readXbzzBalance(chain, chain.address)) >= minStake,
      })
      return
    }
    await ensureAllowance(chain, cfg.REGISTRY_ADDRESS, PROVIDER_INITIAL_STAKE)
    const overlay = (await bee.getNodeAddresses().catch(() => null))?.overlay ?? '0x' + '00'.repeat(32)
    await registerProvider(chain, {
      pssPublicKey: pssKeys.publicKeyX,
      swarmOverlay: ('0x' + overlay.toString().replace(/^0x/, '')) as Hex,
      metadataURI: '',
      initialStake: PROVIDER_INITIAL_STAKE,
    })
    log.info('registered on-chain')
  } else if (existing.pssPublicKey.toLowerCase() !== pssKeys.publicKeyX.toLowerCase()) {
    // The registry has a different PSS pubkey than what we just loaded from
    // disk. Clients fetch the on-chain key to encrypt requests, so they will
    // encrypt to a key we cannot decrypt — every incoming job will fail until
    // this is fixed (either deactivate + re-register, or restore the original
    // key file from backup). Log loudly and continue so the operator can act.
    log.error(
      {onChain: existing.pssPublicKey, local: pssKeys.publicKeyX},
      'on-chain PSS pubkey differs from local key file — incoming jobs will be undecryptable',
    )
  }

  const inference = new InferenceClient(cfg.OPENAI_BASE_URL, cfg.OPENAI_API_KEY)
  // Offerings = whatever the backend currently serves. To stop offering a model,
  // remove it from the backend (e.g. `ollama rm <model>`) and restart.
  const modelIds = await inference.listModels().catch(err => {
    log.fatal({err, backend: cfg.OPENAI_BASE_URL}, 'inference backend unreachable; cannot determine offerings')
    process.exit(1)
  })
  // Merge: preserve any on-chain price the operator has set previously
  // (e.g. edited via the admin UI). Only newly-seen models get env defaults.
  const onChainOfferings = await getOfferings(chain, chain.address).catch(() => [] as ModelOffering[])
  const existingByModel = new Map(onChainOfferings.map(o => [o.modelId, o]))
  const offeringsByModel = new Map<string, ModelOffering>()
  for (const modelId of modelIds) {
    const prior = existingByModel.get(modelId)
    offeringsByModel.set(modelId, {
      modelId,
      inputPricePerMillionTokens: prior?.inputPricePerMillionTokens ?? cfg.T4T_INPUT_PRICE_DEFAULT,
      outputPricePerMillionTokens: prior?.outputPricePerMillionTokens ?? cfg.T4T_OUTPUT_PRICE_DEFAULT,
      maxContextTokens: prior?.maxContextTokens ?? 0n,
      maxLatencySeconds: prior?.maxLatencySeconds ?? 120n,
    })
  }

  async function publishOfferings(): Promise<void> {
    const arr = [...offeringsByModel.values()]
    if (arr.length === 0) {
      log.warn({backend: cfg.OPENAI_BASE_URL}, 'backend reports zero models — provider will not receive jobs until at least one model is loaded')
      return
    }
    await updateOfferings(chain, arr)
    log.info({count: arr.length, models: arr.map(o => o.modelId)}, 'offerings published')
  }

  // Publish only if the merged set differs from on-chain — avoids gas on a noop restart.
  const sameAsChain =
    onChainOfferings.length === offeringsByModel.size &&
    onChainOfferings.every(o => {
      const cur = offeringsByModel.get(o.modelId)
      return (
        cur &&
        cur.inputPricePerMillionTokens === o.inputPricePerMillionTokens &&
        cur.outputPricePerMillionTokens === o.outputPricePerMillionTokens
      )
    })
  if (!sameAsChain) await publishOfferings()
  else log.info({count: offeringsByModel.size}, 'offerings already match on-chain; skip publish')

  function buildOffering(modelId: string): ModelOffering {
    const prior = offeringsByModel.get(modelId) ?? existingByModel.get(modelId)
    return {
      modelId,
      inputPricePerMillionTokens: prior?.inputPricePerMillionTokens ?? cfg.T4T_INPUT_PRICE_DEFAULT,
      outputPricePerMillionTokens: prior?.outputPricePerMillionTokens ?? cfg.T4T_OUTPUT_PRICE_DEFAULT,
      maxContextTokens: prior?.maxContextTokens ?? 0n,
      maxLatencySeconds: prior?.maxLatencySeconds ?? 120n,
    }
  }

  function offeringsDiffer(next: Map<string, ModelOffering>): boolean {
    if (next.size !== offeringsByModel.size) return true
    for (const [id, n] of next) {
      const cur = offeringsByModel.get(id)
      if (!cur) return true
      if (cur.inputPricePerMillionTokens !== n.inputPricePerMillionTokens) return true
      if (cur.outputPricePerMillionTokens !== n.outputPricePerMillionTokens) return true
    }
    return false
  }

  async function healthTick(): Promise<void> {
    // 1. Backend reachable?
    let modelIds: string[]
    try {
      modelIds = await inference.listModels()
    } catch (err) {
      log.warn({err}, 'skip heartbeat — backend listModels failed; on-chain liveness will lapse')
      return
    }

    // 2. Probe each model the backend claims to serve. A model that fails the
    //    probe is dropped from offerings this round; clients won't route to it.
    const live: string[] = []
    for (const id of modelIds) {
      try {
        await inference.probeModel(id)
        live.push(id)
      } catch (err) {
        log.warn({err, model: id}, 'model probe failed; dropping from offerings')
      }
    }
    if (live.length === 0) {
      log.warn('no models survived probe — skip heartbeat')
      return
    }

    // 3. Sync the on-chain offering set with what's actually live.
    const next = new Map<string, ModelOffering>()
    for (const id of live) next.set(id, buildOffering(id))
    if (offeringsDiffer(next)) {
      try {
        await updateOfferings(chain, [...next.values()])
        offeringsByModel.clear()
        for (const [k, v] of next) offeringsByModel.set(k, v)
        log.info({models: [...offeringsByModel.keys()]}, 'offerings re-published after backend change')
      } catch (err) {
        log.warn({err}, 'updateOfferings failed; keeping previous on-chain set')
      }
    }

    // 4. Heartbeat — only now do we tell the chain we're alive.
    try {
      await sendHeartbeat(chain)
    } catch (err) {
      log.warn({err}, 'heartbeat failed')
    }
  }

  // Fire one tick immediately so a newly-started (or just-restarted) provider
  // gets its on-chain liveness refreshed without waiting up to 5 minutes.
  healthTick().catch(err => log.warn({err}, 'initial health tick failed'))
  setInterval(() => {
    healthTick().catch(err => log.warn({err}, 'health tick crashed'))
  }, cfg.T4T_HEARTBEAT_INTERVAL_SECONDS * 1000)

  const cipher = new EciesCipher(pssKeys.privateKey)
  const pss = new PssTransport({
    bee,
    postageBatchId,
    logger: log,
    selfAddress: chain.address,
  })
  const queue = new JobQueue(cfg.T4T_MAX_CONCURRENT_JOBS)
  const jobIndex = new JobPostedIndex(chain, chain.address, log)
  jobIndex.start()
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
            postageBatchId,
            pss,
            inference,
            cipher,
            selfAddress: chain.address,
            signMessage,
            onDelivered: async ({jobIdRouting: routing, responseHash, promptTokens, completionTokens}) => {
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
              const o = offeringsByModel.get(env.body.modelId)
              const inPrice = o?.inputPricePerMillionTokens ?? cfg.T4T_INPUT_PRICE_DEFAULT
              const outPrice = o?.outputPricePerMillionTokens ?? cfg.T4T_OUTPUT_PRICE_DEFAULT
              const actual =
                (inPrice * BigInt(promptTokens) + outPrice * BigInt(completionTokens)) /
                1_000_000n
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
    postageBatchId,
    queue,
    logger: log,
    offerings: offeringsByModel,
    publishOfferings,
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

  log.info({offerings: offeringsByModel.size, concurrency: cfg.T4T_MAX_CONCURRENT_JOBS}, 'provider ready')
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

