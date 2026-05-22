import express, {type Express, type Request, type Response} from 'express'
import type {Logger} from '../../lib/logger'
import type {OpenAIChatRequest, OpenAIChatResponse, ProgressEvent} from '../../lib/types'

export interface GatewayApiDeps {
  logger: Logger
  fakeStreaming: boolean
  /** Wire the actual T4T round-trip: post job, await delivery, return response.
   *  The optional `onProgress` callback receives lifecycle events as the
   *  request moves through the protocol; the SSE path uses it to keep the
   *  client connection live and informed during the multi-second round-trip. */
  handleChat: (
    req: OpenAIChatRequest,
    onProgress?: (e: ProgressEvent) => void,
  ) => Promise<OpenAIChatResponse>
  /** List the union of models offered across discovered providers. */
  listModels: () => Promise<Array<{id: string; object: 'model'; created: number; owned_by: string}>>
}

/** SSE heartbeat cadence. Sized below the typical 30-60s reverse-proxy /
 *  client-side fetch idle timeout so a slow inference round-trip can't be
 *  killed mid-flight. Comments (lines starting with `:`) are ignored by SSE
 *  clients, so they don't pollute the chat content. */
const HEARTBEAT_MS = 10_000

/** Mount the OpenAI-compatible client API onto an existing Express app.
 *  The admin server owns the listener; we just register `/v1/*` routes so
 *  there's a single HTTP port for both operator UI and SDK consumers. */
export function attachClientApi(app: Express, deps: GatewayApiDeps): void {
  // 10mb cap for chat-completion bodies — apply per-route so the admin
  // server's smaller global json limit isn't accidentally widened.
  const big = express.json({limit: '10mb'})

  app.get('/v1/models', async (_req, res) => {
    try {
      res.json({object: 'list', data: await deps.listModels()})
    } catch (err) {
      deps.logger.error({err}, 'list models failed')
      res.status(500).json({error: {message: String(err)}})
    }
  })

  app.post('/v1/chat/completions', big, async (req: Request, res: Response) => {
    const body = req.body as OpenAIChatRequest
    if (!body || !body.model || !Array.isArray(body.messages)) {
      return res.status(400).json({error: {message: 'invalid request'}})
    }

    if (body.stream && !deps.fakeStreaming) {
      return res.status(400).json({error: {message: 'streaming disabled; set T4T_FAKE_STREAMING=true'}})
    }

    if (body.stream) return streamChat(res, body, deps)

    try {
      const completion = await deps.handleChat({...body, stream: false})
      res.json(completion)
    } catch (err) {
      deps.logger.error({err}, 'chat completion failed')
      res.status(502).json({error: {message: String(err)}})
    }
  })
}

/** Real-time SSE flow.
 *
 *  Unlike the previous fake-stream behavior (await everything, then flush),
 *  this writes lifecycle events to the wire as they happen. That serves two
 *  goals:
 *    1. The HTTP connection sees regular data, so Open WebUI / fetch-based
 *       agents don't hit their idle-read timeout during the 5-30s T4T
 *       round-trip.
 *    2. The user sees what the gateway is doing (selecting a provider,
 *       posting on-chain, waiting for PSS delivery) instead of staring at a
 *       blank assistant bubble.
 *
 *  Progress events are rendered as markdown blockquote lines so they're
 *  visible in any chat UI without special handling, then the actual model
 *  output streams after a separator.
 */
async function streamChat(
  res: Response,
  body: OpenAIChatRequest,
  deps: GatewayApiDeps,
): Promise<void> {
  res.setHeader('content-type', 'text/event-stream')
  res.setHeader('cache-control', 'no-cache')
  res.setHeader('connection', 'keep-alive')
  // Tell intermediaries (nginx, cloudflare) not to buffer — defeats the whole
  // point of streaming if a proxy holds chunks until the body finishes.
  res.setHeader('x-accel-buffering', 'no')
  // Flush headers so the client sees the connection open immediately, not
  // after the first chunk lands.
  res.flushHeaders?.()

  const id = `chatcmpl-${Date.now().toString(36)}`
  const created = Math.floor(Date.now() / 1000)
  const model = body.model

  const writeChunk = (delta: {role?: 'assistant' | 'system'; content?: string}, finish: string | null = null): void => {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{index: 0, delta, finish_reason: finish}],
      })}\n\n`,
    )
  }

  // Comments are ignored by EventSource / OpenAI SDK parsers but keep the
  // TCP stream warm so intermediaries don't kill the socket.
  const heartbeat = setInterval(() => {
    res.write(': keepalive\n\n')
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  // Initial role chunk — some OpenAI clients only render content once they've
  // seen a delta carrying the role.
  writeChunk({role: 'assistant'})

  try {
    const completion = await deps.handleChat({...body, stream: false}, e => {
      const line = renderProgress(e)
      if (line) writeChunk({content: line})
    })

    // Separator between the progress preamble and the actual answer. Empty
    // string is harmless for clients that strip whitespace.
    writeChunk({content: '\n'})

    const fullContent = completion.choices[0]?.message.content ?? ''
    for (const part of chunkText(fullContent, 32)) {
      writeChunk({content: part})
    }

    writeChunk({}, completion.choices[0]?.finish_reason ?? 'stop')
    res.write('data: [DONE]\n\n')
  } catch (err) {
    deps.logger.error({err}, 'chat completion failed (stream)')
    // Surface the failure to the user inside the assistant turn rather than
    // dropping the socket — the latter looks like a network error to the
    // client, this is at least diagnostic.
    writeChunk({content: `\n> _error: ${escapeMarkdown(String(err))}_\n`})
    writeChunk({}, 'stop')
    res.write('data: [DONE]\n\n')
  } finally {
    clearInterval(heartbeat)
    res.end()
  }
}

/** Format a lifecycle event as a single markdown blockquote line. Returning
 *  null suppresses an event from the wire (e.g. if a future event is too
 *  noisy to render to end users). */
function renderProgress(e: ProgressEvent): string | null {
  switch (e.kind) {
    case 'selecting_provider':
      return `> _t4t: selecting provider for \`${escapeMarkdown(e.modelId)}\`…_\n`
    case 'provider_selected':
      return `> _t4t: provider \`${shortHex(e.provider)}\` selected_\n`
    case 'posting_job':
      return `> _t4t: posting job on-chain (max \`${e.maxPayment}\` xBZZ wei)…_\n`
    case 'job_posted':
      return `> _t4t: job posted (tx \`${shortHex(e.txHash)}\`)_\n`
    case 'notifying_provider':
      return `> _t4t: notifying provider via Swarm PSS…_\n`
    case 'provider_acked':
      return `> _t4t: provider acked (ETA ${e.estimatedCompletion}s)_\n`
    case 'awaiting_delivery':
      return `> _t4t: awaiting response delivery from Swarm…_\n`
    case 'delivered': {
      const tokens =
        e.promptTokens !== null && e.completionTokens !== null
          ? ` (${e.promptTokens}/${e.completionTokens} tokens)`
          : ''
      return `> _t4t: response delivered${tokens}_\n`
    }
  }
}

function shortHex(s: string): string {
  if (!s.startsWith('0x') || s.length <= 12) return s
  return `${s.slice(0, 6)}…${s.slice(-4)}`
}

/** Defang underscores/backticks so user-supplied model ids and error messages
 *  can't break out of the italic/code spans we wrap them in. */
function escapeMarkdown(s: string): string {
  return s.replace(/[`_*]/g, '\\$&').replace(/\n/g, ' ')
}

function chunkText(s: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}
