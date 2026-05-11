import {Bee} from '@ethersphere/bee-js'
import {keccak256, toBytes, toHex} from 'viem'
import type {ClientConfig} from '../../lib/config'
import {ensureAllowance, makeChain, postJob, listProviders, getOfferings} from '../../lib/chain'
import {logger} from '../../lib/logger'
import {PssTransport, uploadChunk, downloadChunk} from '../../lib/swarm'
import {signEnvelope, clientTopic, providerTopic} from '../../lib/envelope'
import {jsonDecrypt, jsonEncrypt, PassthroughCipher} from '../../lib/crypto'
import {selectProvider} from './selector'
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

  const cipher = new PassthroughCipher()
  const pss = new PssTransport({
    bee,
    postageBatchId: cfg.POSTAGE_BATCH_ID,
    logger: log,
    selfAddress: chain.address,
  })

  // Pending jobs awaiting delivery; resolved on `job_deliver`.
  const pending = new Map<Hex, {resolve: (r: OpenAIChatResponse) => void; reject: (e: unknown) => void}>()

  pss.subscribe({
    topic: clientTopic(chain.address),
    onEnvelope: async env => {
      if (env.type === 'job_ack') {
        const body = env.body as JobAckBody
        log.info({jobId: body.jobId, eta: body.estimatedCompletion}, 'ack received')
      } else if (env.type === 'job_deliver') {
        const body = env.body as JobDeliverBody
        const slot = pending.get(body.jobId)
        if (!slot) return
        try {
          const bytes = await downloadChunk({bee, postageBatchId: cfg.POSTAGE_BATCH_ID, logger: log}, body.responseHash)
          const payload = await jsonDecrypt<ResponsePayload>(cipher, chain.address, bytes)
          slot.resolve(payload.openaiResponse)
        } catch (err) {
          slot.reject(err)
        } finally {
          pending.delete(body.jobId)
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
      clientPssPubKey: chain.address, // TODO: separate PSS pub key once ECIES wired
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

  async function listModels() {
    const seen = new Set<string>()
    let cursor = 0n
    while (true) {
      const {page, nextCursor} = await listProviders(chain, cursor, 50n)
      for (const p of page) {
        if (!p.active) continue
        const offerings = await getOfferings(chain, p.owner)
        for (const o of offerings) seen.add(o.modelId)
      }
      if (nextCursor === cursor || page.length === 0) break
      cursor = nextCursor
    }
    const created = Math.floor(Date.now() / 1000)
    return [...seen].map(id => ({id, object: 'model' as const, created, owned_by: 't4t'}))
  }

  startClientServer({
    logger: log,
    port: cfg.T4T_HTTP_PORT,
    fakeStreaming: cfg.T4T_FAKE_STREAMING,
    handleChat,
    listModels,
  })
}
