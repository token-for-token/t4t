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
 * `listModels()` rebuilds the exposed-id → (client, backend-id) map:
 *   - If only one endpoint advertises a model, it's exposed under its bare id.
 *   - If multiple endpoints advertise the same id (e.g. `llama3` on both
 *     Ollama and OpenAI), each is exposed as `<endpoint-name>/<modelId>` so
 *     the operator can publish two distinct on-chain offerings with different
 *     prices. When forwarding to the actual backend, the router rewrites
 *     `model` back to the backend-native id.
 * An endpoint whose `/v1/models` call fails is skipped for that round — one
 * broken backend should not silently disable the others.
 */
export class InferenceRouter {
  private routing = new Map<string, {client: InferenceClient; backendModelId: string}>()

  constructor(
    readonly clients: InferenceClient[],
    private readonly logger: Logger,
  ) {}

  /** Aggregated, namespaced model list across all reachable endpoints.
   *  Side-effect: refreshes the internal routing map. */
  async listModels(): Promise<string[]> {
    const byModel = new Map<string, InferenceClient[]>()
    for (const c of this.clients) {
      let ids: string[]
      try {
        ids = await c.listModels()
      } catch (err) {
        this.logger.warn({err, endpoint: c.name}, 'listModels failed; skipping endpoint this round')
        continue
      }
      for (const id of ids) {
        const list = byModel.get(id) ?? []
        list.push(c)
        byModel.set(id, list)
      }
    }

    const next = new Map<string, {client: InferenceClient; backendModelId: string}>()
    for (const [modelId, clients] of byModel) {
      if (clients.length === 1) {
        this.assign(next, modelId, clients[0]!, modelId)
        continue
      }
      this.logger.info(
        {modelId, endpoints: clients.map(c => c.name)},
        'model offered by multiple endpoints; registering each with endpoint prefix',
      )
      for (const c of clients) this.assign(next, `${c.name}/${modelId}`, c, modelId)
    }
    this.routing = next
    return [...next.keys()]
  }

  /** Insert into the routing map, warning if the exposed id is already taken
   *  (e.g. an HF-style "meta-llama/foo" colliding with a prefix-built id). */
  private assign(
    map: Map<string, {client: InferenceClient; backendModelId: string}>,
    exposedId: string,
    client: InferenceClient,
    backendModelId: string,
  ): void {
    const prev = map.get(exposedId)
    if (prev) {
      this.logger.warn(
        {exposedId, kept: prev.client.name, ignored: client.name},
        'exposed model id collision after prefixing; keeping first',
      )
      return
    }
    map.set(exposedId, {client, backendModelId})
  }

  /** Returns the endpoint name currently serving a model, or null if unknown. */
  endpointFor(modelId: string): string | null {
    return this.routing.get(modelId)?.client.name ?? null
  }

  /** Returns the endpoint name plus the backend-native model id for an
   *  exposed id (i.e. the id that travels over the wire / on-chain). Used by
   *  the admin UI to mirror price edits back into endpoints.json, which
   *  keys prices by backend-native id, not the prefixed exposed form. */
  routeFor(exposedId: string): {endpointName: string; backendModelId: string} | null {
    const e = this.routing.get(exposedId)
    if (!e) return null
    return {endpointName: e.client.name, backendModelId: e.backendModelId}
  }

  async chatCompletion(req: OpenAIChatRequest): Promise<OpenAIChatResponse> {
    const entry = this.routing.get(req.model)
    if (!entry) throw new Error(`no inference endpoint serves model ${req.model}`)
    return entry.client.chatCompletion({...req, model: entry.backendModelId})
  }

  async probeModel(modelId: string): Promise<void> {
    const entry = this.routing.get(modelId)
    if (!entry) throw new Error(`no inference endpoint serves model ${modelId}`)
    return entry.client.probeModel(entry.backendModelId)
  }
}
