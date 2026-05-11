#!/usr/bin/env node
import {loadAdminConfig, loadConfig, type AdminConfig} from './lib/config'
import {deactivateProvider, getProvider, makeChain, withdrawStake} from './lib/chain'
import {logger} from './lib/logger'
import {runClient} from './modes/client/index'
import {runProvider} from './modes/provider/index'

const USAGE = `t4t — Token4Token container

Usage:
  t4t                       Run client or provider per T4T_MODE
  t4t deactivate            Stop accepting jobs; start unbonding (provider)
  t4t withdraw-stake        Reclaim stake after unbonding completes (provider)
  t4t help                  Show this message
`

async function main() {
  const [, , subcommand] = process.argv
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(USAGE)
    return
  }
  if (subcommand === 'deactivate') return runDeactivate()
  if (subcommand === 'withdraw-stake') return runWithdrawStake()
  if (subcommand && !subcommand.startsWith('-')) {
    process.stderr.write(`unknown subcommand: ${subcommand}\n\n${USAGE}`)
    process.exit(2)
  }

  const cfg = loadConfig()
  logger.info({mode: cfg.T4T_MODE, registry: cfg.REGISTRY_ADDRESS}, 't4t starting')
  if (cfg.T4T_MODE === 'client') return runClient(cfg)
  return runProvider(cfg)
}

function makeAdminChain(cfg: AdminConfig) {
  return makeChain({
    rpcUrl: cfg.GNOSIS_RPC_URL,
    privateKey: cfg.walletKey,
    registry: cfg.REGISTRY_ADDRESS,
    escrow: cfg.ESCROW_ADDRESS,
    xbzz: cfg.XBZZ_ADDRESS,
  })
}

async function runDeactivate() {
  const cfg = loadAdminConfig()
  const log = logger.child({cmd: 'deactivate'})
  const chain = makeAdminChain(cfg)
  const p = await getProvider(chain, chain.address)
  if (!p.owner || p.owner === '0x0000000000000000000000000000000000000000') {
    log.error({address: chain.address}, 'wallet is not a registered provider')
    process.exit(1)
  }
  if (!p.active) {
    log.info({address: chain.address}, 'already inactive; nothing to do')
    return
  }
  const tx = await deactivateProvider(chain)
  log.info({tx, address: chain.address}, 'deactivate tx sent — unbonding has begun')
}

async function runWithdrawStake() {
  const cfg = loadAdminConfig()
  const log = logger.child({cmd: 'withdraw-stake'})
  const chain = makeAdminChain(cfg)
  const p = await getProvider(chain, chain.address)
  if (!p.owner || p.owner === '0x0000000000000000000000000000000000000000') {
    log.error({address: chain.address}, 'wallet is not a registered provider')
    process.exit(1)
  }
  if (p.active) {
    log.error('provider is still active; call `t4t deactivate` first')
    process.exit(1)
  }
  const tx = await withdrawStake(chain)
  log.info({tx, stake: p.stake.toString()}, 'withdraw tx sent')
}

main().catch(err => {
  logger.fatal({err}, 't4t crashed')
  process.exit(1)
})
