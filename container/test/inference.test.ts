import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {InferenceClient, InferenceRouter} from '../src/lib/inference'
import type {OpenAIChatRequest, OpenAIChatResponse} from '../src/lib/types'

interface FetchCall {
  url: string
  init?: RequestInit
}

let calls: FetchCall[] = []
const originalFetch = globalThis.fetch

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({url, init})
    return handler(url, init)
  }) as typeof fetch
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {'content-type': 'application/json'},
    ...init,
  })
}

function silentLogger() {
  const log = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => log),
  }
  return log
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('InferenceRouter.listModels', () => {
  it('aggregates models from every endpoint', async () => {
    mockFetch(url => {
      if (url === 'http://ollama:11434/v1/models') return jsonResponse({data: [{id: 'llama3'}, {id: 'mistral'}]})
      if (url === 'https://api.openai.com/v1/models') return jsonResponse({data: [{id: 'gpt-4o-mini'}]})
      throw new Error(`unexpected url ${url}`)
    })
    const log = silentLogger()
    const router = new InferenceRouter(
      [
        new InferenceClient('ollama', 'http://ollama:11434'),
        new InferenceClient('openai', 'https://api.openai.com', 'sk-test'),
      ],
      log as unknown as Parameters<typeof InferenceRouter>[1] extends never ? never : Parameters<ConstructorParameters<typeof InferenceRouter>[1]>[number],
    )
    const models = await router.listModels()
    expect(models.sort()).toEqual(['gpt-4o-mini', 'llama3', 'mistral'])
    expect(router.endpointFor('llama3')).toBe('ollama')
    expect(router.endpointFor('gpt-4o-mini')).toBe('openai')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('exposes both endpoints with a name prefix when they advertise the same model', async () => {
    mockFetch(url => {
      if (url === 'http://a/v1/models') return jsonResponse({data: [{id: 'llama3'}]})
      if (url === 'http://b/v1/models') return jsonResponse({data: [{id: 'llama3'}, {id: 'extra'}]})
      throw new Error(`unexpected url ${url}`)
    })
    const log = silentLogger()
    const router = new InferenceRouter(
      [new InferenceClient('a', 'http://a'), new InferenceClient('b', 'http://b')],
      log as never,
    )
    const models = await router.listModels()
    expect(models.sort()).toEqual(['a/llama3', 'b/llama3', 'extra'])
    expect(router.endpointFor('a/llama3')).toBe('a')
    expect(router.endpointFor('b/llama3')).toBe('b')
    expect(router.endpointFor('extra')).toBe('b')
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({modelId: 'llama3', endpoints: ['a', 'b']}),
      expect.stringMatching(/multiple endpoints/),
    )
  })

  it('rewrites the model field to the backend-native id when invoking a prefixed model', async () => {
    mockFetch(url => {
      if (url === 'http://a/v1/models') return jsonResponse({data: [{id: 'llama3'}]})
      if (url === 'http://b/v1/models') return jsonResponse({data: [{id: 'llama3'}]})
      if (url === 'http://b/v1/chat/completions') {
        return jsonResponse({
          id: 'r',
          object: 'chat.completion',
          created: 0,
          model: 'llama3',
          choices: [{index: 0, message: {role: 'assistant', content: 'hi'}, finish_reason: 'stop'}],
        })
      }
      throw new Error(`unexpected url ${url}`)
    })
    const router = new InferenceRouter(
      [new InferenceClient('a', 'http://a'), new InferenceClient('b', 'http://b')],
      silentLogger() as never,
    )
    await router.listModels()

    await router.chatCompletion({model: 'b/llama3', messages: [{role: 'user', content: 'hi'}]})

    const chatCall = calls.find(c => c.url.endsWith('/v1/chat/completions'))!
    expect(chatCall.url).toBe('http://b/v1/chat/completions')
    const body = JSON.parse(chatCall.init!.body as string) as {model: string}
    expect(body.model).toBe('llama3')
  })

  it('picks up the context window when the backend reports one (multiple field names)', async () => {
    mockFetch(url => {
      // Mix of backend dialects: LiteLLM (context_window), vLLM (max_model_len),
      // OpenRouter (max_input_tokens), and Ollama (no field at all).
      if (url === 'http://litellm/v1/models')
        return jsonResponse({data: [{id: 'gpt-4o-mini', context_window: 128000}]})
      if (url === 'http://vllm/v1/models')
        return jsonResponse({data: [{id: 'llama3-70b', max_model_len: 8192}]})
      if (url === 'http://openrouter/v1/models')
        return jsonResponse({data: [{id: 'sonnet', max_input_tokens: 200000}]})
      if (url === 'http://ollama/v1/models') return jsonResponse({data: [{id: 'mistral'}]})
      throw new Error(`unexpected url ${url}`)
    })
    const router = new InferenceRouter(
      [
        new InferenceClient('litellm', 'http://litellm'),
        new InferenceClient('vllm', 'http://vllm'),
        new InferenceClient('openrouter', 'http://openrouter'),
        new InferenceClient('ollama', 'http://ollama'),
      ],
      silentLogger() as never,
    )
    await router.listModels()
    expect(router.contextWindowFor('gpt-4o-mini')).toBe(128000)
    expect(router.contextWindowFor('llama3-70b')).toBe(8192)
    expect(router.contextWindowFor('sonnet')).toBe(200000)
    expect(router.contextWindowFor('mistral')).toBeUndefined()
  })

  it('returns undefined for an unknown exposed id', async () => {
    mockFetch(() => jsonResponse({data: []}))
    const router = new InferenceRouter(
      [new InferenceClient('ollama', 'http://ollama')],
      silentLogger() as never,
    )
    await router.listModels()
    expect(router.contextWindowFor('nope')).toBeUndefined()
  })

  it('skips endpoints whose listModels throws, keeps the rest live', async () => {
    mockFetch(url => {
      if (url === 'http://broken/v1/models') return new Response('boom', {status: 503})
      if (url === 'http://ok/v1/models') return jsonResponse({data: [{id: 'llama3'}]})
      throw new Error(`unexpected url ${url}`)
    })
    const log = silentLogger()
    const router = new InferenceRouter(
      [new InferenceClient('broken', 'http://broken'), new InferenceClient('ok', 'http://ok')],
      log as never,
    )
    const models = await router.listModels()
    expect(models).toEqual(['llama3'])
    expect(router.endpointFor('llama3')).toBe('ok')
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({endpoint: 'broken'}),
      expect.stringMatching(/listModels failed/),
    )
  })
})

