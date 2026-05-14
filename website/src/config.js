// Edit these before deploying. Both are public values; safe to bundle.
export const config = {
  // Deployed on Gnosis Chain (chain 100).
  registryAddress: '0xf81121AAbc2F7261224BaDd0Ed871711e6D1371E',

  // Public Gnosis RPC. Must support CORS so the browser can call it.
  // rpc.gnosischain.com supports CORS; swap for a paid endpoint if you hit rate limits.
  rpcUrl: 'https://rpc.gnosischain.com',

  // Match ProviderRegistry.HEARTBEAT_TTL — providers stale past this drop from
  // the live set even if `active` is true on-chain.
  heartbeatTtlSeconds: 600,
}
