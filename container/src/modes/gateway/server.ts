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
 *  Progress events are emitted inside a `<think>` block at the head of the
 *  assistant turn — the de-facto reasoning-content convention used by
 *  DeepSeek R1, o1, QwQ, and friends. Every chat client that supports
 *  reasoning models (Open WebUI, LibreChat, Continue, Cline, Cursor,
 *  Big-AGI…) already renders `<think>` as a collapsed "thinking" section
 *  visually separate from the assistant answer. Headless SDKs see it as
 *  plain content but most agents strip or fold it.
 *
 *  When the model's own response contains a leading `<think>…</think>` block
 *  (reasoning models), we splice that into our gateway-progress block and
 *  emit a single merged `<think>` so the user sees one unified thinking
 *  panel ("network status + model reasoning") rather than two stacked ones.
 *
 *  We can't emit a literal mid-stream `role: 'system'` chunk because the
 *  OpenAI streaming protocol is single-message-per-request — clients latch
 *  the role from the first chunk and concatenate everything else into one
 *  bubble. The `<think>` convention is what gets us the two-message visual
 *  UX inside that constraint.
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

  // Structured-output mode: the client expects the assistant content to be
  // parseable JSON (response_format) or to carry tool_calls instead of prose.
  // A `<think>` prefix would invalidate JSON parsing and confuse tool-using
  // agents, so we skip the thinking block entirely. SSE keepalive comments
  // still flow during the wait, which is enough to prevent fetch / proxy
  // idle timeouts without polluting the assistant content.
  const structured = isStructuredMode(body)

  let thinkOpen = false
  if (!structured) {
    // Open the merged thinking block. We hold it open until handleChat
    // resolves so the model's own <think> reasoning (if any) can be spliced
    // in before we close — one unified collapsed panel rather than two.
    writeChunk({content: `<think>\nt4t network:\n`})
    thinkOpen = true
  }

  const closeThink = (extra?: string): void => {
    if (!thinkOpen) return
    thinkOpen = false
    const tail = extra ? `\n${extra.trim()}\n` : ''
    writeChunk({content: `${tail}</think>\n\n`})
  }

  try {
    const completion = await deps.handleChat({...body, stream: false}, e => {
      if (structured) return
      const line = renderProgress(e)
      if (line) writeChunk({content: line})
    })

    const fullContent = completion.choices[0]?.message.content ?? ''

    if (structured) {
      // No thinking wrapper — emit content verbatim so JSON.parse / tool-call
      // extractors get exactly what the provider produced.
      if (fullContent) writeChunk({content: fullContent})
    } else {
      // Merge the model's own <think>…</think> (if any) into our network
      // progress block so the user sees a single thinking panel containing
      // network status followed by model reasoning.
      const {thinking, rest} = splitLeadingThink(fullContent)
      closeThink(thinking ? `\nmodel reasoning:\n${thinking}` : undefined)
      if (rest) writeChunk({content: rest})
    }

    writeChunk({}, completion.choices[0]?.finish_reason ?? 'stop')
    res.write('data: [DONE]\n\n')
  } catch (err) {
    deps.logger.error({err}, 'chat completion failed (stream)')
    if (structured) {
      // Structured-mode clients can't render a markdown error bullet. Set a
      // distinct finish_reason so the SDK / agent surfaces the failure rather
      // than handing back an empty assistant message that looks successful.
      writeChunk({}, 'error')
      res.write('data: [DONE]\n\n')
    } else {
      // Surface the failure to the user inside the assistant turn rather than
      // dropping the socket — the latter looks like a network error to the
      // client, this is at least diagnostic. We close the thinking block
      // first so the error renders as the assistant answer, not reasoning.
      closeThink(`error: ${escapeMarkdown(String(err))}`)
      writeChunk({}, 'stop')
      res.write('data: [DONE]\n\n')
    }
  } finally {
    clearInterval(heartbeat)
    res.end()
  }
}

/** Pull a leading `<think>…</think>` block off the model's response content.
 *  Reasoning models (DeepSeek R1, QwQ, o1-style local backends) emit their
 *  reasoning as a `<think>` block followed by the actual answer; we want to
 *  hoist that into our merged thinking panel rather than leave it embedded
 *  in the final answer where it duplicates the reasoning UI. */
function splitLeadingThink(content: string): {thinking: string; rest: string} {
  const match = content.match(/^\s*<think>([\s\S]*?)<\/think>\s*/i)
  if (!match) return {thinking: '', rest: content}
  return {thinking: match[1]!.trim(), rest: content.slice(match[0].length)}
}

/** True if the client expects a machine-parseable assistant message:
 *    - `response_format` is set to anything other than `text` (json_object,
 *      json_schema, …) — prepending `<details>` HTML would break JSON.parse.
 *    - `tools` array is non-empty — the agent is going to feed the assistant
 *      reply into its own parser to detect tool calls / extract code.
 *  In either case we still keep the SSE connection live with comment
 *  heartbeats, we just don't pollute `delta.content`. */
function isStructuredMode(req: OpenAIChatRequest): boolean {
  const r = req as Record<string, unknown>
  const responseFormat = r.response_format as {type?: string} | undefined
  if (responseFormat && responseFormat.type && responseFormat.type !== 'text') return true
  const tools = r.tools
  if (Array.isArray(tools) && tools.length > 0) return true
  return false
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
