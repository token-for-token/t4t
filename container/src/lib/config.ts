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

const Common = z.object({
  T4T_MODE: z.enum(['client', 'provider']),
  BEE_API_URL: z.string().url(),
  GNOSIS_RPC_URL: z.string().url(),
  REGISTRY_ADDRESS: Address,
  ESCROW_ADDRESS: Address,
  XBZZ_ADDRESS: Address,
  POSTAGE_BATCH_ID: z.string().regex(/^[0-9a-fA-F]{64}$/),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

const Client = Common.extend({
  T4T_HTTP_PORT: z.coerce.number().int().positive().default(8080),
  T4T_SELECTION_STRATEGY: z.enum(['cheapest', 'top_rep_cheapest', 'manual']).default('top_rep_cheapest'),
  T4T_MAX_PRICE_PER_KTOKEN: z.coerce.bigint().optional(),
  T4T_DEFAULT_DEADLINE_SECONDS: z.coerce.number().int().positive().default(300),
  T4T_FAKE_STREAMING: z
    .union([z.literal('true'), z.literal('false')])
    .transform(s => s === 'true')
    .default('true'),
  T4T_MANUAL_PROVIDER: Address.optional(),
})

const Provider = Common.extend({
  OLLAMA_URL: z.string().url().default('http://host.docker.internal:11434'),
  T4T_OFFERED_MODELS: z.string().min(1),
  T4T_PRICE_PER_KTOKEN_DEFAULT: z.coerce.bigint(),
  T4T_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  T4T_MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(2),
})

export type ClientConfig = z.infer<typeof Client> & {walletKey: `0x${string}`}
export type ProviderConfig = z.infer<typeof Provider> & {walletKey: `0x${string}`}
export type Config = ClientConfig | ProviderConfig

export function loadConfig(): Config {
  const mode = process.env.T4T_MODE
  const walletKey = readKey()
  if (mode === 'client') return {...Client.parse(process.env), walletKey}
  if (mode === 'provider') return {...Provider.parse(process.env), walletKey}
  throw new Error(`T4T_MODE must be "client" or "provider" (got ${mode ?? 'unset'})`)
}
