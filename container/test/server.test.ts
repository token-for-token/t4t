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

  it('emits progress events as SSE chunks before the response body', async () => {
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
    expect(chunks.length).toBeGreaterThan(events.length)

    // First chunk: assistant role primer (so clients render the bubble).
    expect((chunks[0]!.choices as Array<Record<string, unknown>>)[0]!.delta).toEqual({role: 'assistant'})

    const contents = chunks
      .map(c => (c.choices as Array<{delta: {content?: string}}>)[0]!.delta.content)
      .filter((s): s is string => typeof s === 'string')

    // Every progress event surfaces as a visible blockquote line.
    expect(contents.some(c => c.includes('selecting provider'))).toBe(true)
    expect(contents.some(c => c.includes('provider `0xabcd…ef12` selected'))).toBe(true)
    expect(contents.some(c => c.includes('posting job on-chain'))).toBe(true)
    expect(contents.some(c => c.includes('job posted'))).toBe(true)
    expect(contents.some(c => c.includes('notifying provider'))).toBe(true)
    expect(contents.some(c => c.includes('provider acked (ETA 12s)'))).toBe(true)
    expect(contents.some(c => c.includes('awaiting response delivery'))).toBe(true)
    expect(contents.some(c => c.includes('response delivered (3/4 tokens)'))).toBe(true)

    // Actual answer survives chunking.
    expect(contents.join('')).toContain('hello world')

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
    expect(contents).toContain('no provider matches model=ghost')
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
