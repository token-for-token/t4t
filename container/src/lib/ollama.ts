import type {OpenAIChatRequest, OpenAIChatResponse} from './types'

/**
 * Thin wrapper over Ollama's OpenAI-compatible endpoint. We pass the request
 * straight through — Ollama already speaks the format.
 */
export class OllamaClient {
  constructor(private readonly baseUrl: string) {}

  async chatCompletion(req: OpenAIChatRequest): Promise<OpenAIChatResponse> {
    // Always disable streaming over the wire; the client container fakes SSE
    // upstream if the user asked for it. See spec §7.2.
    const body = JSON.stringify({...req, stream: false})
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`ollama ${res.status}: ${text}`)
    }
    return (await res.json()) as OpenAIChatResponse
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`)
    if (!res.ok) throw new Error(`ollama list ${res.status}`)
    const data = (await res.json()) as {models?: Array<{name: string}>}
    return (data.models ?? []).map(m => m.name)
  }
}
