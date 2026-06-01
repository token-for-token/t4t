/**
 * Hand-written ABIs for the three T4T contracts so the container builds
 * without a Forge artifact pipeline. Regenerate from `contracts/out/` if
 * the Solidity sources drift.
 */

export const providerRegistryAbi = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'pssPublicKey', type: 'bytes32'},
      {name: 'swarmOverlay', type: 'bytes32'},
      {name: 'metadataURI', type: 'string'},
      {name: 'initialStake', type: 'uint128'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'updateOfferings',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'offerings',
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
    outputs: [],
  },
  {type: 'function', name: 'heartbeat', stateMutability: 'nonpayable', inputs: [], outputs: []},
  {
    type: 'function',
    name: 'setMaxConcurrentJobs',
    stateMutability: 'nonpayable',
    inputs: [{name: 'cap', type: 'uint32'}],
    outputs: [],
  },
  {
    type: 'function',
    name: 'openJobs',
    stateMutability: 'view',
    inputs: [{name: 'owner', type: 'address'}],
    outputs: [{type: 'uint32'}],
  },
  {
    type: 'function',
    name: 'MIN_STAKE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{type: 'uint128'}],
  },
  {type: 'function', name: 'deactivate', stateMutability: 'nonpayable', inputs: [], outputs: []},
  {type: 'function', name: 'withdrawStake', stateMutability: 'nonpayable', inputs: [], outputs: []},
  {
    type: 'function',
    name: 'isLive',
    stateMutability: 'view',
    inputs: [{name: 'owner', type: 'address'}],
    outputs: [{type: 'bool'}],
  },
  {
    type: 'function',
    name: 'getProvider',
    stateMutability: 'view',
    inputs: [{name: 'owner', type: 'address'}],
    outputs: [
      {
        type: 'tuple',
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
  // Custom errors from ProviderRegistry.sol — surfaced when the gateway/provider
  // calls `register`, `addStake`, `slash` (via JobEscrow), etc.
  {type: 'error', name: 'EscrowAlreadySet', inputs: []},
  {type: 'error', name: 'NotEscrow', inputs: []},
  {type: 'error', name: 'NotOwner', inputs: []},
  {type: 'error', name: 'NotRegistered', inputs: []},
  {type: 'error', name: 'AlreadyRegistered', inputs: []},
  {type: 'error', name: 'InsufficientStake', inputs: []},
  {type: 'error', name: 'StillBonded', inputs: []},
  {type: 'error', name: 'StillActive', inputs: []},
  {type: 'error', name: 'OpenJobsRemain', inputs: []},
  {type: 'error', name: 'TransferFailed', inputs: []},
] as const

export const jobEscrowAbi = [
  {
    type: 'function',
    name: 'postJob',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'provider', type: 'address'},
      {name: 'requestHash', type: 'bytes32'},
      {name: 'modelId', type: 'string'},
      {name: 'maxPayment', type: 'uint128'},
      {name: 'deliveryDeadline', type: 'uint64'},
    ],
    outputs: [{name: 'jobId', type: 'bytes32'}],
  },
  {
    type: 'function',
    name: 'ackJob',
    stateMutability: 'nonpayable',
    inputs: [{name: 'jobId', type: 'bytes32'}],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claimJob',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'jobId', type: 'bytes32'},
      {name: 'responseHash', type: 'bytes32'},
      {name: 'actualPayment', type: 'uint128'},
      {name: 'clientSig', type: 'bytes'},
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'cancelJob',
    stateMutability: 'nonpayable',
    inputs: [{name: 'jobId', type: 'bytes32'}],
    outputs: [],
  },
  {
    type: 'function',
    name: 'timeoutJob',
    stateMutability: 'nonpayable',
    inputs: [{name: 'jobId', type: 'bytes32'}],
    outputs: [],
  },
  {
    type: 'function',
    name: 'jobs',
    stateMutability: 'view',
    inputs: [{name: 'jobId', type: 'bytes32'}],
    outputs: [
      {name: 'client', type: 'address'},
      {name: 'provider', type: 'address'},
      {name: 'requestHash', type: 'bytes32'},
      {name: 'responseHash', type: 'bytes32'},
      {name: 'modelId', type: 'string'},
      {name: 'maxPayment', type: 'uint128'},
      {name: 'postedAt', type: 'uint64'},
      {name: 'ackedAt', type: 'uint64'},
      {name: 'ackDeadline', type: 'uint64'},
      {name: 'deliveryDeadline', type: 'uint64'},
      {name: 'status', type: 'uint8'},
    ],
  },
  {
    type: 'event',
    name: 'JobPosted',
    inputs: [
      {name: 'jobId', type: 'bytes32', indexed: true},
      {name: 'client', type: 'address', indexed: true},
      {name: 'provider', type: 'address', indexed: true},
    ],
  },
  {
    type: 'event',
    name: 'JobClaimed',
    inputs: [
      {name: 'jobId', type: 'bytes32', indexed: true},
      {name: 'responseHash', type: 'bytes32'},
      {name: 'paid', type: 'uint128'},
    ],
  },
  // Custom errors from JobEscrow.sol — listed so viem can decode revert reasons
  // (`postJob`/`cancelJob`/`timeoutJob` failures otherwise surface as raw 4-byte
  // selectors like "0x5c975bda" instead of "BadStatus()").
  {type: 'error', name: 'NotProvider', inputs: []},
  {type: 'error', name: 'NotClient', inputs: []},
  {type: 'error', name: 'BadStatus', inputs: []},
  {type: 'error', name: 'DeadlinePassed', inputs: []},
  {type: 'error', name: 'DeadlineNotPassed', inputs: []},
  {type: 'error', name: 'PaymentTooHigh', inputs: []},
  {type: 'error', name: 'ProviderNotLive', inputs: []},
  {type: 'error', name: 'InsufficientStakeForJob', inputs: []},
  {type: 'error', name: 'TransferFailed', inputs: []},
  {type: 'error', name: 'BadDeadline', inputs: []},
] as const

export const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'spender', type: 'address'},
      {name: 'amount', type: 'uint256'},
    ],
    outputs: [{type: 'bool'}],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      {name: 'owner', type: 'address'},
      {name: 'spender', type: 'address'},
    ],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{name: 'owner', type: 'address'}],
    outputs: [{type: 'uint256'}],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'to', type: 'address'},
      {name: 'amount', type: 'uint256'},
    ],
    outputs: [{type: 'bool'}],
  },
] as const
