import {Bee} from '@ethersphere/bee-js'
import {keccak256, toBytes, toHex} from 'viem'
import {join} from 'node:path'
import type {ClientConfig} from '../../lib/config'
import {ensureAllowance, makeChain, postJob} from '../../lib/chain'
import {ModelDiscovery} from './models'
import {logger} from '../../lib/logger'
import {PssTransport, uploadChunk, downloadChunk} from '../../lib/swarm'
import {signEnvelope, clientTopic, providerTopic} from '../../lib/envelope'
import {EciesCipher, jsonDecrypt, jsonEncrypt} from '../../lib/crypto'
import {JobsDb} from '../../lib/jobs-db'
import {derivePssKeypair} from '../../lib/keys'
import {selectProvider} from './selector'
import {startAdminServer} from './admin'
import {startClientServer} from './server'
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

export async function runClient(cfg: ClientConfig): Promise<void> {
  const log = logger.child({mode: 'client'})
  const bee = new Bee(cfg.BEE_API_URL)
  const chain = makeChain({
    rpcUrl: cfg.GNOSIS_RPC_URL,
    privateKey: cfg.walletKey,
    registry: cfg.REGISTRY_ADDRESS,
    escrow: cfg.ESCROW_ADDRESS,
    xbzz: cfg.XBZZ_ADDRESS,
  })

  const pssKeys = derivePssKeypair(cfg.walletKey)
  const cipher = new EciesCipher(pssKeys.privateKey)
  const pss = new PssTransport({
    bee,
    postageBatchId: cfg.POSTAGE_BATCH_ID,
    logger: log,
    selfAddress: chain.address,
  })
  const db = new JobsDb({path: join(cfg.T4T_DATA_DIR, 'jobs.db')})
  const jobMeta = new Map<string, {provider: string; modelId: string}>()

  if (cfg.T4T_PERSIST_PAYLOADS) {
    setInterval(() => {
      const cutoff = Math.floor(Date.now() / 1000) - cfg.T4T_PAYLOAD_RETENTION_HOURS * 3600
      const redacted = db.redactClientPayloadsBefore(cutoff)
      if (redacted > 0) log.info({redacted}, 'expired payloads redacted')
    }, 3600_000)
  }

  // Pending jobs awaiting delivery; resolved on `job_deliver`.
  const pending = new Map<Hex, {resolve: (r: OpenAIChatResponse) => void; reject: (e: unknown) => void}>()

  pss.subscribe({
    topic: clientTopic(chain.address),
    onEnvelope: async env => {
      if (env.type === 'job_ack') {
        const body = env.body as JobAckBody
        log.info({jobId: body.jobId, eta: body.estimatedCompletion}, 'ack received')
        const meta = jobMeta.get(body.jobId)
        if (meta) {
          db.recordClientJob({
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
          const bytes = await downloadChunk({bee, postageBatchId: cfg.POSTAGE_BATCH_ID, logger: log}, body.responseHash)
          const payload = await jsonDecrypt<ResponsePayload>(cipher, bytes)
          const meta = jobMeta.get(body.jobId)
          if (meta) {
            const content = payload.openaiResponse.choices[0]?.message.content ?? ''
            db.recordClientJob({
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
        }
      }
    },
  })

  async function handleChat(req: OpenAIChatRequest): Promise<OpenAIChatResponse> {
    const target = await selectProvider(chain, cfg.T4T_SELECTION_STRATEGY, {
      modelId: req.model,
      maxPrice: cfg.T4T_MAX_PRICE_PER_KTOKEN,
      manualProvider: cfg.T4T_MANUAL_PROVIDER,
    })
    if (!target) throw new Error(`no provider matches model=${req.model}`)

    // Conservative ceiling: maxPrice × (max_tokens/1000), round up by one
    // unit to absorb usage drift. Real apps should tune this per workload.
    const maxTokens = BigInt(req.max_tokens ?? 1024)
    const maxPayment = (target.offering.pricePerKToken * (maxTokens + 1000n)) / 1000n
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
      {bee, postageBatchId: cfg.POSTAGE_BATCH_ID, logger: log},
      encrypted,
    )

    const deliveryDeadline = Math.floor(Date.now() / 1000) + cfg.T4T_DEFAULT_DEADLINE_SECONDS
    const txHash = await postJob(chain, {
      provider: target.provider.owner,
      requestHash: ('0x' + requestHash) as Hex,
      modelId: req.model,
      maxPayment,
      deliveryDeadline,
    })
    log.info({txHash, provider: target.provider.owner}, 'job posted on-chain')

    // Use the request-hash-derived ID for in-memory routing while we wait
    // for the on-chain jobId via event indexing in a future iteration.
    const jobIdRouting = keccak256(toBytes('0x' + requestHash))

    const promptText = req.messages.map(m => `${m.role}: ${m.content}`).join('\n')
    db.recordClientJob({
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
        },
      },
      msg => chain.wallet.signMessage({account: chain.wallet.account!, message: msg}),
    )
    await pss.send({
      topic: providerTopic(target.provider.owner),
      recipientOverlay: target.provider.swarmOverlay,
      recipientPssKey: target.provider.pssPublicKey,
      envelope: env,
    })

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

  startClientServer({
    logger: log,
    port: cfg.T4T_HTTP_PORT,
    fakeStreaming: cfg.T4T_FAKE_STREAMING,
    handleChat,
    listModels,
  })

  startAdminServer({
    host: cfg.T4T_ADMIN_HOST,
    port: cfg.T4T_ADMIN_PORT,
    statusRefreshSeconds: cfg.T4T_STATUS_REFRESH_SECONDS,
    payloadsPersisted: cfg.T4T_PERSIST_PAYLOADS,
    db,
    chain,
    bee,
    discovery,
    pendingCount: () => pending.size,
    logger: log,
  })
}
