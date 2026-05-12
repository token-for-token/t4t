import {z} from 'zod'
import {readFileSync} from 'node:fs'

const HexLike = z
  .string()
  .regex(/^0x[a-fA-F0-9]+$/, 'must be 0x-prefixed hex')
  .transform(s => s as `0x${string}`)

const Address = HexLike.refine(s => s.length === 42, 'must be 20-byte address')
const PrivateKey = HexLike.refine(s => s.length === 66, 'must be 32-byte hex private key')

function readKey(): `0x${string}` {
  const direct = process.env.WALLET_KEY
  if (direct) return PrivateKey.parse(direct)
  const file = process.env.WALLET_KEY_FILE
  if (file) return PrivateKey.parse(readFileSync(file, 'utf8').trim())
  throw new Error('Set WALLET_KEY or WALLET_KEY_FILE')
}

const BoolFlag = z
  .union([z.literal('true'), z.literal('false')])
  .transform(s => s === 'true')

const Common = z.object({
  T4T_MODE: z.enum(['client', 'provider']),
  BEE_API_URL: z.string().url(),
  GNOSIS_RPC_URL: z.string().url(),
  REGISTRY_ADDRESS: Address,
  ESCROW_ADDRESS: Address,
  XBZZ_ADDRESS: Address,
  POSTAGE_BATCH_ID: z.string().regex(/^[0-9a-fA-F]{64}$/),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  T4T_DATA_DIR: z.string().default('/data'),
  T4T_PSS_KEY_PATH: z.string().optional(),
  T4T_ADMIN_HOST: z.string().default('127.0.0.1'),
  T4T_ADMIN_PORT: z.coerce.number().int().positive().default(8090),
  T4T_STATUS_REFRESH_SECONDS: z.coerce.number().int().positive().default(10),
})

const CsvList = z.string().transform(s =>
  s
    .split(',')
    .map(t => t.trim())
    .filter(Boolean),
)

const Client = Common.extend({
  T4T_HTTP_PORT: z.coerce.number().int().positive().default(8080),
  T4T_SELECTION_STRATEGY: z.enum(['cheapest', 'top_rep_cheapest', 'manual']).default('top_rep_cheapest'),
  // Optional cap on (input + output) wei per 1M tokens — providers above this are skipped.
  T4T_MAX_PRICE_PER_MILLION_TOKENS: z.coerce.bigint().optional(),
  T4T_DEFAULT_DEADLINE_SECONDS: z.coerce.number().int().positive().default(300),
  T4T_FAKE_STREAMING: BoolFlag.default('true'),
  T4T_MANUAL_PROVIDER: Address.optional(),
  T4T_MODELS_CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(60),
  T4T_ALLOWED_MODELS: CsvList.optional(),
  T4T_MIN_PROVIDERS_PER_MODEL: z.coerce.number().int().positive().default(1),
  T4T_PERSIST_PAYLOADS: BoolFlag.default('false'),
  T4T_PAYLOAD_RETENTION_HOURS: z.coerce.number().int().positive().default(24),
})

const Provider = Common.extend({
  // OpenAI-compatible inference backend (Ollama, vLLM, LiteLLM, llama.cpp, OpenAI itself).
  // Default points at host's Ollama (port 11434); for vLLM use the vLLM server URL (typically :8000).
  OPENAI_BASE_URL: z.string().url().default('http://host.docker.internal:11434'),
  OPENAI_API_KEY: z.string().optional(),
  // Default prices (xBZZ wei per 1M tokens, input vs output) applied to newly-discovered
  // models. Per-model prices live on-chain in ModelOffering and can be edited from the
  // admin UI; these defaults only kick in for first-seen models.
  T4T_INPUT_PRICE_DEFAULT: z.coerce.bigint(),
  T4T_OUTPUT_PRICE_DEFAULT: z.coerce.bigint(),
  T4T_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  T4T_MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(2),
  T4T_DEACTIVATE_ON_SHUTDOWN: BoolFlag.default('false'),
})

// Admin subcommands (deactivate, withdraw-stake) only need chain credentials
// — not OPENAI_BASE_URL, offered models, or any client-only knobs. T4T_MODE is
// also dropped so operators can run `t4t deactivate` without their compose env loaded.
const Admin = Common.omit({T4T_MODE: true, POSTAGE_BATCH_ID: true}).extend({
  POSTAGE_BATCH_ID: Common.shape.POSTAGE_BATCH_ID.optional(),
})

export type ClientConfig = z.infer<typeof Client> & {walletKey: `0x${string}`}
export type ProviderConfig = z.infer<typeof Provider> & {walletKey: `0x${string}`}
export type AdminConfig = z.infer<typeof Admin> & {walletKey: `0x${string}`}
export type Config = ClientConfig | ProviderConfig

export function loadConfig(): Config {
  const mode = process.env.T4T_MODE
  const walletKey = readKey()
  if (mode === 'client') return {...Client.parse(process.env), walletKey}
  if (mode === 'provider') return {...Provider.parse(process.env), walletKey}
  throw new Error(`T4T_MODE must be "client" or "provider" (got ${mode ?? 'unset'})`)
}

export function loadAdminConfig(): AdminConfig {
  return {...Admin.parse(process.env), walletKey: readKey()}
}
