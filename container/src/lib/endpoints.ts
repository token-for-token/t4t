import {z} from 'zod'
import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'

const EndpointSchema = z.object({
  // Operator-visible label; appears in logs ("endpoint=openai listModels failed").
  // Must be unique across the list — also used as the prefix when two endpoints
  // advertise the same model id (registered on-chain as `<name>/<modelId>`).
  // `/` is forbidden so the prefix split is unambiguous.
  name: z.string().min(1).regex(/^[^/]+$/, 'endpoint name must not contain "/"'),
  // Base URL of an OpenAI-compatible HTTP API. /v1/chat/completions and /v1/models
  // are appended at call time, so don't include them here.
  url: z.string().url(),
  // Bearer token. Omit for unauthenticated backends like a local Ollama.
  apiKey: z.string().optional(),
})

const EndpointsSchema = z.array(EndpointSchema).min(1).superRefine((arr, ctx) => {
  const seen = new Set<string>()
  for (const e of arr) {
    if (seen.has(e.name)) {
      ctx.addIssue({code: 'custom', message: `duplicate endpoint name: ${e.name}`})
    }
    seen.add(e.name)
  }
})

export type InferenceEndpoint = z.infer<typeof EndpointSchema>

/** Resolve the on-disk endpoints file path — `T4T_ENDPOINTS_FILE` env wins,
 *  else `${T4T_DATA_DIR}/endpoints.json`. Mirrors `walletKeyFilePath`. */
export function endpointsFilePath(dataDir: string): string {
  return process.env.T4T_ENDPOINTS_FILE ?? join(dataDir, 'endpoints.json')
}

export class EndpointsFileError extends Error {
  constructor(public readonly path: string, message: string) {
    super(message)
    this.name = 'EndpointsFileError'
  }
}

/** Load and validate the inference-endpoints config file. Throws
 *  `EndpointsFileError` with a clear message if missing, unreadable,
 *  unparseable, or empty — the provider entrypoint surfaces this to the
 *  operator instead of crashing in `listModels`. */
export function loadEndpoints(dataDir: string): InferenceEndpoint[] {
  const path = endpointsFilePath(dataDir)
  if (!existsSync(path)) {
    throw new EndpointsFileError(
      path,
      `inference endpoints file not found at ${path} — create it with at least one {name, url, apiKey?} entry`,
    )
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new EndpointsFileError(path, `failed to read ${path}: ${(err as Error).message}`)
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new EndpointsFileError(path, `${path} is not valid JSON: ${(err as Error).message}`)
  }
  const parsed = EndpointsSchema.safeParse(json)
  if (!parsed.success) {
    throw new EndpointsFileError(path, `${path} is not a valid endpoints list: ${parsed.error.message}`)
  }
  return parsed.data
}
