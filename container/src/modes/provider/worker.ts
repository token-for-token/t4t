import {keccak256, toBytes} from 'viem'
import {jsonDecrypt, jsonEncrypt, type PayloadCipher} from '../../lib/crypto'
import type {Logger} from '../../lib/logger'
import {OllamaClient} from '../../lib/ollama'
import type {PssTransport} from '../../lib/swarm'
import {downloadChunk, uploadChunk} from '../../lib/swarm'
import type {Bee} from '@ethersphere/bee-js'
import type {
  Hex,
  JobAckBody,
  JobDeliverBody,
  JobNotifyBody,
  RequestPayload,
  ResponsePayload,
} from '../../lib/types'
import {clientTopic, signEnvelope} from '../../lib/envelope'
import type {Envelope} from '../../lib/types'

export interface WorkerDeps {
  bee: Bee
  postageBatchId: string
  pss: PssTransport
  ollama: OllamaClient
  cipher: PayloadCipher
  selfAddress: Hex
  signMessage: (msg: string) => Promise<Hex>
  /** Looked up from the on-chain registry by the listener. */
  resolveClient: (
    client: Hex,
  ) => Promise<{swarmOverlay: Hex; pssPublicKey: Hex} | null>
  /** Called once the response is uploaded so the listener can submit claimJob. */
  onDelivered: (args: {jobIdRouting: Hex; responseHash: string; completionTokens: number}) => Promise<void>
  logger: Logger
}

const PROTOCOL_VERSION = 1 as const

/** Execute a single job end-to-end: fetch → infer → upload → notify. */
export async function processJob(deps: WorkerDeps, notify: Envelope<JobNotifyBody>): Promise<void> {
  const {body} = notify
  const log = deps.logger.child({jobId: body.jobId, model: body.modelId})

  // 1. ACK fast so the client doesn't tip into the no-ack slash path.
  const ackEnv = await signEnvelope<JobAckBody>(
    {
      from: deps.selfAddress,
      to: notify.from,
      type: 'job_ack',
      body: {jobId: body.jobId, estimatedCompletion: Math.floor(Date.now() / 1000) + 60},
    },
    deps.signMessage,
  )
  const clientPeer = await deps.resolveClient(notify.from)
  if (!clientPeer) throw new Error(`client ${notify.from} not in registry`)
  await deps.pss.send({
    topic: clientTopic(notify.from),
    recipientOverlay: clientPeer.swarmOverlay,
    recipientPssKey: clientPeer.pssPublicKey,
    envelope: ackEnv,
  })
  log.info('acked')

  // 2. Fetch + decrypt request.
  const ct = await downloadChunk({bee: deps.bee, postageBatchId: deps.postageBatchId, logger: log}, body.requestHash)
  const reqPayload = await jsonDecrypt<RequestPayload>(deps.cipher, deps.selfAddress, ct)
  if (reqPayload.openaiRequest.model !== body.modelId) {
    throw new Error(`model mismatch: envelope=${body.modelId} payload=${reqPayload.openaiRequest.model}`)
  }

  // 3. Run inference.
  const openaiResponse = await deps.ollama.chatCompletion(reqPayload.openaiRequest)
  log.info({completionTokens: openaiResponse.usage?.completion_tokens}, 'inference complete')

  // 4. Upload encrypted response.
  const respPayload: ResponsePayload = {
    v: PROTOCOL_VERSION,
    jobId: body.jobId,
    provider: deps.selfAddress,
    openaiResponse,
    ts: Math.floor(Date.now() / 1000),
  }
  const respCipher = await jsonEncrypt(deps.cipher, clientPeer.pssPublicKey, respPayload)
  const responseHash = await uploadChunk({bee: deps.bee, postageBatchId: deps.postageBatchId, logger: log}, respCipher)

  // 5. Notify client via PSS.
  const deliverEnv = await signEnvelope<JobDeliverBody>(
    {
      from: deps.selfAddress,
      to: notify.from,
      type: 'job_deliver',
      body: {jobId: body.jobId, responseHash},
    },
    deps.signMessage,
  )
  await deps.pss.send({
    topic: clientTopic(notify.from),
    recipientOverlay: clientPeer.swarmOverlay,
    recipientPssKey: clientPeer.pssPublicKey,
    envelope: deliverEnv,
  })
  log.info({responseHash}, 'delivered')

  // 6. Hand back to the listener for on-chain claim.
  const jobIdRouting = keccak256(toBytes('0x' + body.requestHash))
  await deps.onDelivered({
    jobIdRouting,
    responseHash,
    completionTokens: openaiResponse.usage?.completion_tokens ?? 0,
  })
}
