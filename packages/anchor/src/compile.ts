/**
 * Compiles `contracts/NnsAnchor.sol` and reduces the result to the artifact
 * this package commits (`artifact.ts`).
 *
 * **Node only.** It reaches for `fs` and pulls in the compiler, so nothing
 * that ships to a browser may import it — which is why `index.ts` exports
 * the generated artifact and not this module.
 *
 * Why the compiler is an ordinary dependency rather than an out-of-band
 * toolchain: the committed artifact is only worth something if anyone can
 * check it *is* the compilation of the `.sol` beside it. Behind a separately
 * installed binary that check runs on the machines that happen to have it;
 * as a `devDependency` it runs in `pnpm test` on every machine, always, and
 * a hand-edited artifact turns the suite red.
 */

import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import solc from 'solc'

/** The one contract, and the file it lives in. */
export const CONTRACT_FILE = 'NnsAnchor.sol'
export const CONTRACT_NAME = 'NnsAnchor'

/**
 * Compiler settings. Every field here is an input to the bytecode, and the
 * bytecode is the contract's identity — `verify` and the publisher's
 * pre-spend check both compare deployed code against the committed artifact,
 * so changing one silently unmatches every already-deployed contract. They
 * are committed into the artifact and asserted by `artifact.test.ts` for
 * exactly that reason.
 */
export const SETTINGS = {
  /**
   * Paris, not the compiler's default. Shanghai introduces PUSH0 and Cancun
   * MCOPY/TSTORE, and a chain that has not taken those forks cannot execute
   * bytecode that uses them. §9 says the anchor chain is a deployment choice
   * and that this contract deploys unchanged anywhere EVM; targeting the
   * oldest EVM that runs it is what makes that sentence true rather than
   * aspirational. It costs a couple of gas per call on a modern chain.
   */
  evmVersion: 'paris',
  /**
   * Optimiser on, 200 runs — the conventional default. This contract is
   * deployed once and called hourly forever, so `runs` could argue for a
   * much higher number, but the difference on a function whose body is one
   * `emit` is noise, and the conventional value is the one a third party
   * reproducing this build is least likely to get wrong.
   */
  optimizer: { enabled: true, runs: 200 },
} as const

/** Solidity ABI entries, narrowed to what this contract actually produces. */
export interface AbiParameter {
  readonly name: string
  /** The canonical ABI type — what the event signature is built from. */
  readonly type: string
  /**
   * solc's source-level type. Identical to {@link type} for every parameter
   * here, and carried rather than stripped because the artifact is meant to
   * be the compiler's output verbatim: a reader reproducing the build gets
   * `internalType` too, and dropping it would make their file differ from
   * the committed one for no reason.
   */
  readonly internalType?: string
  readonly indexed?: boolean
}

export interface AbiEntry {
  readonly type: string
  readonly name?: string
  readonly inputs?: readonly AbiParameter[]
  readonly outputs?: readonly AbiParameter[]
  readonly stateMutability?: string
  readonly anonymous?: boolean
}

/** What `artifact.ts` holds, and what a rebuild must reproduce exactly. */
export interface Artifact {
  readonly contractName: string
  /** Full compiler version banner, commit hash included. */
  readonly solcVersion: string
  readonly evmVersion: string
  readonly optimizer: { readonly enabled: boolean; readonly runs: number }
  /** sha256 of the `.sol` source bytes — pins *what* was compiled. */
  readonly sourceHash: string
  readonly abi: readonly AbiEntry[]
  /** Creation (deploy) bytecode, `0x`-prefixed lowercase hex. */
  readonly bytecode: string
  /** Runtime bytecode, what lands at the address. */
  readonly deployedBytecode: string
  /**
   * keccak256 of {@link bytecode} — with no constructor arguments, the
   * CREATE2 init-code hash. Kept for third parties deploying through a
   * factory; this package's own deploy is plain `CREATE` — CREATE2 was dropped
   * when the second chain arrived.
   */
  readonly initCodeHash: string
  /** `keccak256("Anchored(bytes32,address,uint64,uint64,bytes32)")`. */
  readonly anchoredTopic0: string
  /** The signature string that hashes to {@link anchoredTopic0}. */
  readonly anchoredSignature: string
}

