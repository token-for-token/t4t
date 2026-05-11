import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import {privateKeyToAccount} from 'viem/accounts'
import {gnosis, gnosisChiado} from 'viem/chains'
import {erc20Abi, jobEscrowAbi, providerRegistryAbi} from './abi'
import type {ModelOffering, ProviderRow} from './types'

/** Mirrors `JobEscrow.ACK_WINDOW` (spec §3). Used by the client to schedule
 *  the no-ack cancel deadline locally. Keep in sync with the contract. */
export const ACK_WINDOW_SECONDS = 30

export interface ChainClient {
  pub: PublicClient
  wallet: WalletClient
  address: Address
  registry: Address
  escrow: Address
  xbzz: Address
}

export interface ChainOpts {
  rpcUrl: string
  privateKey: Hex
  registry: Address
  escrow: Address
  xbzz: Address
  chainId?: number
}

export function makeChain(opts: ChainOpts): ChainClient {
  const account = privateKeyToAccount(opts.privateKey)
  const chain = opts.chainId === 10200 ? gnosisChiado : gnosis
  const transport = http(opts.rpcUrl)
  return {
    pub: createPublicClient({chain, transport}),
    wallet: createWalletClient({chain, transport, account}),
    address: account.address,
    registry: opts.registry,
    escrow: opts.escrow,
    xbzz: opts.xbzz,
  }
}

// ---------- ProviderRegistry ----------

export async function registerProvider(
  c: ChainClient,
  args: {
    pssPublicKey: Hex
    swarmOverlay: Hex
    metadataURI: string
    initialStake: bigint
  },
): Promise<Hex> {
  return c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'register',
    args: [args.pssPublicKey as `0x${string}`, args.swarmOverlay as `0x${string}`, args.metadataURI, args.initialStake],
  })
}

export async function updateOfferings(c: ChainClient, offerings: ModelOffering[]): Promise<Hex> {
  return c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'updateOfferings',
    args: [offerings],
  })
}

export async function sendHeartbeat(c: ChainClient): Promise<Hex> {
  return c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'heartbeat',
    args: [],
  })
}

export async function deactivateProvider(c: ChainClient): Promise<Hex> {
  return c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'deactivate',
    args: [],
  })
}

export async function withdrawStake(c: ChainClient): Promise<Hex> {
  return c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'withdrawStake',
    args: [],
  })
}

export async function getProvider(c: ChainClient, owner: Address): Promise<ProviderRow> {
  const raw = await c.pub.readContract({
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'getProvider',
    args: [owner],
  })
  return raw as unknown as ProviderRow
}

export async function getOfferings(c: ChainClient, owner: Address): Promise<ModelOffering[]> {
  const raw = await c.pub.readContract({
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'getOfferings',
    args: [owner],
  })
  return raw as unknown as ModelOffering[]
}

export async function listProviders(
  c: ChainClient,
  cursor = 0n,
  limit = 50n,
): Promise<{page: ProviderRow[]; nextCursor: bigint}> {
  const [page, nextCursor] = (await c.pub.readContract({
    address: c.registry,
    abi: providerRegistryAbi,
    functionName: 'listProviders',
    args: [cursor, limit],
  })) as unknown as [ProviderRow[], bigint]
  return {page, nextCursor}
}

// ---------- JobEscrow ----------

export async function postJob(
  c: ChainClient,
  args: {
    provider: Address
    requestHash: Hex
    modelId: string
    maxPayment: bigint
    deliveryDeadline: number
  },
): Promise<{txHash: Hex; jobId: Hex}> {
  const txHash = await c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.escrow,
    abi: jobEscrowAbi,
    functionName: 'postJob',
    args: [args.provider, args.requestHash, args.modelId, args.maxPayment, BigInt(args.deliveryDeadline)],
  })
  const receipt = await c.pub.waitForTransactionReceipt({hash: txHash})
  const events = parseEventLogs({abi: jobEscrowAbi, eventName: 'JobPosted', logs: receipt.logs})
  const ev = events[0]
  if (!ev) throw new Error('postJob: JobPosted event missing from receipt')
  return {txHash, jobId: ev.args.jobId as Hex}
}

export async function ackJob(c: ChainClient, jobId: Hex): Promise<Hex> {
  return c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.escrow,
    abi: jobEscrowAbi,
    functionName: 'ackJob',
    args: [jobId],
  })
}

export async function readJob(
  c: ChainClient,
  jobId: Hex,
): Promise<{
  client: Address
  provider: Address
  requestHash: Hex
  responseHash: Hex
  modelId: string
  maxPayment: bigint
  postedAt: bigint
  ackedAt: bigint
  ackDeadline: bigint
  deliveryDeadline: bigint
  status: number
}> {
  const raw = (await c.pub.readContract({
    address: c.escrow,
    abi: jobEscrowAbi,
    functionName: 'jobs',
    args: [jobId],
  })) as readonly [Address, Address, Hex, Hex, string, bigint, bigint, bigint, bigint, bigint, number]
  return {
    client: raw[0],
    provider: raw[1],
    requestHash: raw[2],
    responseHash: raw[3],
    modelId: raw[4],
    maxPayment: raw[5],
    postedAt: raw[6],
    ackedAt: raw[7],
    ackDeadline: raw[8],
    deliveryDeadline: raw[9],
    status: raw[10],
  }
}

export async function cancelJob(c: ChainClient, jobId: Hex): Promise<Hex> {
  return c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.escrow,
    abi: jobEscrowAbi,
    functionName: 'cancelJob',
    args: [jobId],
  })
}

export async function timeoutJob(c: ChainClient, jobId: Hex): Promise<Hex> {
  return c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.escrow,
    abi: jobEscrowAbi,
    functionName: 'timeoutJob',
    args: [jobId],
  })
}

export async function claimJob(
  c: ChainClient,
  args: {jobId: Hex; responseHash: Hex; actualPayment: bigint; clientSig?: Hex},
): Promise<Hex> {
  return c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.escrow,
    abi: jobEscrowAbi,
    functionName: 'claimJob',
    args: [args.jobId, args.responseHash, args.actualPayment, args.clientSig ?? '0x'],
  })
}

// ---------- xBZZ ----------

export async function ensureAllowance(
  c: ChainClient,
  spender: Address,
  needed: bigint,
): Promise<void> {
  const current = (await c.pub.readContract({
    address: c.xbzz,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [c.address, spender],
  })) as bigint
  if (current >= needed) return
  await c.wallet.writeContract({
    chain: c.wallet.chain!,
    account: c.wallet.account!,
    address: c.xbzz,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, 2n ** 256n - 1n],
  })
}
