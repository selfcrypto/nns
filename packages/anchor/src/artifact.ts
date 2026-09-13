/**
 * GENERATED — do not edit by hand.
 *
 * Produced by `pnpm --filter @nns/anchor compile` from
 * `contracts/NnsAnchor.sol`. Committed on purpose: this is the record of
 * what was compiled and what a deployment must match, and `artifact.test.ts`
 * recompiles from source and fails if the two disagree.
 */

import type { Artifact } from './compile.js'

export const ARTIFACT = {
  "contractName": "NnsAnchor",
  "solcVersion": "0.8.30+commit.73712a01.Emscripten.clang",
  "evmVersion": "paris",
  "optimizer": {
    "enabled": true,
    "runs": 200
  },
  "sourceHash": "0xf71f42b2939e69b5370bd736bcfd82e57418b297fc9ddfff381a153ece675281",
  "abi": [
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "internalType": "bytes32",
          "name": "root",
          "type": "bytes32"
        },
        {
          "indexed": true,
          "internalType": "address",
          "name": "publisher",
          "type": "address"
        },
        {
          "indexed": false,
          "internalType": "uint64",
          "name": "nimiqHeight",
          "type": "uint64"
        },
        {
          "indexed": false,
          "internalType": "uint64",
          "name": "timestamp",
          "type": "uint64"
        },
        {
          "indexed": false,
          "internalType": "bytes32",
          "name": "logDigest",
          "type": "bytes32"
        }
      ],
      "name": "Anchored",
      "type": "event"
    },
    {
      "inputs": [
        {
          "internalType": "bytes32",
          "name": "root",
          "type": "bytes32"
        },
        {
          "internalType": "uint64",
          "name": "nimiqHeight",
          "type": "uint64"
        },
        {
          "internalType": "bytes32",
          "name": "logDigest",
          "type": "bytes32"
        }
      ],
      "name": "anchor",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    }
  ],
  "bytecode": "0x6080604052348015600f57600080fd5b5061010c8061001f6000396000f3fe6080604052348015600f57600080fd5b506004361060285760003560e01c806370c127c614602d575b600080fd5b603c60383660046093565b603e565b005b6040805167ffffffffffffffff808516825242166020820152908101829052339084907f05d81b8d9808f1fa1f651e2e7dc51bf6900cfd074532e3a0eccacf57055b668d9060600160405180910390a3505050565b60008060006060848603121560a757600080fd5b83359250602084013567ffffffffffffffff8116811460c557600080fd5b92959294505050604091909101359056fea264697066735822122091f45c0c8685ee3e574b0501c21e5b0fe437dee3a7a9f2dec657c39c4fc250cf64736f6c634300081e0033",
  "deployedBytecode": "0x6080604052348015600f57600080fd5b506004361060285760003560e01c806370c127c614602d575b600080fd5b603c60383660046093565b603e565b005b6040805167ffffffffffffffff808516825242166020820152908101829052339084907f05d81b8d9808f1fa1f651e2e7dc51bf6900cfd074532e3a0eccacf57055b668d9060600160405180910390a3505050565b60008060006060848603121560a757600080fd5b83359250602084013567ffffffffffffffff8116811460c557600080fd5b92959294505050604091909101359056fea264697066735822122091f45c0c8685ee3e574b0501c21e5b0fe437dee3a7a9f2dec657c39c4fc250cf64736f6c634300081e0033",
  "initCodeHash": "0x093869cddd34255fb89e2ebb9462002fe0ebb9da3597089584284ccc332523c7",
  "anchoredTopic0": "0x05d81b8d9808f1fa1f651e2e7dc51bf6900cfd074532e3a0eccacf57055b668d",
  "anchoredSignature": "Anchored(bytes32,address,uint64,uint64,bytes32)"
} as const satisfies Artifact

/** `keccak256("Anchored(bytes32,address,uint64,uint64,bytes32)")` — the `Anchored` event's topic 0. */
export const ANCHORED_TOPIC0 = ARTIFACT.anchoredTopic0

/**
 * CREATE2 init-code hash — kept for third parties deploying through a
 * factory. This package's own deploy is plain `CREATE` — CREATE2 was
 * dropped when the second chain arrived.
 */
export const INIT_CODE_HASH = ARTIFACT.initCodeHash
