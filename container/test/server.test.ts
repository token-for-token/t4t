import express from 'express'
import http from 'node:http'
import {AddressInfo} from 'node:net'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {attachClientApi, type GatewayApiDeps} from '../src/modes/gateway/server'
import type {OpenAIChatRequest, OpenAIChatResponse, ProgressEvent} from '../src/lib/types'

interface Harness {
  url: string
  close: () => Promise<void>
}

function silentLogger(): GatewayApiDeps['logger'] {
  const noop = () => {}
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => silentLogger(),
  } as unknown as GatewayApiDeps['logger']
}

async function startServer(deps: GatewayApiDeps): Promise<Harness> {
  const app = express()
  attachClientApi(app, deps)
  const server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

function fakeCompletion(content: string): OpenAIChatResponse {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}],
    usage: {prompt_tokens: 3, completion_tokens: 4, total_tokens: 7},
  }
}

async function readSse(url: string, body: unknown): Promise<string> {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  })
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
  expect(res.body).not.toBeNull()
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const {value, done} = await reader.read()
    if (done) break
    out += decoder.decode(value, {stream: true})
  }
  out += decoder.decode()
  return out
}

function parseChunks(sse: string): Array<Record<string, unknown>> {
  return sse
    .split('\n\n')
    .map(s => s.trim())
    .filter(s => s.startsWith('data: ') && s !== 'data: [DONE]')
    .map(s => JSON.parse(s.slice('data: '.length)))
}

