import {Bee} from '@ethersphere/bee-js'
import {keccak256, toBytes, toHex} from 'viem'
import {join} from 'node:path'
import type {GatewayConfig} from '../../lib/config'
import {walletKeyFilePath} from '../../lib/config'
import {startOnboardingServer, isZeroAddress} from '../../lib/onboarding'
import {discoverUsableBatchId} from '../../lib/swarm'
import {ensureManagedStamp, topUpIfBelow, type ManagedStamp} from '../../lib/stamps'
import {privateKeyToAccount} from 'viem/accounts'
import {ACK_WINDOW_SECONDS, cancelJob, ensureAllowance, makeChain, postJob, timeoutJob} from '../../lib/chain'
import {ModelDiscovery} from './models'
import {logger} from '../../lib/logger'
import {PssTransport, uploadChunk, downloadChunk} from '../../lib/swarm'
import {signEnvelope, clientTopic, providerTopic} from '../../lib/envelope'
import {EciesCipher, jsonDecrypt, jsonEncrypt} from '../../lib/crypto'
import {JobsDb} from '../../lib/jobs-db'
import {loadOrCreatePssKey} from '../../lib/keys'
import {selectProvider} from './selector'
import {startAdminServer} from './admin'
import type {
  Hex,
  JobAckBody,
  JobDeliverBody,
  JobNotifyBody,
  OpenAIChatRequest,
  OpenAIChatResponse,
  RequestPayload,
  ResponsePayload,
} from '../../lib/types'

const PROTOCOL_VERSION = 1 as const

