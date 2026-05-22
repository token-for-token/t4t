import type {Hex} from 'viem'

export type {Hex}

export const PROTOCOL_VERSION = 1 as const

export type EnvelopeType = 'job_notify' | 'job_ack' | 'job_deliver'

export interface UnsignedEnvelope<TBody = unknown> {
  v: typeof PROTOCOL_VERSION
  type: EnvelopeType
  from: Hex
  to: Hex
  ts: number
  nonce: Hex
  body: TBody
}

export interface Envelope<TBody = unknown> extends UnsignedEnvelope<TBody> {
  sig: Hex
}

// ---------- Body payloads (spec §5.3) ----------

export interface JobNotifyBody {
  jobId: Hex
  requestHash: string
  modelId: string
  /** xBZZ wei as a base-10 string to survive JSON. */
  maxPayment: string
  deliveryDeadline: number
  /** Gateway's PSS pubkey (32-byte X coord, even-Y by convention).
   *  Required so the provider can encrypt the ACK/deliver back without
   *  looking up the gateway's address in the on-chain registry (gateways
   *  aren't registered there). */
  clientPssPubKey: Hex
  /** Gateway's Bee overlay for PSS routing. */
  clientSwarmOverlay: Hex
}

export interface JobAckBody {
  jobId: Hex
  estimatedCompletion: number
}

export interface JobDeliverBody {
  jobId: Hex
  responseHash: string
}

// ---------- On-chain mirror types ----------

export interface ProviderRow {
  owner: Hex
  pssPublicKey: Hex
  swarmOverlay: Hex
  metadataURI: string
  stake: bigint
  lastHeartbeat: number
  totalJobs: number
  successfulJobs: number
  active: boolean
}

export interface ModelOffering {
  modelId: string
  inputPricePerMillionTokens: bigint
  outputPricePerMillionTokens: bigint
  maxContextTokens: bigint
  maxLatencySeconds: bigint
}

// ---------- Swarm payload (spec §6) ----------

export interface OpenAIChatRequest {
  model: string
  messages: Array<{role: 'system' | 'user' | 'assistant' | 'tool'; content: string}>
  temperature?: number
  max_tokens?: number
  stream?: boolean
  [k: string]: unknown
}

export interface OpenAIChatResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: {role: 'assistant'; content: string}
    finish_reason: string
  }>
  usage?: {prompt_tokens: number; completion_tokens: number; total_tokens: number}
}

export interface RequestPayload {
  v: typeof PROTOCOL_VERSION
  jobId: Hex
  client: Hex
  modelId: string
  openaiRequest: OpenAIChatRequest
  clientPssPubKey: Hex
  ts: number
}

export interface ResponsePayload {
  v: typeof PROTOCOL_VERSION
  jobId: Hex
  provider: Hex
  openaiResponse: OpenAIChatResponse
  ts: number
}

/** Lifecycle events emitted by the gateway while servicing a chat request.
 *  Surfaced to the SSE stream so clients (Open WebUI, agents) get continuous
 *  feedback instead of an idle socket that may exceed their read timeout. */
export type ProgressEvent =
  | {kind: 'selecting_provider'; modelId: string}
  | {kind: 'provider_selected'; provider: Hex; modelId: string}
  | {kind: 'posting_job'; provider: Hex; maxPayment: string}
  | {kind: 'job_posted'; txHash: Hex; onChainJobId: Hex}
  | {kind: 'notifying_provider'; provider: Hex}
  | {kind: 'provider_acked'; estimatedCompletion: number}
  | {kind: 'awaiting_delivery'}
  | {kind: 'delivered'; promptTokens: number | null; completionTokens: number | null}

export type SignMessage = (message: string) => Promise<Hex>