describe('attachClientApi /v1/chat/completions streaming', () => {
  let harness: Harness | null = null

  afterEach(async () => {
    await harness?.close()
    harness = null
  })

  it('emits progress events inside a <details type="status"> block before the response body', async () => {
    const events: ProgressEvent[] = [
      {kind: 'selecting_provider', modelId: 'llama3:8b'},
      {kind: 'provider_selected', provider: '0xabcdef1234567890abcdef1234567890abcdef12', modelId: 'llama3:8b'},
      {kind: 'posting_job', provider: '0xabcdef1234567890abcdef1234567890abcdef12', maxPayment: '1000'},
      {kind: 'job_posted', txHash: '0x' + '11'.repeat(32), onChainJobId: '0x' + '22'.repeat(32)},
      {kind: 'notifying_provider', provider: '0xabcdef1234567890abcdef1234567890abcdef12'},
      {kind: 'provider_acked', estimatedCompletion: 12},
      {kind: 'awaiting_delivery'},
      {kind: 'delivered', promptTokens: 3, completionTokens: 4},
    ]

    harness = await startServer({
      logger: silentLogger(),
      fakeStreaming: true,
      listModels: async () => [],
      handleChat: async (_req, onProgress) => {
        for (const ev of events) onProgress?.(ev)
        return fakeCompletion('hello world')
      },
    })

    const sse = await readSse(harness.url, {
      model: 'llama3:8b',
      messages: [{role: 'user', content: 'hi'}],
      stream: true,
    })

    expect(sse.trimEnd().endsWith('data: [DONE]')).toBe(true)

    const chunks = parseChunks(sse)

    // First chunk: assistant role primer (so clients render the bubble).
    expect((chunks[0]!.choices as Array<Record<string, unknown>>)[0]!.delta).toEqual({role: 'assistant'})

    const fullText = chunks
      .map(c => (c.choices as Array<{delta: {content?: string}}>)[0]!.delta.content ?? '')
      .join('')

    // Status block opens with the Open WebUI status type attribute.
    expect(fullText).toContain('<details type="status" done="false">')
    expect(fullText).toContain('<summary>t4t network</summary>')
    expect(fullText).toContain('</details>')

    // Progress lines live inside the status block; the assistant answer
    // lives outside it. Split on the closing tag and check both halves.
    const [statusBody, answerBody] = fullText.split('</details>')
    expect(statusBody).toBeDefined()
    expect(answerBody).toBeDefined()

    expect(statusBody).toContain('- selecting provider for `llama3:8b`')
    expect(statusBody).toContain('- provider `0xabcd…ef12` selected')
    expect(statusBody).toContain('- posting job on-chain')
    expect(statusBody).toContain('- job posted')
    expect(statusBody).toContain('- notifying provider via Swarm PSS')
    expect(statusBody).toContain('- provider acked (ETA 12s)')
    expect(statusBody).toContain('- awaiting response delivery')
    expect(statusBody).toContain('- response delivered (3/4 tokens)')

    // The model answer is outside the status block — Open WebUI renders this
    // as the assistant message proper, with the status block as a pill above.
    expect(answerBody).toContain('hello world')
    expect(statusBody).not.toContain('hello world')

    // The response arrives from Swarm as one blob; no cosmetic chunking.
    // Exactly one content chunk should carry the answer string.
    const answerChunks = chunks.filter(c => {
      const content = (c.choices as Array<{delta: {content?: string}}>)[0]!.delta.content
      return typeof content === 'string' && content.includes('hello world')
    })
    expect(answerChunks).toHaveLength(1)
    expect(
      (answerChunks[0]!.choices as Array<{delta: {content?: string}}>)[0]!.delta.content,
    ).toBe('hello world')

    // Final chunk carries finish_reason.
    const last = chunks[chunks.length - 1]!
    expect((last.choices as Array<{finish_reason: string}>)[0]!.finish_reason).toBe('stop')
  })

  it('rejects stream:true when fakeStreaming is off', async () => {
    harness = await startServer({
      logger: silentLogger(),
      fakeStreaming: false,
      listModels: async () => [],
      handleChat: async () => fakeCompletion('x'),
    })
    const res = await fetch(`${harness.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({model: 'm', messages: [{role: 'user', content: 'hi'}], stream: true}),
    })
    expect(res.status).toBe(400)
  })

  it('surfaces handleChat errors inside the SSE stream instead of dropping the socket', async () => {
    harness = await startServer({
      logger: silentLogger(),
      fakeStreaming: true,
      listModels: async () => [],
      handleChat: async () => {
        throw new Error('no provider matches model=ghost')
      },
    })

    const sse = await readSse(harness.url, {
      model: 'ghost',
      messages: [{role: 'user', content: 'hi'}],
      stream: true,
    })

    expect(sse.trimEnd().endsWith('data: [DONE]')).toBe(true)
    const contents = parseChunks(sse)
      .map(c => (c.choices as Array<{delta: {content?: string}}>)[0]!.delta.content)
      .filter((s): s is string => typeof s === 'string')
      .join('')
    // Error is rendered as a bullet inside the status block, then the
    // block closes so nothing is left half-open in the rendered markdown.
    expect(contents).toContain('- error: Error: no provider matches model=ghost')
    expect(contents).toContain('</details>')
  })

  it('omits the <details> status block when response_format requests JSON', async () => {
    let captured: ProgressEvent[] = []
    harness = await startServer({
      logger: silentLogger(),
      fakeStreaming: true,
      listModels: async () => [],
      handleChat: async (_req, onProgress) => {
        // Emit a few progress events; in structured mode they must not
        // surface as content even though they still fire internally.
        onProgress?.({kind: 'selecting_provider', modelId: 'm'})
        onProgress?.({kind: 'job_posted', txHash: '0x' + 'aa'.repeat(32), onChainJobId: '0x' + 'bb'.repeat(32)})
        return fakeCompletion('{"answer": 42}')
      },
    })

    const sse = await readSse(harness.url, {
      model: 'm',
      messages: [{role: 'user', content: 'json please'}],
      stream: true,
      response_format: {type: 'json_object'},
    })

    const chunks = parseChunks(sse)
    const fullText = chunks
      .map(c => (c.choices as Array<{delta: {content?: string}}>)[0]!.delta.content ?? '')
      .join('')

    // No <details> noise — the assistant content is just the JSON the model
    // produced, so `JSON.parse(fullText)` works for the agent.
    expect(fullText).not.toContain('<details')
    expect(fullText).not.toContain('selecting provider')
    expect(fullText).toBe('{"answer": 42}')
    expect(() => JSON.parse(fullText)).not.toThrow()

    // Suppress unused-var lint on captured (kept for future expansion).
    void captured
  })

  it('omits the <details> status block when tools is non-empty', async () => {
    harness = await startServer({
      logger: silentLogger(),
      fakeStreaming: true,
      listModels: async () => [],
      handleChat: async () => fakeCompletion('plain'),
    })

    const sse = await readSse(harness.url, {
      model: 'm',
      messages: [{role: 'user', content: 'use a tool'}],
      stream: true,
      tools: [{type: 'function', function: {name: 'noop', parameters: {type: 'object'}}}],
    })

    const fullText = parseChunks(sse)
      .map(c => (c.choices as Array<{delta: {content?: string}}>)[0]!.delta.content ?? '')
      .join('')
    expect(fullText).not.toContain('<details')
    expect(fullText).toBe('plain')
  })

  it('surfaces structured-mode errors via finish_reason instead of polluting content', async () => {
    harness = await startServer({
      logger: silentLogger(),
      fakeStreaming: true,
      listModels: async () => [],
      handleChat: async () => {
        throw new Error('boom')
      },
    })

    const sse = await readSse(harness.url, {
      model: 'm',
      messages: [{role: 'user', content: 'hi'}],
      stream: true,
      response_format: {type: 'json_object'},
    })

    const chunks = parseChunks(sse)
    const fullText = chunks
      .map(c => (c.choices as Array<{delta: {content?: string}}>)[0]!.delta.content ?? '')
      .join('')
    expect(fullText).toBe('')

    const last = chunks[chunks.length - 1]!
    expect((last.choices as Array<{finish_reason: string}>)[0]!.finish_reason).toBe('error')
  })

  it('non-streaming requests still return a single JSON body', async () => {
    harness = await startServer({
      logger: silentLogger(),
      fakeStreaming: true,
      listModels: async () => [],
      handleChat: async () => fakeCompletion('plain response'),
    })

    const res = await fetch(`${harness.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({model: 'm', messages: [{role: 'user', content: 'hi'}]}),
    })
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const json = (await res.json()) as OpenAIChatResponse
    expect(json.choices[0]!.message.content).toBe('plain response')
  })
})