export async function startGateway(cfg: GatewayConfig): Promise<void> {
  const log = logger.child({mode: 'gateway'})

  // Onboarding-only mode covers two pre-flight states:
  //   1) no wallet yet → show create/import UI
  //   2) wallet exists but protocol addresses are still placeholder zeros →
  //      show "configure addresses" UI (won't try chain calls and crash-loop).
  const contractsMissing =
    isZeroAddress(cfg.REGISTRY_ADDRESS) ||
    isZeroAddress(cfg.ESCROW_ADDRESS) ||
    isZeroAddress(cfg.XBZZ_ADDRESS)
  const onboardingBase = {
    role: 'gateway' as const,
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

  // Resolve postage batch:
  //   1. POSTAGE_BATCH_ID env wins — operator owns the lifecycle, no auto-manage.
  //   2. T4T_STAMP_MANAGE=true → buy or reuse a labelled batch, auto-top-up.
  //   3. Else discover any usable batch the Bee node already has (legacy).
  // No usable batch in any path = onboarding (phase 3).
  let managed: ManagedStamp | null = null
  let resolved: string | null = cfg.POSTAGE_BATCH_ID ?? null
  if (!resolved && cfg.T4T_STAMP_MANAGE) {
    try {
      managed = await ensureManagedStamp({
        bee,
        logger: log,
        opts: {
          depth: cfg.T4T_STAMP_DEPTH,
          ttlDays: cfg.T4T_STAMP_TTL_DAYS,
          minTtlDays: cfg.T4T_STAMP_MIN_TTL_DAYS,
          label: cfg.T4T_STAMP_LABEL,
          dryRun: cfg.T4T_STAMP_DRY_RUN,
        },
      })
      resolved = managed.batchID
    } catch (err) {
      log.error({err}, 'managed stamp ensure failed; falling back to discover')
    }
  }
  if (!resolved) {
    resolved = await discoverUsableBatchId(bee).catch(() => null)
  }
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
  log.info(
    {postageBatchId, source: cfg.POSTAGE_BATCH_ID ? 'env' : managed ? managed.source : 'bee'},
    'postage batch resolved',
  )

  // Container-managed batches get a background TTL-watch on a fixed 5-minute
  // tick (gateway has no heartbeat loop to piggyback on like provider does).
  if (managed && cfg.T4T_STAMP_MANAGE) {
    setInterval(() => {
      topUpIfBelow({
        bee,
        logger: log,
        batchId: postageBatchId,
        ttlDays: cfg.T4T_STAMP_TTL_DAYS,
        minTtlDays: cfg.T4T_STAMP_MIN_TTL_DAYS,
        maxUtilization: cfg.T4T_STAMP_MAX_UTILIZATION,
        maxDepth: cfg.T4T_STAMP_MAX_DEPTH,
        dryRun: cfg.T4T_STAMP_DRY_RUN,
      }).catch(err => log.warn({err}, 'stamp tick failed'))
    }, 300_000).unref()
  }

  const chain = makeChain({
    rpcUrl: cfg.GNOSIS_RPC_URL,
    privateKey: cfg.walletKey,
    registry: cfg.REGISTRY_ADDRESS,
    escrow: cfg.ESCROW_ADDRESS,
    xbzz: cfg.XBZZ_ADDRESS,
  })

  // Open the db here (before any chain write) so postJob/cancelJob/etc.
  // flow into the `transactions` table.
  const db = new JobsDb({path: join(cfg.T4T_DATA_DIR, 'jobs.db')})
  chain.onTx = e => db.recordTx({hash: e.hash, kind: e.kind, fromAddress: chain.address, toAddress: e.toAddress, note: e.note ?? null})

  const pssKeyPath = cfg.T4T_PSS_KEY_PATH ?? join(cfg.T4T_DATA_DIR, 'pss.key')
  const pssKeys = loadOrCreatePssKey(pssKeyPath)
  log.info({pssKeyPath, pssPubKeyX: pssKeys.publicKeyX}, 'PSS keypair loaded')

  // Gateway's own Bee overlay — included in the JobNotify envelope so the
  // provider can PSS-route ACK/deliver back without looking us up on-chain.
  const selfOverlay = ('0x' + (
    ((await bee.getNodeAddresses().catch(() => null))?.overlay?.toString() ?? '00'.repeat(32))
      .replace(/^0x/, '')
  )) as Hex
  const cipher = new EciesCipher(pssKeys.privateKey)
  const pss = new PssTransport({
    bee,
    postageBatchId,
    logger: log,
    selfAddress: chain.address,
  })
  const jobMeta = new Map<string, {provider: string; modelId: string}>()

  if (cfg.T4T_PERSIST_PAYLOADS) {
    setInterval(() => {
      const cutoff = Math.floor(Date.now() / 1000) - cfg.T4T_PAYLOAD_RETENTION_HOURS * 3600
      const redacted = db.redactGatewayPayloadsBefore(cutoff)
      if (redacted > 0) log.info({redacted}, 'expired payloads redacted')
    }, 3600_000)
  }

  // Pending jobs awaiting delivery; resolved on `job_deliver`.
  const pending = new Map<Hex, {resolve: (r: OpenAIChatResponse) => void; reject: (e: unknown) => void}>()

  // Per-job failure timers — schedule on-chain cancel/timeout when the provider
  // fails liveness (spec §3). Both timers use a small grace beyond the on-chain
  // deadline so `block.timestamp > deadline` holds when the tx mines.
  const FAILURE_GRACE_SECONDS = 5
  interface FailureSlot {
    onChainJobId: Hex
    deliveryDeadline: number
    cancelTimer?: NodeJS.Timeout
    timeoutTimer?: NodeJS.Timeout
  }
  const failureTimers = new Map<Hex, FailureSlot>()

  function clearFailureTimers(routing: Hex): void {
    const slot = failureTimers.get(routing)
    if (!slot) return
    if (slot.cancelTimer) clearTimeout(slot.cancelTimer)
    if (slot.timeoutTimer) clearTimeout(slot.timeoutTimer)
    failureTimers.delete(routing)
  }

  function rejectAndCleanup(routing: Hex, err: Error): void {
    pending.get(routing)?.reject(err)
    pending.delete(routing)
    jobMeta.delete(routing)
    clearFailureTimers(routing)
  }

  function persistFailureRow(routing: Hex, status: 'cancelled' | 'timed_out', errorMessage: string): void {
    const meta = jobMeta.get(routing)
    if (!meta) return
    db.recordGatewayJob({
      jobId: routing,
      provider: meta.provider,
      modelId: meta.modelId,
      status,
      maxPayment: '0',
      actualPayment: null,
      postedAt: 0,
      ackedAt: null,
      deliveredAt: null,
      claimedAt: null,
      prompt: null,
      response: null,
      promptTokens: null,
      completionTokens: null,
      errorMessage,
    })
  }

  async function onAckTimeout(routing: Hex): Promise<void> {
    const slot = failureTimers.get(routing)
    if (!slot) return
    try {
      const tx = await cancelJob(chain, slot.onChainJobId)
      log.warn({tx, routing, onChainJobId: slot.onChainJobId}, 'no ACK within window — cancelled on-chain')
      persistFailureRow(routing, 'cancelled', 'no PSS ack within ACK_WINDOW; cancelled on-chain')
      rejectAndCleanup(routing, new Error('provider failed to ACK within window'))
    } catch (err) {
      log.warn({err, routing}, 'cancelJob failed — provider likely acked on-chain mid-flight')
      // Provider may have on-chain-acked between our deadline check and tx — leave the
      // delivery timer to handle the unhappy path if no PSS deliver arrives.
    }
  }

  async function onDeliveryTimeout(routing: Hex): Promise<void> {
    const slot = failureTimers.get(routing)
    if (!slot) return
    // Spec §3: prefer timeoutJob (3× slash). Falls back to cancelJob if the
    // provider PSS-acked but never on-chain-acked — status stays Pending and
    // timeoutJob reverts with BadStatus, but cancelJob still applies.
    try {
      const tx = await timeoutJob(chain, slot.onChainJobId)
      log.warn({tx, routing, onChainJobId: slot.onChainJobId}, 'delivery deadline missed — timed out on-chain')
      persistFailureRow(routing, 'timed_out', 'no PSS delivery before deadline; timeoutJob applied')
      rejectAndCleanup(routing, new Error('provider failed to deliver before deadline'))
      return
    } catch (err) {
      log.warn({err, routing}, 'timeoutJob reverted — falling back to cancelJob')
    }
    try {
      const tx = await cancelJob(chain, slot.onChainJobId)
      log.warn({tx, routing, onChainJobId: slot.onChainJobId}, 'cancelJob fallback applied')
      persistFailureRow(routing, 'cancelled', 'no PSS delivery before deadline; cancelJob fallback applied')
      rejectAndCleanup(routing, new Error('provider failed to deliver before deadline'))
    } catch (err) {
      log.error({err, routing}, 'both timeoutJob and cancelJob failed — job stuck in escrow')
      rejectAndCleanup(routing, new Error('delivery deadline missed; settlement failed'))
    }
  }

  pss.subscribe({
    topic: clientTopic(chain.address),
    onEnvelope: async env => {
      if (env.type === 'job_ack') {
        const body = env.body as JobAckBody
        log.info({jobId: body.jobId, eta: body.estimatedCompletion}, 'ack received')
        const slot = failureTimers.get(body.jobId)
        if (slot) {
          if (slot.cancelTimer) {
            clearTimeout(slot.cancelTimer)
            slot.cancelTimer = undefined
          }
          if (!slot.timeoutTimer) {
            const msUntilTimeout = Math.max(
              0,
              (slot.deliveryDeadline + FAILURE_GRACE_SECONDS) * 1000 - Date.now(),
            )
            slot.timeoutTimer = setTimeout(() => {
              onDeliveryTimeout(body.jobId).catch(err =>
                log.error({err, routing: body.jobId}, 'onDeliveryTimeout threw'),
              )
            }, msUntilTimeout)
          }
        }
        const meta = jobMeta.get(body.jobId)
        if (meta) {
          db.recordGatewayJob({
            jobId: body.jobId,
            provider: meta.provider,
            modelId: meta.modelId,
            status: 'acked',
            maxPayment: '0', // overridden by COALESCE
            actualPayment: null,
            postedAt: 0,
            ackedAt: Math.floor(Date.now() / 1000),
            deliveredAt: null,
            claimedAt: null,
            prompt: null,
            response: null,
            promptTokens: null,
            completionTokens: null,
            errorMessage: null,
          })
        }
      } else if (env.type === 'job_deliver') {
        const body = env.body as JobDeliverBody
        const slot = pending.get(body.jobId)
        if (!slot) return
        try {
          const bytes = await downloadChunk({bee, postageBatchId, logger: log}, body.responseHash)
          const payload = await jsonDecrypt<ResponsePayload>(cipher, bytes)
          const meta = jobMeta.get(body.jobId)
          if (meta) {
            const content = payload.openaiResponse.choices[0]?.message.content ?? ''
            db.recordGatewayJob({
              jobId: body.jobId,
              provider: meta.provider,
              modelId: meta.modelId,
              status: 'delivered',
              maxPayment: '0',
              actualPayment: null,
              postedAt: 0,
              ackedAt: null,
              deliveredAt: Math.floor(Date.now() / 1000),
              claimedAt: null,
              prompt: null,
              response: cfg.T4T_PERSIST_PAYLOADS ? content : '[redacted]',
              promptTokens: payload.openaiResponse.usage?.prompt_tokens ?? null,
              completionTokens: payload.openaiResponse.usage?.completion_tokens ?? null,
              errorMessage: null,
            })
          }
          slot.resolve(payload.openaiResponse)
        } catch (err) {
          slot.reject(err)
        } finally {
          pending.delete(body.jobId)
          jobMeta.delete(body.jobId)
          clearFailureTimers(body.jobId)
        }
      }
    },
  })

  async function handleChat(req: OpenAIChatRequest): Promise<OpenAIChatResponse> {
    const target = await selectProvider(chain, cfg.T4T_SELECTION_STRATEGY, {
      modelId: req.model,
      maxPrice: cfg.T4T_MAX_PRICE_PER_MILLION_TOKENS,
      manualProvider: cfg.T4T_MANUAL_PROVIDER,
    })
    if (!target) throw new Error(`no provider matches model=${req.model}`)

    // Conservative ceiling: assume prompt tokens ≈ max_tokens (most prompts are
    // shorter, this overshoots safely) and budget at the full split rate, plus
    // one million-tokens worth of headroom on each side to absorb usage drift.
    // The provider only claims the actual amount; the contract refunds the rest.
    const maxTokens = BigInt(req.max_tokens ?? 1024)
    const headroom = 1_000_000n
    const inPay = target.offering.inputPricePerMillionTokens * (maxTokens + headroom)
    const outPay = target.offering.outputPricePerMillionTokens * (maxTokens + headroom)
    const maxPayment = (inPay + outPay) / 1_000_000n
    await ensureAllowance(chain, cfg.ESCROW_ADDRESS, maxPayment)

    const jobIdLocal = toHex(crypto.getRandomValues(new Uint8Array(32)))

    const reqPayload: RequestPayload = {
      v: PROTOCOL_VERSION,
      jobId: jobIdLocal,
      client: chain.address,
      modelId: req.model,
      openaiRequest: req,
      clientPssPubKey: pssKeys.publicKeyX,
      ts: Math.floor(Date.now() / 1000),
    }
    const encrypted = await jsonEncrypt(cipher, target.provider.pssPublicKey, reqPayload)
    const requestHash = await uploadChunk(
      {bee, postageBatchId, logger: log},
      encrypted,
    )

    const deliveryDeadline = Math.floor(Date.now() / 1000) + cfg.T4T_DEFAULT_DEADLINE_SECONDS
    const {txHash, jobId: onChainJobId} = await postJob(chain, {
      provider: target.provider.owner,
      requestHash: ('0x' + requestHash) as Hex,
      modelId: req.model,
      maxPayment,
      deliveryDeadline,
    })
    log.info({txHash, onChainJobId, provider: target.provider.owner}, 'job posted on-chain')

    // The PSS notify carries `requestHash`-derived id; the provider matches
    // it to the chain via its JobPostedIndex. We keep the on-chain id alongside
    // so we can call cancelJob/timeoutJob on liveness failure.
    const jobIdRouting = keccak256(toBytes('0x' + requestHash))

    const promptText = req.messages.map(m => `${m.role}: ${m.content}`).join('\n')
    db.recordGatewayJob({
      jobId: jobIdRouting,
      provider: target.provider.owner,
      modelId: req.model,
      status: 'posted',
      maxPayment: maxPayment.toString(),
      actualPayment: null,
      postedAt: Math.floor(Date.now() / 1000),
      ackedAt: null,
      deliveredAt: null,
      claimedAt: null,
      prompt: cfg.T4T_PERSIST_PAYLOADS ? promptText : '[redacted]',
      response: null,
      promptTokens: null,
      completionTokens: null,
      errorMessage: null,
    })
    jobMeta.set(jobIdRouting, {provider: target.provider.owner, modelId: req.model})

    const settled = new Promise<OpenAIChatResponse>((resolve, reject) => {
      pending.set(jobIdRouting, {resolve, reject})
    })

    const cancelTimer = setTimeout(() => {
      onAckTimeout(jobIdRouting).catch(err =>
        log.error({err, routing: jobIdRouting}, 'onAckTimeout threw'),
      )
    }, (ACK_WINDOW_SECONDS + FAILURE_GRACE_SECONDS) * 1000)
    failureTimers.set(jobIdRouting, {onChainJobId, deliveryDeadline, cancelTimer})

    // Out-of-band notify so providers can start work before they observe the
    // chain event. The on-chain `JobPosted` is the source of truth for payment.
    const env = await signEnvelope<JobNotifyBody>(
      {
        from: chain.address,
        to: target.provider.owner,
        type: 'job_notify',
        body: {
          jobId: jobIdRouting,
          requestHash,
          modelId: req.model,
          maxPayment: maxPayment.toString(),
          deliveryDeadline,
          clientPssPubKey: pssKeys.publicKeyX,
          clientSwarmOverlay: selfOverlay,
        },
      },
      msg => chain.wallet.signMessage({account: chain.wallet.account!, message: msg}),
    )
    try {
      await pss.send({
        topic: providerTopic(target.provider.owner),
        recipientOverlay: target.provider.swarmOverlay,
        recipientPssKey: target.provider.pssPublicKey,
        envelope: env,
      })
    } catch (err) {
      // If we never managed to PSS-notify the provider, the orphaned `settled`
      // promise would later be rejected by the ACK-timeout timer and crash the
      // process (unhandledRejection). Drop the pending state synchronously so
      // the timer becomes a no-op, then surface the error to the HTTP layer.
      pending.delete(jobIdRouting)
      jobMeta.delete(jobIdRouting)
      clearFailureTimers(jobIdRouting)
      throw err
    }

    return settled
  }

  const discovery = new ModelDiscovery({
    chain,
    allowedModels: cfg.T4T_ALLOWED_MODELS,
    minProvidersPerModel: cfg.T4T_MIN_PROVIDERS_PER_MODEL,
    cacheTtlSeconds: cfg.T4T_MODELS_CACHE_TTL_SECONDS,
  })

  async function listModels() {
    const summaries = await discovery.list()
    const created = Math.floor(Date.now() / 1000)
    return summaries.map(m => ({id: m.id, object: 'model' as const, created, owned_by: 't4t'}))
  }

  startAdminServer({
    host: cfg.T4T_ADMIN_HOST,
    port: cfg.T4T_ADMIN_PORT,
    statusRefreshSeconds: cfg.T4T_STATUS_REFRESH_SECONDS,
    payloadsPersisted: cfg.T4T_PERSIST_PAYLOADS,
    fakeStreaming: cfg.T4T_FAKE_STREAMING,
    handleChat,
    listModels,
    db,
    chain,
    bee,
    postageBatchId,
    stampManaged: managed !== null && cfg.T4T_STAMP_MANAGE,
    stampDryRun: cfg.T4T_STAMP_DRY_RUN,
    stampTtlDays: cfg.T4T_STAMP_TTL_DAYS,
    discovery,
    pendingCount: () => pending.size,
    logger: log,
  })
}
