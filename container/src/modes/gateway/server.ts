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
 *  Progress events are emitted inside a `<details type="status">` block at
 *  the head of the assistant turn. Open WebUI (and any Markdown-aware client)
 *  renders that block as a collapsed "status pill" visually separate from
 *  the assistant answer, so the user perceives two messages — a system-style
 *  status update streaming while the network does its work, then the AI
 *  answer once delivery completes. After the block closes, the actual model
 *  output streams as normal content.
 *
 *  We can't emit a literal mid-stream `role: 'system'` chunk because the
 *  OpenAI streaming protocol is single-message-per-request — clients latch
 *  the role from the first chunk and concatenate everything else into one
 *  bubble. The `<details type="status">` convention is the established way
 *  to get the two-message visual UX inside that constraint.
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

  const writeChunk = (delta: {role?: 'assistant'; content?: string}, finish: string | null = null): void => {
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

  // Open the status block. `done="false"` tells Open WebUI to keep the pill
  // spinning until either the closing tag arrives or `done="true"` is set.
  // The summary is what the user sees on the collapsed pill.
  let statusOpen = true
  writeChunk({content: `<details type="status" done="false">\n<summary>t4t network</summary>\n\n`})

  const closeStatus = (): void => {
    if (!statusOpen) return
    statusOpen = false
    writeChunk({content: `\n</details>\n\n`})
  }

  try {
    const completion = await deps.handleChat({...body, stream: false}, e => {
      const line = renderProgress(e)
      if (line) writeChunk({content: line})
    })

    closeStatus()

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
    // client, this is at least diagnostic. We close the status block first
    // so the error renders as the assistant answer, not as a status line.
    writeChunk({content: `- error: ${escapeMarkdown(String(err))}\n`})
    closeStatus()
    writeChunk({}, 'stop')
    res.write('data: [DONE]\n\n')
  } finally {
    clearInterval(heartbeat)
    res.end()
  }
}

/** Format a lifecycle event as a single bullet line inside the `<details
 *  type="status">` block. Returning null suppresses an event from the wire. */
function renderProgress(e: ProgressEvent): string | null {
  switch (e.kind) {
    case 'selecting_provider':
      return `- selecting provider for \`${escapeMarkdown(e.modelId)}\`…\n`
    case 'provider_selected':
      return `- provider \`${shortHex(e.provider)}\` selected\n`
    case 'posting_job':
      return `- posting job on-chain (max \`${e.maxPayment}\` xBZZ wei)…\n`
    case 'job_posted':
      return `- job posted (tx \`${shortHex(e.txHash)}\`)\n`
    case 'notifying_provider':
      return `- notifying provider via Swarm PSS…\n`
    case 'provider_acked':
      return `- provider acked (ETA ${e.estimatedCompletion}s)\n`
    case 'awaiting_delivery':
      return `- awaiting response delivery from Swarm…\n`
    case 'delivered': {
      const tokens =
        e.promptTokens !== null && e.completionTokens !== null
          ? ` (${e.promptTokens}/${e.completionTokens} tokens)`
          : ''
      return `- response delivered${tokens}\n`
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
