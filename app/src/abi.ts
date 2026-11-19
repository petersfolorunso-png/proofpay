// Generated from contracts/out by scripts/gen-abi.sh. Do not edit by hand.
export const escrowAbi = [
 {
  "type": "constructor",
  "inputs": [
   {
    "name": "token_",
    "type": "address",
    "internalType": "contract IERC20"
   },
   {
    "name": "owner_",
    "type": "address",
    "internalType": "address"
   },
   {
    "name": "agent_",
    "type": "address",
    "internalType": "address"
   },
   {
    "name": "agentReleaseCap_",
    "type": "uint96",
    "internalType": "uint96"
   },
   {
    "name": "maxJobAmount_",
    "type": "uint96",
    "internalType": "uint96"
   }
  ],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "MAX_DURATION",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "uint64",
    "internalType": "uint64"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "MAX_PROOF_URL_LENGTH",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "MAX_REJECTIONS",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "uint8",
    "internalType": "uint8"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "MIN_DURATION",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "uint64",
    "internalType": "uint64"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "REVIEW_GRACE",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "uint64",
    "internalType": "uint64"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "acceptOwnership",
  "inputs": [],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "agent",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "address",
    "internalType": "address"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "agentReject",
  "inputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "proofHash",
    "type": "bytes32",
    "internalType": "bytes32"
   },
   {
    "name": "verdictHash",
    "type": "bytes32",
    "internalType": "bytes32"
   }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "agentRelease",
  "inputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "proofHash",
    "type": "bytes32",
    "internalType": "bytes32"
   },
   {
    "name": "verdictHash",
    "type": "bytes32",
    "internalType": "bytes32"
   }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "agentReleaseCap",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "uint96",
    "internalType": "uint96"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "approveRelease",
  "inputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "verdictHash",
    "type": "bytes32",
    "internalType": "bytes32"
   }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "cancelJob",
  "inputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "createAndFund",
  "inputs": [
   {
    "name": "payee",
    "type": "address",
    "internalType": "address"
   },
   {
    "name": "amount",
    "type": "uint96",
    "internalType": "uint96"
   },
   {
    "name": "deadline",
    "type": "uint64",
    "internalType": "uint64"
   },
   {
    "name": "briefHash",
    "type": "bytes32",
    "internalType": "bytes32"
   }
  ],
  "outputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "createJob",
  "inputs": [
   {
    "name": "payee",
    "type": "address",
    "internalType": "address"
   },
   {
    "name": "amount",
    "type": "uint96",
    "internalType": "uint96"
   },
   {
    "name": "deadline",
    "type": "uint64",
    "internalType": "uint64"
   },
   {
    "name": "briefHash",
    "type": "bytes32",
    "internalType": "bytes32"
   }
  ],
  "outputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "fundJob",
  "inputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "getJob",
  "inputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "outputs": [
   {
    "name": "",
    "type": "tuple",
    "internalType": "struct ProofPayEscrow.Job",
    "components": [
     {
      "name": "client",
      "type": "address",
      "internalType": "address"
     },
     {
      "name": "payee",
      "type": "address",
      "internalType": "address"
     },
     {
      "name": "amount",
      "type": "uint96",
      "internalType": "uint96"
     },
     {
      "name": "deadline",
      "type": "uint64",
      "internalType": "uint64"
     },
     {
      "name": "proofSubmittedAt",
      "type": "uint64",
      "internalType": "uint64"
     },
     {
      "name": "rejections",
      "type": "uint8",
      "internalType": "uint8"
     },
     {
      "name": "status",
      "type": "uint8",
      "internalType": "enum ProofPayEscrow.Status"
     },
     {
      "name": "briefHash",
      "type": "bytes32",
      "internalType": "bytes32"
     },
     {
      "name": "proofHash",
      "type": "bytes32",
      "internalType": "bytes32"
     },
     {
      "name": "verdictHash",
      "type": "bytes32",
      "internalType": "bytes32"
     }
    ]
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "jobCount",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "maxJobAmount",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "uint96",
    "internalType": "uint96"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "owner",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "address",
    "internalType": "address"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "pause",
  "inputs": [],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "paused",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "bool",
    "internalType": "bool"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "pendingOwner",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "address",
    "internalType": "address"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "refund",
  "inputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "refundable",
  "inputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "outputs": [
   {
    "name": "",
    "type": "bool",
    "internalType": "bool"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "renounceOwnership",
  "inputs": [],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "setAgent",
  "inputs": [
   {
    "name": "newAgent",
    "type": "address",
    "internalType": "address"
   }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "setLimits",
  "inputs": [
   {
    "name": "agentReleaseCap_",
    "type": "uint96",
    "internalType": "uint96"
   },
   {
    "name": "maxJobAmount_",
    "type": "uint96",
    "internalType": "uint96"
   }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "submitProof",
  "inputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "proofUrl",
    "type": "string",
    "internalType": "string"
   }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "token",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "address",
    "internalType": "contract IERC20"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "transferOwnership",
  "inputs": [
   {
    "name": "newOwner",
    "type": "address",
    "internalType": "address"
   }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "unpause",
  "inputs": [],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "event",
  "name": "AgentUpdated",
  "inputs": [
   {
    "name": "previousAgent",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "newAgent",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "JobCancelled",
  "inputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "indexed": true,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "JobCreated",
  "inputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "indexed": true,
    "internalType": "uint256"
   },
   {
    "name": "client",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "payee",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "amount",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "deadline",
    "type": "uint64",
    "indexed": false,
    "internalType": "uint64"
   },
   {
    "name": "briefHash",
    "type": "bytes32",
    "indexed": false,
    "internalType": "bytes32"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "JobFunded",
  "inputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "indexed": true,
    "internalType": "uint256"
   },
   {
    "name": "amount",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "LimitsUpdated",
  "inputs": [
   {
    "name": "agentReleaseCap",
    "type": "uint96",
    "indexed": false,
    "internalType": "uint96"
   },
   {
    "name": "maxJobAmount",
    "type": "uint96",
    "indexed": false,
    "internalType": "uint96"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "OwnershipTransferStarted",
  "inputs": [
   {
    "name": "previousOwner",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "newOwner",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "OwnershipTransferred",
  "inputs": [
   {
    "name": "previousOwner",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "newOwner",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "Paused",
  "inputs": [
   {
    "name": "account",
    "type": "address",
    "indexed": false,
    "internalType": "address"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "ProofRejected",
  "inputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "indexed": true,
    "internalType": "uint256"
   },
   {
    "name": "by",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "rejections",
    "type": "uint8",
    "indexed": false,
    "internalType": "uint8"
   },
   {
    "name": "verdictHash",
    "type": "bytes32",
    "indexed": false,
    "internalType": "bytes32"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "ProofSubmitted",
  "inputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "indexed": true,
    "internalType": "uint256"
   },
   {
    "name": "payee",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "proofUrl",
    "type": "string",
    "indexed": false,
    "internalType": "string"
   },
   {
    "name": "proofHash",
    "type": "bytes32",
    "indexed": false,
    "internalType": "bytes32"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "Refunded",
  "inputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "indexed": true,
    "internalType": "uint256"
   },
   {
    "name": "client",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "amount",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "Released",
  "inputs": [
   {
    "name": "jobId",
    "type": "uint256",
    "indexed": true,
    "internalType": "uint256"
   },
   {
    "name": "by",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "payee",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "amount",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "verdictHash",
    "type": "bytes32",
    "indexed": false,
    "internalType": "bytes32"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "Unpaused",
  "inputs": [
   {
    "name": "account",
    "type": "address",
    "indexed": false,
    "internalType": "address"
   }
  ],
  "anonymous": false
 },
 {
  "type": "error",
  "name": "AboveAgentCap",
  "inputs": []
 },
 {
  "type": "error",
  "name": "AmountAboveMax",
  "inputs": []
 },
 {
  "type": "error",
  "name": "BadStatus",
  "inputs": [
   {
    "name": "current",
    "type": "uint8",
    "internalType": "enum ProofPayEscrow.Status"
   }
  ]
 },
 {
  "type": "error",
  "name": "DeadlinePassed",
  "inputs": []
 },
 {
  "type": "error",
  "name": "EnforcedPause",
  "inputs": []
 },
 {
  "type": "error",
  "name": "ExpectedPause",
  "inputs": []
 },
 {
  "type": "error",
  "name": "InvalidAmount",
  "inputs": []
 },
 {
  "type": "error",
  "name": "InvalidDeadline",
  "inputs": []
 },
 {
  "type": "error",
  "name": "InvalidLimits",
  "inputs": []
 },
 {
  "type": "error",
  "name": "InvalidPayee",
  "inputs": []
 },
 {
  "type": "error",
  "name": "InvalidProof",
  "inputs": []
 },
 {
  "type": "error",
  "name": "NotAgent",
  "inputs": []
 },
 {
  "type": "error",
  "name": "NotClient",
  "inputs": []
 },
 {
  "type": "error",
  "name": "NotPayee",
  "inputs": []
 },
 {
  "type": "error",
  "name": "NotRefundableYet",
  "inputs": []
 },
 {
  "type": "error",
  "name": "OwnableInvalidOwner",
  "inputs": [
   {
    "name": "owner",
    "type": "address",
    "internalType": "address"
   }
  ]
 },
 {
  "type": "error",
  "name": "OwnableUnauthorizedAccount",
  "inputs": [
   {
    "name": "account",
    "type": "address",
    "internalType": "address"
   }
  ]
 },
 {
  "type": "error",
  "name": "ReentrancyGuardReentrantCall",
  "inputs": []
 },
 {
  "type": "error",
  "name": "SafeERC20FailedOperation",
  "inputs": [
   {
    "name": "token",
    "type": "address",
    "internalType": "address"
   }
  ]
 },
 {
  "type": "error",
  "name": "ZeroAddress",
  "inputs": []
 }
] as const;

export const erc20Abi = [
 {
  "type": "function",
  "name": "approve",
  "stateMutability": "nonpayable",
  "inputs": [
   {
    "name": "spender",
    "type": "address"
   },
   {
    "name": "amount",
    "type": "uint256"
   }
  ],
  "outputs": [
   {
    "name": "",
    "type": "bool"
   }
  ]
 },
 {
  "type": "function",
  "name": "allowance",
  "stateMutability": "view",
  "inputs": [
   {
    "name": "owner",
    "type": "address"
   },
   {
    "name": "spender",
    "type": "address"
   }
  ],
  "outputs": [
   {
    "name": "",
    "type": "uint256"
   }
  ]
 },
 {
  "type": "function",
  "name": "balanceOf",
  "stateMutability": "view",
  "inputs": [
   {
    "name": "a",
    "type": "address"
   }
  ],
  "outputs": [
   {
    "name": "",
    "type": "uint256"
   }
  ]
 },
 {
  "type": "function",
  "name": "transfer",
  "stateMutability": "nonpayable",
  "inputs": [
   {
    "name": "to",
    "type": "address"
   },
   {
    "name": "amount",
    "type": "uint256"
   }
  ],
  "outputs": [
   {
    "name": "",
    "type": "bool"
   }
  ]
 },
 {
  "type": "function",
  "name": "decimals",
  "stateMutability": "view",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "uint8"
   }
  ]
 },
 {
  "type": "function",
  "name": "mint",
  "stateMutability": "nonpayable",
  "inputs": [
   {
    "name": "to",
    "type": "address"
   },
   {
    "name": "amount",
    "type": "uint256"
   }
  ],
  "outputs": []
 }
] as const;
