import express, {type Request, type Response} from 'express'
import type {Logger} from '../../lib/logger'
import type {OpenAIChatRequest, OpenAIChatResponse} from '../../lib/types'

export interface ClientServerDeps {
  logger: Logger
  port: number
  fakeStreaming: boolean
  /** Wire the actual T4T round-trip: post job, await delivery, return response. */
  handleChat: (req: OpenAIChatRequest) => Promise<OpenAIChatResponse>
  /** List the union of models offered across discovered providers. */
  listModels: () => Promise<Array<{id: string; object: 'model'; created: number; owned_by: string}>>
}

export function startClientServer(deps: ClientServerDeps): import('http').Server {
  const app = express()
  app.use(express.json({limit: '10mb'}))

  app.get('/healthz', (_req, res) => res.json({ok: true}))

  app.get('/v1/models', async (_req, res) => {
    try {
      res.json({object: 'list', data: await deps.listModels()})
    } catch (err) {
      deps.logger.error({err}, 'list models failed')
      res.status(500).json({error: {message: String(err)}})
    }
  })

  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
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

  return app.listen(deps.port, () => deps.logger.info({port: deps.port}, 'client http listening'))
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
