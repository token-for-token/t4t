import {afterEach, describe, expect, it} from 'vitest'
import {loadAdminConfig, loadConfig} from '../src/lib/config'

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const ADDR = '0x0000000000000000000000000000000000000001'
const BATCH = 'a'.repeat(64)

const PROVIDER_ENV = {
  T4T_MODE: 'provider',
  BEE_API_URL: 'http://bee:1633',
  GNOSIS_RPC_URL: 'http://rpc:8545',
  REGISTRY_ADDRESS: ADDR,
  ESCROW_ADDRESS: ADDR,
  XBZZ_ADDRESS: ADDR,
  POSTAGE_BATCH_ID: BATCH,
  T4T_OFFERED_MODELS: 'llama3:8b',
  T4T_PRICE_PER_KTOKEN_DEFAULT: '1000',
  WALLET_KEY: KEY,
} as Record<string, string>

function withEnv(env: Record<string, string>, fn: () => void) {
  const orig = {...process.env}
  for (const k of Object.keys(process.env)) delete process.env[k]
  Object.assign(process.env, env)
  try {
    fn()
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, orig)
  }
}

afterEach(() => {
  // safety net — withEnv already restores, but vitest workers share globals
})

describe('loadConfig (provider)', () => {
  it('defaults T4T_DEACTIVATE_ON_SHUTDOWN to false', () => {
    withEnv(PROVIDER_ENV, () => {
      const cfg = loadConfig()
      expect(cfg.T4T_MODE).toBe('provider')
      if (cfg.T4T_MODE !== 'provider') throw new Error('narrow')
      expect(cfg.T4T_DEACTIVATE_ON_SHUTDOWN).toBe(false)
    })
  })

  it('parses T4T_DEACTIVATE_ON_SHUTDOWN=true', () => {
    withEnv({...PROVIDER_ENV, T4T_DEACTIVATE_ON_SHUTDOWN: 'true'}, () => {
      const cfg = loadConfig()
      if (cfg.T4T_MODE !== 'provider') throw new Error('narrow')
      expect(cfg.T4T_DEACTIVATE_ON_SHUTDOWN).toBe(true)
    })
  })

  it('rejects non-boolean T4T_DEACTIVATE_ON_SHUTDOWN', () => {
    withEnv({...PROVIDER_ENV, T4T_DEACTIVATE_ON_SHUTDOWN: 'yes'}, () => {
      expect(() => loadConfig()).toThrow()
    })
  })
})

describe('loadAdminConfig', () => {
  it('parses without T4T_MODE, OLLAMA_URL, or offered models', () => {
    withEnv(
      {
        BEE_API_URL: 'http://bee:1633',
        GNOSIS_RPC_URL: 'http://rpc:8545',
        REGISTRY_ADDRESS: ADDR,
        ESCROW_ADDRESS: ADDR,
        XBZZ_ADDRESS: ADDR,
        WALLET_KEY: KEY,
      },
      () => {
        const cfg = loadAdminConfig()
        expect(cfg.REGISTRY_ADDRESS).toBe(ADDR)
        expect(cfg.walletKey).toBe(KEY)
      },
    )
  })

  it('still requires the wallet key', () => {
    withEnv(
      {
        BEE_API_URL: 'http://bee:1633',
        GNOSIS_RPC_URL: 'http://rpc:8545',
        REGISTRY_ADDRESS: ADDR,
        ESCROW_ADDRESS: ADDR,
        XBZZ_ADDRESS: ADDR,
      },
      () => {
        expect(() => loadAdminConfig()).toThrow(/WALLET_KEY/)
      },
    )
  })
})
