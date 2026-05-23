import {z} from 'zod'
import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'

const HexLike = z
  .string()
  .regex(/^0x[a-fA-F0-9]+$/, 'must be 0x-prefixed hex')
  .transform(s => s as `0x${string}`)

const Address = HexLike.refine(s => s.length === 42, 'must be 20-byte address')
const PrivateKey = HexLike.refine(s => s.length === 66, 'must be 32-byte hex private key')

/** Resolve the on-disk wallet file path — `WALLET_KEY_FILE` env wins, else
 *  `${T4T_DATA_DIR}/wallet.key`. The path is returned regardless of whether
 *  the file exists; callers check existence. */
export function walletKeyFilePath(dataDir: string): string {
  return process.env.WALLET_KEY_FILE ?? join(dataDir, 'wallet.key')
}

/** Return the configured wallet private key, or null if none is available
 *  yet. Order: WALLET_KEY env → WALLET_KEY_FILE env → ${T4T_DATA_DIR}/wallet.key. */
function readKey(dataDir: string): `0x${string}` | null {
  const direct = process.env.WALLET_KEY
  if (direct) return PrivateKey.parse(direct)
  const path = walletKeyFilePath(dataDir)
  if (existsSync(path)) return PrivateKey.parse(readFileSync(path, 'utf8').trim())
  return null
}

const BoolFlag = z
  .union([z.literal('true'), z.literal('false')])
  .transform(s => s === 'true')

// Built-in defaults for the live Gnosis-mainnet deployment. Override any of
// these in docker-compose (`environment:`) if you redeploy contracts or want
// to point at a different RPC.
const DEFAULT_GNOSIS_RPC_URL = 'https://rpc.gnosischain.com'
const DEFAULT_REGISTRY_ADDRESS = '0xf81121AAbc2F7261224BaDd0Ed871711e6D1371E'
const DEFAULT_ESCROW_ADDRESS = '0x34Db8E014E71928f17E23eC1272B602582222c9c'
const DEFAULT_XBZZ_ADDRESS = '0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da'

