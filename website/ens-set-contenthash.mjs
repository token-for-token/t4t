#!/usr/bin/env node
/**
 * Set the EIP-1577 contenthash on an ENS name. Pair with `deploy-swarm.mjs`:
 *
 *   node deploy-swarm.mjs                     # upload to Swarm, print contenthash
 *   node ens-set-contenthash.mjs 0xe40101…    # simulate the ENS update
 *   node ens-set-contenthash.mjs 0xe40101… --broadcast   # actually send the tx
 *
 * Reads MNEMONIC, MNEMONIC_INDEX, ETH_RPC_URL from ../.env (the project root).
 * Calls PublicResolver.setContenthash on Ethereum mainnet. The wallet derived
 * from your mnemonic must own the ENS name (or be its authorised manager).
 */
import {createPublicClient, createWalletClient, http, namehash, parseAbi} from 'viem'
import {mnemonicToAccount} from 'viem/accounts'
import {mainnet} from 'viem/chains'
import {readFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function loadEnv(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

const env = loadEnv(resolve(HERE, '..', '.env'))
const RPC = process.env.ETH_RPC_URL ?? env.ETH_RPC_URL
const MNEMONIC = process.env.MNEMONIC ?? env.MNEMONIC
const IDX = Number(process.env.MNEMONIC_INDEX ?? env.MNEMONIC_INDEX ?? 0)
const NAME = process.env.ENS_NAME ?? env.ENS_NAME ?? 't4t.eth'

if (!RPC) {
  console.error('ETH_RPC_URL not set (in env or .env).')
  process.exit(1)
}
if (!MNEMONIC) {
  console.error('MNEMONIC not set (in env or .env).')
  process.exit(1)
}

const contenthash = process.argv.find(a => a.startsWith('0xe40101'))
const broadcast = process.argv.includes('--broadcast')
if (!contenthash) {
  console.error('Usage: node ens-set-contenthash.mjs <0xe40101…> [--broadcast]')
  process.exit(1)
}

const account = mnemonicToAccount(MNEMONIC, {addressIndex: IDX})
const pub = createPublicClient({chain: mainnet, transport: http(RPC)})
const wallet = createWalletClient({chain: mainnet, transport: http(RPC), account})

const REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
const node = namehash(NAME)

console.log('ENS name        :', NAME)
console.log('namehash        :', node)
console.log('Sender (idx ' + IDX + '):', account.address)
console.log('New contenthash :', contenthash)

const registryAbi = parseAbi([
  'function resolver(bytes32) view returns (address)',
  'function owner(bytes32) view returns (address)',
])
const resolver = await pub.readContract({
  address: REGISTRY,
  abi: registryAbi,
  functionName: 'resolver',
  args: [node],
})
const owner = await pub.readContract({
  address: REGISTRY,
  abi: registryAbi,
  functionName: 'owner',
  args: [node],
})
console.log('Owner           :', owner)
console.log('Resolver        :', resolver)

if (resolver === '0x0000000000000000000000000000000000000000') {
  console.error('No resolver set on this name. Open https://app.ens.domains/' + NAME + ' and set one first.')
  process.exit(1)
}

const resolverAbi = parseAbi([
  'function contenthash(bytes32) view returns (bytes)',
  'function setContenthash(bytes32, bytes) external',
])
const current = await pub.readContract({
  address: resolver,
  abi: resolverAbi,
  functionName: 'contenthash',
  args: [node],
}).catch(() => '0x')
console.log('Current value   :', current)

if (current.toLowerCase() === contenthash.toLowerCase()) {
  console.log('\n✓ Already set to this contenthash. Nothing to do.')
  process.exit(0)
}

// Simulate first — surfaces NotAuthorised / wrong wallet without broadcasting.
console.log('\nSimulating setContenthash …')
await pub.simulateContract({
  address: resolver,
  abi: resolverAbi,
  functionName: 'setContenthash',
  args: [node, contenthash],
  account,
})
console.log('Simulation OK.')

if (!broadcast) {
  console.log('\nDry run — add --broadcast to send the tx.')
  process.exit(0)
}

console.log('\nBroadcasting…')
const txHash = await wallet.writeContract({
  address: resolver,
  abi: resolverAbi,
  functionName: 'setContenthash',
  args: [node, contenthash],
})
console.log('Tx sent:', txHash)
console.log('       https://etherscan.io/tx/' + txHash)
console.log('\nWaiting for confirmation…')
const receipt = await pub.waitForTransactionReceipt({hash: txHash})
console.log('Confirmed in block', receipt.blockNumber, 'status', receipt.status)
