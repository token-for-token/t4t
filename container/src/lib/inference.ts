import type {OpenAIChatRequest, OpenAIChatResponse} from './types'

/**
 * Thin client for any OpenAI-compatible inference backend (Ollama, vLLM,
 * LiteLLM, llama.cpp, OpenAI, …). We pass the request straight through —
 * the backend already speaks the OpenAI Chat Completions format.
 */
export class InferenceClient {
  constructor(
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
      throw new Error(`inference backend ${res.status}: ${text}`)
    }
    return (await res.json()) as OpenAIChatResponse
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`, {headers: this.headers()})
    if (!res.ok) throw new Error(`inference backend list ${res.status}`)
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
      throw new Error(`probe ${modelId} ${res.status}: ${text}`)
    }
  }
}
