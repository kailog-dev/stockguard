/** Generated from contracts/out (forge build). Subset used by the worker, API and web. */
export const STOCKGUARD_REGISTRY_ABI = [
 {
  "type": "function",
  "name": "alertThresholdBps",
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
  "name": "callbackProxy",
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
  "name": "clearCircuitBreaker",
  "inputs": [
   {
    "name": "asset",
    "type": "address",
    "internalType": "address"
   }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "getAsset",
  "inputs": [
   {
    "name": "asset",
    "type": "address",
    "internalType": "address"
   }
  ],
  "outputs": [
   {
    "name": "",
    "type": "tuple",
    "internalType": "struct StockGuardRegistry.AssetStatus",
    "components": [
     {
      "name": "registered",
      "type": "bool",
      "internalType": "bool"
     },
     {
      "name": "isOfficialIssuer",
      "type": "bool",
      "internalType": "bool"
     },
     {
      "name": "circuitBreakerActive",
      "type": "bool",
      "internalType": "bool"
     },
     {
      "name": "latestGrade",
      "type": "uint8",
      "internalType": "enum StockGuardRegistry.RiskGrade"
     },
     {
      "name": "lastReportAt",
      "type": "uint64",
      "internalType": "uint64"
     },
     {
      "name": "navUpdatedAt",
      "type": "uint64",
      "internalType": "uint64"
     },
     {
      "name": "breakerTriggeredAt",
      "type": "uint64",
      "internalType": "uint64"
     },
     {
      "name": "navFeed",
      "type": "address",
      "internalType": "address"
     },
     {
      "name": "lastNavPriceE8",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "lastDexPriceE8",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "lastDepegBps",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "breakerDepegBps",
      "type": "uint256",
      "internalType": "uint256"
     },
     {
      "name": "ticker",
      "type": "string",
      "internalType": "string"
     }
    ]
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "isHealthy",
  "inputs": [
   {
    "name": "asset",
    "type": "address",
    "internalType": "address"
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
  "name": "isReporter",
  "inputs": [
   {
    "name": "",
    "type": "address",
    "internalType": "address"
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
  "name": "publishAttestation",
  "inputs": [
   {
    "name": "asset",
    "type": "address",
    "internalType": "address"
   },
   {
    "name": "navPriceE8",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "dexPriceE8",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "reportHash",
    "type": "bytes32",
    "internalType": "bytes32"
   }
  ],
  "outputs": [
   {
    "name": "attestationId",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "reactiveSender",
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
  "name": "registerAsset",
  "inputs": [
   {
    "name": "asset",
    "type": "address",
    "internalType": "address"
   },
   {
    "name": "ticker",
    "type": "string",
    "internalType": "string"
   },
   {
    "name": "isOfficialIssuer",
    "type": "bool",
    "internalType": "bool"
   },
   {
    "name": "navFeed",
    "type": "address",
    "internalType": "address"
   }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "reportMarket",
  "inputs": [
   {
    "name": "asset",
    "type": "address",
    "internalType": "address"
   },
   {
    "name": "navPriceE8",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "dexPriceE8",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "setReactiveSender",
  "inputs": [
   {
    "name": "sender",
    "type": "address",
    "internalType": "address"
   }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "setReporter",
  "inputs": [
   {
    "name": "reporter",
    "type": "address",
    "internalType": "address"
   },
   {
    "name": "allowed",
    "type": "bool",
    "internalType": "bool"
   }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
 },
 {
  "type": "event",
  "name": "AssetRegistered",
  "inputs": [
   {
    "name": "asset",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "ticker",
    "type": "string",
    "indexed": false,
    "internalType": "string"
   },
   {
    "name": "isOfficialIssuer",
    "type": "bool",
    "indexed": false,
    "internalType": "bool"
   },
   {
    "name": "navFeed",
    "type": "address",
    "indexed": false,
    "internalType": "address"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "CircuitBreakerCleared",
  "inputs": [
   {
    "name": "asset",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "timestamp",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "CircuitBreakerTriggered",
  "inputs": [
   {
    "name": "asset",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "depegBps",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "triggeredBy",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "timestamp",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "DepegAlertEmitted",
  "inputs": [
   {
    "name": "asset",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "navPriceE8",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "dexPriceE8",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "depegBps",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "timestamp",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "MarketReported",
  "inputs": [
   {
    "name": "asset",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "reporter",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "navPriceE8",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "dexPriceE8",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "depegBps",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "grade",
    "type": "uint8",
    "indexed": false,
    "internalType": "enum StockGuardRegistry.RiskGrade"
   }
  ],
  "anonymous": false
 },
 {
  "type": "event",
  "name": "RiskAttested",
  "inputs": [
   {
    "name": "attestationId",
    "type": "uint256",
    "indexed": true,
    "internalType": "uint256"
   },
   {
    "name": "attester",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "asset",
    "type": "address",
    "indexed": true,
    "internalType": "address"
   },
   {
    "name": "depegBps",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   },
   {
    "name": "grade",
    "type": "uint8",
    "indexed": false,
    "internalType": "enum StockGuardRegistry.RiskGrade"
   },
   {
    "name": "reportHash",
    "type": "bytes32",
    "indexed": false,
    "internalType": "bytes32"
   },
   {
    "name": "timestamp",
    "type": "uint256",
    "indexed": false,
    "internalType": "uint256"
   }
  ],
  "anonymous": false
 },
 {
  "type": "error",
  "name": "AssetNotRegistered",
  "inputs": [
   {
    "name": "asset",
    "type": "address",
    "internalType": "address"
   }
  ]
 },
 {
  "type": "error",
  "name": "InsufficientBalance",
  "inputs": [
   {
    "name": "required",
    "type": "uint256",
    "internalType": "uint256"
   },
   {
    "name": "available",
    "type": "uint256",
    "internalType": "uint256"
   }
  ]
 },
 {
  "type": "error",
  "name": "InvalidConfig",
  "inputs": []
 },
 {
  "type": "error",
  "name": "InvalidFeedAnswer",
  "inputs": []
 },
 {
  "type": "error",
  "name": "InvalidPrice",
  "inputs": []
 },
 {
  "type": "error",
  "name": "NotCallbackProxy",
  "inputs": []
 },
 {
  "type": "error",
  "name": "NotOwner",
  "inputs": []
 },
 {
  "type": "error",
  "name": "NotPendingOwner",
  "inputs": []
 },
 {
  "type": "error",
  "name": "NotReporter",
  "inputs": []
 },
 {
  "type": "error",
  "name": "TransferFailed",
  "inputs": []
 },
 {
  "type": "error",
  "name": "UnauthorizedReactiveSender",
  "inputs": [
   {
    "name": "sender",
    "type": "address",
    "internalType": "address"
   },
   {
    "name": "expected",
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
