// Subset of ProviderRegistry ABI — only the read functions the website needs.
// Mirror of container/src/lib/abi.ts. If the Solidity surface changes, sync both.
export const providerRegistryAbi = [
  {
    type: 'function',
    name: 'listProviders',
    stateMutability: 'view',
    inputs: [
      {name: 'cursor', type: 'uint256'},
      {name: 'limit', type: 'uint256'},
    ],
    outputs: [
      {
        type: 'tuple[]',
        components: [
          {name: 'owner', type: 'address'},
          {name: 'pssPublicKey', type: 'bytes32'},
          {name: 'swarmOverlay', type: 'bytes32'},
          {name: 'metadataURI', type: 'string'},
          {name: 'stake', type: 'uint128'},
          {name: 'lastHeartbeat', type: 'uint64'},
          {name: 'totalJobs', type: 'uint32'},
          {name: 'successfulJobs', type: 'uint32'},
          {name: 'active', type: 'bool'},
          {name: 'maxConcurrentJobs', type: 'uint32'},
        ],
      },
      {name: 'nextCursor', type: 'uint256'},
    ],
  },
  {
    type: 'function',
    name: 'getOfferings',
    stateMutability: 'view',
    inputs: [{name: 'owner', type: 'address'}],
    outputs: [
      {
        type: 'tuple[]',
        components: [
          {name: 'modelId', type: 'string'},
          {name: 'inputPricePerMillionTokens', type: 'uint128'},
          {name: 'outputPricePerMillionTokens', type: 'uint128'},
          {name: 'maxContextTokens', type: 'uint128'},
          {name: 'maxLatencySeconds', type: 'uint64'},
        ],
      },
    ],
  },
]