describe('InferenceRouter.chatCompletion', () => {
  function fakeResponse(): OpenAIChatResponse {
    return {
      id: 'r1',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-4o-mini',
      choices: [{index: 0, message: {role: 'assistant', content: 'hi'}, finish_reason: 'stop'}],
    }
  }

  it('routes to the endpoint that advertised the model and forwards the api key', async () => {
    mockFetch(url => {
      if (url.endsWith('/v1/models')) {
        if (url === 'http://ollama:11434/v1/models') return jsonResponse({data: [{id: 'llama3'}]})
        if (url === 'https://api.openai.com/v1/models') return jsonResponse({data: [{id: 'gpt-4o-mini'}]})
      }
      if (url.endsWith('/v1/chat/completions')) return jsonResponse(fakeResponse())
      throw new Error(`unexpected url ${url}`)
    })
    const router = new InferenceRouter(
      [
        new InferenceClient('ollama', 'http://ollama:11434'),
        new InferenceClient('openai', 'https://api.openai.com', 'sk-secret'),
      ],
      silentLogger() as never,
    )
    await router.listModels()

    const req: OpenAIChatRequest = {model: 'gpt-4o-mini', messages: [{role: 'user', content: 'hi'}]}
    await router.chatCompletion(req)

    const chatCall = calls.find(c => c.url.endsWith('/v1/chat/completions'))!
    expect(chatCall.url).toBe('https://api.openai.com/v1/chat/completions')
    const headers = chatCall.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-secret')
  })

  it('throws a clear error when the model is unknown', async () => {
    mockFetch(() => jsonResponse({data: []}))
    const router = new InferenceRouter(
      [new InferenceClient('ollama', 'http://ollama:11434')],
      silentLogger() as never,
    )
    await router.listModels()
    await expect(
      router.chatCompletion({model: 'nope', messages: []}),
    ).rejects.toThrow(/no inference endpoint serves model nope/)
  })
})
