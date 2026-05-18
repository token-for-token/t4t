#!/usr/bin/env node
/**
 * Register an ENS .eth name via the v3 ETHRegistrarController. Two-step
 * commit-reveal:
 *
 *   node ens-register.mjs                    # dry run (simulate only)
 *   node ens-register.mjs --broadcast        # commit, wait 60s, then register
 *
 * Reads MNEMONIC, MNEMONIC_INDEX, ETH_RPC_URL, ENS_NAME from ../.env. Resumable:
 * after a successful commit, state is written to ens-register-<name>.json so a
 * re-run with --broadcast picks up at the register step. Commitments expire
 * after 24h.
 *
 * After registration, set the contenthash with ens-set-contenthash.mjs.
 */
import {createPublicClient, createWalletClient, http, parseAbi, parseEther} from 'viem'
import {mnemonicToAccount} from 'viem/accounts'
import {mainnet} from 'viem/chains'
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomBytes} from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))

function loadEnv(p) {
  const out = {}
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

const env = loadEnv(resolve(HERE, '..', '.env'))
const RPC = process.env.ETH_RPC_URL ?? env.ETH_RPC_URL
const MNEMONIC = process.env.MNEMONIC ?? env.MNEMONIC
const IDX = Number(process.env.MNEMONIC_INDEX ?? env.MNEMONIC_INDEX ?? 0)
const FULL = (process.env.ENS_NAME ?? env.ENS_NAME ?? 't4t.eth').toLowerCase()
const NAME = FULL.replace(/\.eth$/, '')
const DURATION = BigInt(Number(process.env.ENS_DURATION_SEC ?? 31536000))

if (!RPC) { console.error('ETH_RPC_URL not set.'); process.exit(1) }
if (!MNEMONIC) { console.error('MNEMONIC not set.'); process.exit(1) }
if (FULL === NAME) { console.error('ENS_NAME must end in .eth (got "' + FULL + '")'); process.exit(1) }

const broadcast = process.argv.includes('--broadcast')

const CONTROLLER = '0x253553366Da8546fC250F225fe3d25d0C782303b'  // ETHRegistrarController v3
const RESOLVER   = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63'  // PublicResolver v3

const controllerAbi = parseAbi([
  'function available(string) view returns (bool)',
  'function rentPrice(string,uint256) view returns ((uint256,uint256))',
  'function minCommitmentAge() view returns (uint256)',
  'function maxCommitmentAge() view returns (uint256)',
  'function commitments(bytes32) view returns (uint256)',
  'function makeCommitment(string,address,uint256,bytes32,address,bytes[],bool,uint16) pure returns (bytes32)',
  'function commit(bytes32) external',
  'function register(string,address,uint256,bytes32,address,bytes[],bool,uint16) external payable',
])

const account = mnemonicToAccount(MNEMONIC, {addressIndex: IDX})
const pub = createPublicClient({chain: mainnet, transport: http(RPC)})
const wallet = createWalletClient({chain: mainnet, transport: http(RPC), account})

const stateFile = resolve(HERE, `ens-register-${NAME}.json`)
let state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null

console.log('name        :', FULL)
console.log('owner       :', account.address)
console.log('duration    :', Number(DURATION) + 's  (' + (Number(DURATION) / 86400 / 365).toFixed(2) + ' years)')

const [available, rent, minAge, maxAge] = await Promise.all([
  pub.readContract({address: CONTROLLER, abi: controllerAbi, functionName: 'available', args: [NAME]}),
  pub.readContract({address: CONTROLLER, abi: controllerAbi, functionName: 'rentPrice', args: [NAME, DURATION]}),
  pub.readContract({address: CONTROLLER, abi: controllerAbi, functionName: 'minCommitmentAge'}),
  pub.readContract({address: CONTROLLER, abi: controllerAbi, functionName: 'maxCommitmentAge'}),
])
const [base, premium] = rent
const price = base + premium

console.log('available   :', available)
console.log('base price  :', base + ' wei')
console.log('premium     :', premium + ' wei')
console.log('TOTAL price :', price + ' wei  (' + (Number(price) / 1e18).toFixed(4) + ' ETH)')
console.log('minCommit   :', minAge + 's')
console.log('maxCommit   :', maxAge + 's (commitment expiry)')

if (!available) { console.error('Name not available.'); process.exit(1) }

const bal = await pub.getBalance({address: account.address})
console.log('wallet bal  :', bal + ' wei  (' + (Number(bal) / 1e18).toFixed(4) + ' ETH)')
const need = price + parseEther('0.01')
if (bal < need) {
  console.error('Insufficient balance — need ≥ ' + (Number(need) / 1e18).toFixed(4) + ' ETH (price + 0.01 ETH gas headroom).')
  if (broadcast) process.exit(1)
  console.log('(continuing in dry-run to show full plan)')
}

const secret = state?.secret ?? ('0x' + randomBytes(32).toString('hex'))
const data = []
const reverseRecord = false
const fuses = 0

const commitment = await pub.readContract({
  address: CONTROLLER, abi: controllerAbi, functionName: 'makeCommitment',
  args: [NAME, account.address, DURATION, secret, RESOLVER, data, reverseRecord, fuses],
})
console.log('commitment  :', commitment)

const onchainCommit = await pub.readContract({
  address: CONTROLLER, abi: controllerAbi, functionName: 'commitments', args: [commitment],
})

// ── STEP 1: commit ──
if (onchainCommit === 0n) {
  console.log('\n── STEP 1: commit ──')
  await pub.simulateContract({
    address: CONTROLLER, abi: controllerAbi, functionName: 'commit', args: [commitment], account,
  })
  console.log('simulation OK.')
  if (!broadcast) {
    console.log('Dry run — pass --broadcast to send the commit tx.')
    process.exit(0)
  }
  const txHash = await wallet.writeContract({
    address: CONTROLLER, abi: controllerAbi, functionName: 'commit', args: [commitment],
  })
  console.log('commit tx   :', txHash)
  console.log('             https://etherscan.io/tx/' + txHash)
  const rcp = await pub.waitForTransactionReceipt({hash: txHash})
  console.log('confirmed   : block', rcp.blockNumber, 'status', rcp.status)
  state = {
    name: NAME, secret,
    commitTxHash: txHash,
    commitBlock: Number(rcp.blockNumber),
    commitTimestamp: Math.floor(Date.now() / 1000),
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  console.log('state saved →', stateFile)
} else {
  console.log('\ncommit already on-chain at block timestamp', onchainCommit.toString())
  const age = BigInt(Math.floor(Date.now() / 1000)) - onchainCommit
  console.log('commit age  :', age + 's')
  if (age > maxAge) {
    console.error('commitment expired (> ' + maxAge + 's). Delete ' + stateFile + ' and re-run.')
    process.exit(1)
  }
  if (!state) state = {name: NAME, secret, commitTimestamp: Number(onchainCommit)}
}

// ── STEP 2: wait + register ──
console.log('\n── STEP 2: register ──')
const targetTime = state.commitTimestamp + Number(minAge) + 5
let now = Math.floor(Date.now() / 1000)
while (now < targetTime) {
  const left = targetTime - now
  process.stdout.write('\r  waiting minCommitmentAge — ' + left + 's remaining …   ')
  await new Promise(r => setTimeout(r, 1000))
  now = Math.floor(Date.now() / 1000)
}
process.stdout.write('\n')

const value = (price * 105n) / 100n  // 5% headroom; controller refunds excess
await pub.simulateContract({
  address: CONTROLLER, abi: controllerAbi, functionName: 'register',
  args: [NAME, account.address, DURATION, secret, RESOLVER, data, reverseRecord, fuses],
  value, account,
})
console.log('simulation OK.')
if (!broadcast) {
  console.log('Dry run — pass --broadcast to send the register tx.')
  process.exit(0)
}
const txHash = await wallet.writeContract({
  address: CONTROLLER, abi: controllerAbi, functionName: 'register',
  args: [NAME, account.address, DURATION, secret, RESOLVER, data, reverseRecord, fuses],
  value,
})
console.log('register tx :', txHash)
console.log('             https://etherscan.io/tx/' + txHash)
const rcp = await pub.waitForTransactionReceipt({hash: txHash})
console.log('confirmed   : block', rcp.blockNumber, 'status', rcp.status)

console.log('\n✓ ' + FULL + ' registered to ' + account.address)
console.log('next        : node deploy-swarm.mjs       # get contenthash')
console.log('              node ens-set-contenthash.mjs 0xe40101… --broadcast')

try { rmSync(stateFile) } catch {}
