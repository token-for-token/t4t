import express, {type Express, type Request, type Response} from 'express'
import type {Logger} from '../../lib/logger'
import type {OpenAIChatRequest, OpenAIChatResponse} from '../../lib/types'

export interface GatewayApiDeps {
  logger: Logger
  fakeStreaming: boolean
  /** Wire the actual T4T round-trip: post job, await delivery, return response. */
  handleChat: (req: OpenAIChatRequest) => Promise<OpenAIChatResponse>
  /** List the union of models offered across discovered providers. */
  listModels: () => Promise<Array<{id: string; object: 'model'; created: number; owned_by: string}>>
}

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

    try {
      const completion = await deps.handleChat({...body, stream: false})
      if (body.stream) return emulateStream(res, completion)
      res.json(completion)
    } catch (err) {
      deps.logger.error({err}, 'chat completion failed')
      res.status(502).json({error: {message: String(err)}})
    }
  })
}

/** SSE emulation per spec §7.2: hold the connection, then flush as chunks. */
function emulateStream(res: Response, completion: OpenAIChatResponse): void {
  res.setHeader('content-type', 'text/event-stream')
  res.setHeader('cache-control', 'no-cache')
  res.setHeader('connection', 'keep-alive')
  const id = completion.id
  const model = completion.model
  const created = completion.created
  const choice = completion.choices[0]
  const fullContent = choice?.message.content ?? ''
  const chunks = chunkText(fullContent, 32)

  for (const part of chunks) {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{index: 0, delta: {role: 'assistant', content: part}, finish_reason: null}],
      })}\n\n`,
    )
  }
  res.write(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{index: 0, delta: {}, finish_reason: choice?.finish_reason ?? 'stop'}],
    })}\n\n`,
  )
  res.write('data: [DONE]\n\n')
  res.end()
}

function chunkText(s: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}