/** Path to the contract source, resolved relative to this module. */
export function contractPath(): string {
  return fileURLToPath(new URL(`../contracts/${CONTRACT_FILE}`, import.meta.url))
}

export function readContractSource(): string {
  return readFileSync(contractPath(), 'utf8')
}

/**
 * The canonical event signature for an ABI event entry: name, then the
 * parameter types in order, no spaces and no parameter names.
 *
 * Derived from the ABI rather than written out as a string constant, so the
 * committed `anchoredTopic0` cannot drift from the committed `abi`. A test
 * that compared a hardcoded signature against a hardcoded hash would agree
 * with itself while both disagreed with the contract.
 */
export function eventSignature(entry: AbiEntry): string {
  const inputs = entry.inputs ?? []
  return `${entry.name ?? ''}(${inputs.map((i) => i.type).join(',')})`
}

interface SolcError {
  readonly severity?: string
  readonly formattedMessage?: string
  readonly message?: string
}

/** Compile the given source and reduce it to an {@link Artifact}. */
export function compileAnchor(source: string = readContractSource()): Artifact {
  const input = {
    language: 'Solidity',
    sources: { [CONTRACT_FILE]: { content: source } },
    settings: {
      evmVersion: SETTINGS.evmVersion,
      optimizer: { ...SETTINGS.optimizer },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  }

  const output: unknown = JSON.parse(solc.compile(JSON.stringify(input)))
  if (typeof output !== 'object' || output === null) throw new Error('solc returned a non-object')
  const result = output as {
    errors?: readonly SolcError[]
    contracts?: Record<string, Record<string, unknown>>
  }

  // Warnings are not tolerated. A warning on an 80-line contract means
  // something is wrong with the contract, not with the threshold.
  const errors = (result.errors ?? []).filter((e) => e.severity !== 'info')
  if (errors.length > 0) {
    throw new Error(`solc reported ${errors.length} problem(s):\n${errors.map((e) => e.formattedMessage ?? e.message).join('\n')}`)
  }

  const contract = result.contracts?.[CONTRACT_FILE]?.[CONTRACT_NAME]
  if (typeof contract !== 'object' || contract === null) {
    throw new Error(`solc output has no ${CONTRACT_FILE}:${CONTRACT_NAME}`)
  }
  const c = contract as {
    abi?: readonly AbiEntry[]
    evm?: { bytecode?: { object?: string }; deployedBytecode?: { object?: string } }
  }

  const abi = c.abi
  const bytecode = c.evm?.bytecode?.object
  const deployedBytecode = c.evm?.deployedBytecode?.object
  if (abi === undefined) throw new Error('solc output has no abi')
  if (bytecode === undefined) throw new Error('solc output has no evm.bytecode.object')
  if (deployedBytecode === undefined) throw new Error('solc output has no evm.deployedBytecode.object')

  const anchored = abi.find((e) => e.type === 'event' && e.name === 'Anchored')
  if (anchored === undefined) throw new Error('compiled ABI has no Anchored event')
  const anchoredSignature = eventSignature(anchored)

  return {
    contractName: CONTRACT_NAME,
    solcVersion: solc.version(),
    evmVersion: SETTINGS.evmVersion,
    optimizer: { ...SETTINGS.optimizer },
    sourceHash: `0x${createHash('sha256').update(source, 'utf8').digest('hex')}`,
    abi,
    bytecode: `0x${bytecode}`,
    deployedBytecode: `0x${deployedBytecode}`,
    initCodeHash: keccak256Hex(hexToBytes(bytecode)),
    anchoredTopic0: keccak256Hex(new TextEncoder().encode(anchoredSignature)),
    anchoredSignature,
  }
}

/**
 * keccak256 through `@noble/hashes` — the same implementation `@nns/core`
 * derives the Merkle tree with, so the two constants below are hashed by the
 * code the rest of the protocol already trusts.
 *
 * `@noble/hashes` is a devDependency of this package on purpose: it is used
 * at generation time and in tests, and never at runtime by anything this
 * package exports. Keeping it out of `index.ts` is what holds that line.
 */
function keccak256Hex(bytes: Uint8Array): string {
  return `0x${bytesToHex(keccak_256(bytes))}`
}
