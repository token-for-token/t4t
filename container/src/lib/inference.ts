import type {Logger} from './logger'
import type {OpenAIChatRequest, OpenAIChatResponse} from './types'

/**
 * Thin client for any OpenAI-compatible inference backend (Ollama, vLLM,
 * LiteLLM, llama.cpp, OpenAI, …). We pass the request straight through —
 * the backend already speaks the OpenAI Chat Completions format.
 */
export class InferenceClient {
  constructor(
    /** Operator-visible label used in logs (e.g. "openai", "ollama"). */
    readonly name: string,
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {'content-type': 'application/json'}
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`
    return h
  }

  async chatCompletion(req: OpenAIChatRequest): Promise<OpenAIChatResponse> {
    // Always disable streaming over the wire; the client container fakes SSE
    // upstream if the user asked for it. See spec §7.2.
    const body = JSON.stringify({...req, stream: false})
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`inference backend ${this.name} ${res.status}: ${text}`)
    }
    return (await res.json()) as OpenAIChatResponse
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`, {headers: this.headers()})
    if (!res.ok) throw new Error(`inference backend ${this.name} list ${res.status}`)
    const data = (await res.json()) as {data?: Array<{id: string}>}
    return (data.data ?? []).map(m => m.id)
  }

  /** Minimal chat completion used as a liveness probe for a specific model.
   *  Surfaces "model file missing / unloaded" cases that /v1/models won't. */
  async probeModel(modelId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: modelId,
        messages: [{role: 'user', content: 'ping'}],
        max_tokens: 1,
        stream: false,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`probe ${this.name} ${modelId} ${res.status}: ${text}`)
    }
  }
}

/**
 * Routes inference calls across multiple `InferenceClient` backends. Each
 * `listModels()` rebuilds the modelId → client map: first endpoint to advertise
 * a model wins (later collisions are warned and dropped). An endpoint whose
 * `/v1/models` call fails is skipped for that round — one broken backend should
 * not silently disable the others.
 */
export class InferenceRouter {
  private routing = new Map<string, InferenceClient>()

  constructor(
    readonly clients: InferenceClient[],
    private readonly logger: Logger,
  ) {}

  /** Aggregated, deduped model list across all reachable endpoints.
   *  Side-effect: refreshes the internal routing map. */
  async listModels(): Promise<string[]> {
    const next = new Map<string, InferenceClient>()
    for (const c of this.clients) {
      let ids: string[]
      try {
        ids = await c.listModels()
      } catch (err) {
        this.logger.warn({err, endpoint: c.name}, 'listModels failed; skipping endpoint this round')
        continue
      }
      for (const id of ids) {
        const prev = next.get(id)
        if (prev) {
          this.logger.warn(
            {modelId: id, kept: prev.name, ignored: c.name},
            'model collision; first-listed endpoint wins',
          )
          continue
        }
        next.set(id, c)
      }
    }
    this.routing = next
    return [...next.keys()]
  }

  /** Returns the endpoint name currently serving a model, or null if unknown. */
  endpointFor(modelId: string): string | null {
    return this.routing.get(modelId)?.name ?? null
  }

  async chatCompletion(req: OpenAIChatRequest): Promise<OpenAIChatResponse> {
    const c = this.routing.get(req.model)
    if (!c) throw new Error(`no inference endpoint serves model ${req.model}`)
    return c.chatCompletion(req)
  }

  async probeModel(modelId: string): Promise<void> {
    const c = this.routing.get(modelId)
    if (!c) throw new Error(`no inference endpoint serves model ${modelId}`)
    return c.probeModel(modelId)
  }
}
