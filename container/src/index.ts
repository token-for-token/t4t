#!/usr/bin/env node
import {loadConfig} from './lib/config'
import {logger} from './lib/logger'
import {runClient} from './modes/client/index'
import {runProvider} from './modes/provider/index'

async function main() {
  const cfg = loadConfig()
  logger.info({mode: cfg.T4T_MODE, registry: cfg.REGISTRY_ADDRESS}, 't4t starting')
  if (cfg.T4T_MODE === 'client') return runClient(cfg)
  return runProvider(cfg)
}

main().catch(err => {
  logger.fatal({err}, 't4t crashed')
  process.exit(1)
})