const Common = z.object({
  T4T_MODE: z.enum(['gateway', 'provider']),
  BEE_API_URL: z.string().url(),
  GNOSIS_RPC_URL: z.string().url().default(DEFAULT_GNOSIS_RPC_URL),
  REGISTRY_ADDRESS: Address.default(DEFAULT_REGISTRY_ADDRESS as `0x${string}`),
  ESCROW_ADDRESS: Address.default(DEFAULT_ESCROW_ADDRESS as `0x${string}`),
  XBZZ_ADDRESS: Address.default(DEFAULT_XBZZ_ADDRESS as `0x${string}`),
  // Optional — if unset, the container either auto-manages a batch
  // (T4T_STAMP_MANAGE=true, see below) or queries the connected Bee node for
  // a usable batch on startup. Operators only set this to pin a specific
  // batch ID across multiple stamps. Setting it explicitly also disables
  // container-managed stamps — the operator owns the lifecycle.
  POSTAGE_BATCH_ID: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  // Container-managed postage stamps (see docs/proposal-container-managed-stamps.md).
  // Defaults ON: when POSTAGE_BATCH_ID is unset, the container reuses an
  // existing labelled batch or buys one on first boot (xBZZ from the Bee
  // node's own wallet), auto-tops-up when remaining TTL drops below
  // T4T_STAMP_MIN_TTL_DAYS, and auto-dilutes when utilization crosses
  // T4T_STAMP_MAX_UTILIZATION. Set to "false" if you manage the batch
  // lifecycle yourself (e.g. via the Bee dashboard).
  T4T_STAMP_MANAGE: BoolFlag.default('true'),
  // Default depth: 24 gives 2^(24-16) = 256 chunks/bucket (4× headroom over
  // the old default of 22). Each +1 doubles per-chunk BZZ cost — depth 24 is
  // ~4× more BZZ than 22 for the same TTL, but stays usable for >100 jobs
  // before the auto-dilute below would trigger.
  T4T_STAMP_DEPTH: z.coerce.number().int().min(17).max(255).default(24),
  T4T_STAMP_TTL_DAYS: z.coerce.number().int().positive().default(30),
  T4T_STAMP_MIN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  T4T_STAMP_LABEL: z.string().default('t4t'),
  // Auto-dilute when utilization crosses this fraction. Free in BZZ terms,
  // but halves remaining TTL per +1 depth, so combined with the TTL top-up
  // it keeps the batch usable without operator intervention.
  T4T_STAMP_MAX_UTILIZATION: z.coerce.number().min(0).max(1).default(0.5),
  T4T_STAMP_MAX_DEPTH: z.coerce.number().int().min(17).max(255).default(28),
  // When true, the container logs the planned buy/top-up but never submits
  // the stamp tx. Useful to preview xBZZ cost without spending.
  T4T_STAMP_DRY_RUN: BoolFlag.default('false'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  T4T_DATA_DIR: z.string().default('/data'),
  T4T_PSS_KEY_PATH: z.string().optional(),
  // 0.0.0.0 = reachable from the docker host via the published port. Override
  // to 127.0.0.1 when running natively (npm run dev) on a shared machine.
  T4T_ADMIN_HOST: z.string().default('0.0.0.0'),
  T4T_ADMIN_PORT: z.coerce.number().int().positive().default(3000),
  T4T_STATUS_REFRESH_SECONDS: z.coerce.number().int().positive().default(10),
})

const CsvList = z.string().transform(s =>
  s
    .split(',')
    .map(t => t.trim())
    .filter(Boolean),
)

const Gateway = Common.extend({
  T4T_MODE: z.literal('gateway'),
  T4T_SELECTION_STRATEGY: z.enum(['cheapest', 'top_rep_cheapest', 'manual']).default('top_rep_cheapest'),
  // Optional cap on (input + output) wei per 1M tokens — providers above this are skipped.
  T4T_MAX_PRICE_PER_MILLION_TOKENS: z.coerce.bigint().optional(),
  // Per-job delivery deadline. Must comfortably exceed the contract's
  // ACK_WINDOW (30s) plus expected inference time plus mining latency. The
  // contract reverts postJob if `deliveryDeadline <= block.timestamp +
  // ACK_WINDOW` AT MINE TIME, so a tight 300s margin can race during slow
  // blocks. 900s gives ~15min, comfortable for current models.
  T4T_DEFAULT_DEADLINE_SECONDS: z.coerce.number().int().positive().default(900),
  T4T_FAKE_STREAMING: BoolFlag.default('true'),
  T4T_MANUAL_PROVIDER: Address.optional(),
  T4T_MODELS_CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(60),
  T4T_ALLOWED_MODELS: CsvList.optional(),
  T4T_MIN_PROVIDERS_PER_MODEL: z.coerce.number().int().positive().default(1),
  T4T_PERSIST_PAYLOADS: BoolFlag.default('false'),
  T4T_PAYLOAD_RETENTION_HOURS: z.coerce.number().int().positive().default(24),
  // When every candidate provider is at its advertised concurrency cap, the
  // gateway waits up to this many seconds (re-polling the registry) for one
  // to free a slot before failing the request. 0 = fail fast.
  T4T_PROVIDER_WAIT_SECONDS: z.coerce.number().int().nonnegative().default(120),
  // Poll interval used while waiting on capacity. Bounded below so a wide
  // wait window doesn't spam the RPC; bounded above so a freshly-freed slot
  // gets noticed quickly.
  T4T_PROVIDER_WAIT_POLL_SECONDS: z.coerce.number().int().positive().default(5),
  // Fallback completion-token cap when the request omits `max_tokens`. Sizes
  // the per-job escrow on the output side. Default 16384 covers GPT-4o /
  // Claude 3.5 class models; bump it for long-output proxies (GPT-5, Gemini
  // 2.x, reasoning models). The provider only claims the actual usage —
  // unused budget is refunded by the contract.
  T4T_DEFAULT_MAX_OUTPUT_TOKENS: z.coerce.bigint().default(16_384n),
  // Multiplicative safety buffer applied to both prompt and completion token
  // budgets when sizing the escrow. 0.2 = +20%. Padding absorbs tokenizer
  // drift (we estimate prompt tokens via chars/4) and small response
  // overruns. Stored as parts-per-million internally.
  T4T_ESCROW_HEADROOM_RATIO: z.coerce.number().min(0).max(10).default(0.2),
  // Optional per-job escrow ceiling (xBZZ wei). When set, the gateway
  // rejects a chat request with HTTP 413 if the computed maxPayment would
  // exceed this value, instead of locking that much xBZZ on-chain. Leave
  // unset to defer to wallet balance / allowance for the upper bound.
  T4T_MAX_ESCROW_PER_JOB: z.coerce.bigint().optional(),
})

const Provider = Common.extend({
  T4T_MODE: z.literal('provider'),
  // Inference endpoints are configured per-backend in ${T4T_DATA_DIR}/endpoints.json
  // (override with T4T_ENDPOINTS_FILE). The file is a JSON array of
  // {name, url, apiKey?} entries — see container/src/lib/endpoints.ts. Supports
  // mixing local backends (Ollama, vLLM) with hosted ones (OpenAI, …); the
  // first endpoint to advertise a given model id wins on collision.
  // Default prices (xBZZ wei per 1M tokens, input vs output) applied to newly-discovered
  // models. xBZZ has 16 decimals on Gnosis, so 1e16 wei = 1 BZZ. Per-model prices
  // live on-chain in ModelOffering and can be edited from the admin UI; these
  // defaults only kick in for first-seen models.
  T4T_INPUT_PRICE_DEFAULT: z.coerce.bigint().default(3_000_000_000_000_000n),  // 0.3 BZZ / 1M
  T4T_OUTPUT_PRICE_DEFAULT: z.coerce.bigint().default(15_000_000_000_000_000n), // 1.5 BZZ / 1M
  T4T_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  T4T_MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(2),
  T4T_DEACTIVATE_ON_SHUTDOWN: BoolFlag.default('false'),
})

// Admin subcommands (deactivate, withdraw-stake) only need chain credentials
// — not the endpoints file, offered models, or any client-only knobs. T4T_MODE
// is also dropped so operators can run `t4t deactivate` without their compose env loaded.
const Admin = Common.omit({T4T_MODE: true, POSTAGE_BATCH_ID: true}).extend({
  POSTAGE_BATCH_ID: Common.shape.POSTAGE_BATCH_ID.optional(),
})

export type GatewayConfig = z.infer<typeof Gateway> & {walletKey: `0x${string}` | null}
export type ProviderConfig = z.infer<typeof Provider> & {walletKey: `0x${string}` | null}
export type AdminConfig = z.infer<typeof Admin> & {walletKey: `0x${string}`}
export type Config = GatewayConfig | ProviderConfig

export function loadConfig(): Config {
  const mode = process.env.T4T_MODE
  if (mode === 'gateway') {
    const parsed = Gateway.parse(process.env)
    return {...parsed, walletKey: readKey(parsed.T4T_DATA_DIR)}
  }
  if (mode === 'provider') {
    const parsed = Provider.parse(process.env)
    return {...parsed, walletKey: readKey(parsed.T4T_DATA_DIR)}
  }
  throw new Error(`T4T_MODE must be "gateway" or "provider" (got ${mode ?? 'unset'})`)
}

export function loadAdminConfig(): AdminConfig {
  const parsed = Admin.parse(process.env)
  const walletKey = readKey(parsed.T4T_DATA_DIR)
  if (!walletKey) throw new Error('No wallet configured. Run `t4t` (web UI) to create or import one, or set WALLET_KEY.')
  return {...parsed, walletKey}
}
