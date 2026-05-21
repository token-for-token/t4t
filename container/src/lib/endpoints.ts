import {z} from 'zod'
import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

const BzzAmount = z.string().refine(s => {
  const t = s.trim()
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(t)) return false
  const frac = t.split('.')[1] ?? ''
  return frac.length <= 16
}, 'must be a non-negative BZZ decimal with at most 16 fractional digits')

const PriceSchema = z.object({
  inputBzz: BzzAmount,
  outputBzz: BzzAmount,
})

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
  // Optional declarative per-model prices, keyed by the **backend-native**
  // model id (NOT the exposed/prefixed form). BZZ decimal strings — up to 16
  // fractional digits. UI edits on the Models page are mirrored back here so
  // operators can hand-edit or version-control prices.
  models: z.record(PriceSchema).optional(),
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
export type ModelPriceEntry = z.infer<typeof PriceSchema>

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

/** Atomic write — stage to `${path}.tmp`, then rename. Same file that
 *  `loadEndpoints` reads. Pretty-printed so the operator can diff and
 *  hand-edit the file alongside container-driven price updates. */
export function writeEndpoints(dataDir: string, endpoints: InferenceEndpoint[]): void {
  const path = endpointsFilePath(dataDir)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(endpoints, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

/** Update an endpoint's `models` block with a single (backendModelId, price)
 *  pair. Returns true if the entry was new or changed, false if the existing
 *  entry already matched. Mutates the passed endpoint. */
export function setDeclaredPrice(
  endpoint: InferenceEndpoint,
  backendModelId: string,
  inputPlur: bigint,
  outputPlur: bigint,
): boolean {
  endpoint.models = endpoint.models ?? {}
  const next: ModelPriceEntry = {
    inputBzz: plurToBzzExact(inputPlur),
    outputBzz: plurToBzzExact(outputPlur),
  }
  const cur = endpoint.models[backendModelId]
  if (cur && cur.inputBzz === next.inputBzz && cur.outputBzz === next.outputBzz) return false
  endpoint.models[backendModelId] = next
  return true
}

/** Reverse of `parseBzzToPlur` — render a PLUR bigint as a non-lossy BZZ
 *  decimal string. Suitable for round-tripping a UI edit back into JSON
 *  (unlike `formatXBZZ`, which truncates to 6 fractional digits for display). */
export function plurToBzzExact(plur: bigint): string {
  const SCALE = 10n ** 16n
  const negative = plur < 0n
  const abs = negative ? -plur : plur
  const whole = abs / SCALE
  const frac = abs % SCALE
  if (frac === 0n) return `${negative ? '-' : ''}${whole}`
  const fracStr = (frac + SCALE).toString().slice(1).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}.${fracStr}`
}
