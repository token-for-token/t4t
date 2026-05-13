// Edit these before deploying. Both are public values; safe to bundle.
export const config = {
  // Address of the deployed ProviderRegistry on Gnosis Chain.
  // Set this after `forge script Deploy` and before running `npm run build`.
  registryAddress: '0x0000000000000000000000000000000000000000',

  // Public Gnosis RPC. Must support CORS so the browser can call it.
  // rpc.gnosischain.com supports CORS; swap for a paid endpoint if you hit rate limits.
  rpcUrl: 'https://rpc.gnosischain.com',

  // Match ProviderRegistry.HEARTBEAT_TTL — providers stale past this drop from
  // the live set even if `active` is true on-chain.
  heartbeatTtlSeconds: 600,
}
