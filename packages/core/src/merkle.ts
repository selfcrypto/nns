/**
 * Checkpoint Merkle tree — spec §8.1.
 *
 * The byte layout below is copied from §8.1 clause by clause. "Close enough"
 * forks the root, and a forked root produces no error anywhere — it produces
 * two implementations that quietly disagree about who owns a name.
 *
 * ```
 * enc  = len(name):u8 ‖ name ‖ owner:20B ‖ target:20B ‖ expiry:u64-BE
 *        ‖ status:u8 ‖ recovery:20B ‖ len(host):u8 ‖ host
 * leaf = keccak256(0x00 ‖ enc)
 * node = keccak256(0x01 ‖ left ‖ right)
 * ```
 *
 * The one-byte domain-separation prefixes stop a crafted leaf being
 * reinterpreted as an internal node. Every variable-length field is
 * length-prefixed, so no two distinct states share an encoding.
 *
 * Grace names are in the tree, which is what makes **non-inclusion mean
 * `AVAILABLE`** rather than merely not-`REGISTERED` — before r6 a client
 * following §8.5 to the letter would have let a user pay for an unregistrable
 * name.
 *
 * The referrer (§6 `G`) is deliberately **not** in the leaf: it is an
 * accounting detail, not registry state, and lives only in the log.
 */

import { keccak_256 } from '@noble/hashes/sha3.js'
import { ADDRESS_BYTES, addressToBytes } from './address.js'
import type { NameRecord, NnsState, Prices } from './state.js'

export const HASH_BYTES = 32

/** §8.1's tag bytes. Every domain in the checkpoint has its own, and they are all distinct. */
const TAG = {
  LEAF: 0x00,
  NODE: 0x01,
  CHECKPOINT: 0x02,
  PRICES: 0x03,
  PENDING: 0x04,
  PENDING_TRANSFER: 0x05,
  PENDING_RECOVERY: 0x06,
  PENDING_OFFER: 0x07,
  PENDING_GOVERNANCE: 0x08,
  PENDING_UNRESERVE: 0x09,
} as const

export class MerkleError extends Error {
  override readonly name = 'MerkleError'
}

// ── Byte helpers ────────────────────────────────────────────────────────────

const ZERO_ADDRESS_BYTES = new Uint8Array(ADDRESS_BYTES)

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Big-endian u64. Used for heights and for luna amounts. */
function u64be(value: bigint | number): Uint8Array {
  const big = typeof value === 'bigint' ? value : BigInt(value)
  if (big < 0n || big > 0xffff_ffff_ffff_ffffn) {
    throw new MerkleError(`value ${big} does not fit in a u64`)
  }
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, big, false)
  return out
}

const u8 = (value: number): Uint8Array => {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new MerkleError(`value ${value} does not fit in a u8`)
  }
  return Uint8Array.of(value)
}

/** Raw ASCII bytes, as §8.1 specifies for `name` and `host`. */
function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code > 0x7f) throw new MerkleError(`${JSON.stringify(text)} is not ASCII`)
    out[i] = code
  }
  return out
}

/** Length-prefixed ASCII: `len:u8 ‖ bytes`. */
function lengthPrefixed(text: string): Uint8Array {
  const bytes = ascii(text)
  if (bytes.length > 0xff) throw new MerkleError(`${JSON.stringify(text)} is longer than a u8 length prefix allows`)
  return concat([u8(bytes.length), bytes])
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Bytewise-lexicographic comparison, as §8.1 words it.
 *
 * Written over bytes rather than with JavaScript's string comparison even
 * though the two agree for the permitted character set — the spec says
 * bytewise, and an implementation that reads it as "whatever `<` does" would
 * be right by luck rather than by construction.
 */
export function compareNames(a: string, b: string): number {
  const left = ascii(a)
  const right = ascii(b)
  const shared = Math.min(left.length, right.length)
  for (let i = 0; i < shared; i++) {
    const difference = (left[i] as number) - (right[i] as number)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

// ── Leaves ──────────────────────────────────────────────────────────────────

/**
 * The `enc` of §8.1 — the leaf preimage, before hashing.
 *
 * Addresses are the raw 20-byte form, never the `NQ` string. An unset recovery
 * address is 20 zero bytes; an unset host has length 0.
 */
export function encodeLeaf(record: NameRecord): Uint8Array {
  return concat([
    lengthPrefixed(record.name),
    addressToBytes(record.owner),
    addressToBytes(record.target),
    u64be(record.expiry),
    u8(record.status === 'REGISTERED' ? 0x00 : 0x01),
    record.recovery === null ? ZERO_ADDRESS_BYTES : addressToBytes(record.recovery),
    lengthPrefixed(record.host),
  ])
}

export const leafHash = (record: NameRecord): Uint8Array => keccak_256(concat([u8(TAG.LEAF), encodeLeaf(record)]))

const nodeHash = (left: Uint8Array, right: Uint8Array): Uint8Array =>
  keccak_256(concat([u8(TAG.NODE), left, right]))

/** Every name in `REGISTERED` or `GRACE`, sorted bytewise-lexicographically. */
export function sortedRecords(state: NnsState): NameRecord[] {
  return [...state.names.values()].sort((a, b) => compareNames(a.name, b.name))
}

// ── Tree ────────────────────────────────────────────────────────────────────

/** Levels from leaves upward. Odd nodes are promoted unchanged, per §8.1. */
function buildLevels(leaves: readonly Uint8Array[]): Uint8Array[][] {
  const levels: Uint8Array[][] = [[...leaves]]
  let current: Uint8Array[] = [...leaves]
  while (current.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i] as Uint8Array
      const right = current[i + 1]
      next.push(right === undefined ? left : nodeHash(left, right))
    }
    levels.push(next)
    current = next
  }
  return levels
}

/** The checkpoint root over the name tree. An empty tree is 32 zero bytes. */
export function merkleRoot(state: NnsState): Uint8Array {
  const leaves = sortedRecords(state).map(leafHash)
  if (leaves.length === 0) return new Uint8Array(HASH_BYTES)
  const levels = buildLevels(leaves)
  return (levels[levels.length - 1] as Uint8Array[])[0] as Uint8Array
}

/**
 * Which side the **sibling** sits on. A verifier needs this to recombine, and
 * with odd-node promotion it cannot be derived from the leaf index alone
 * without also knowing the leaf count — see {@link merkleProof}.
 */
export interface ProofStep {
  readonly hash: Uint8Array
  readonly side: 'left' | 'right'
}

export interface MerkleProof {
  readonly name: string
  readonly record: NameRecord
  readonly leaf: Uint8Array
  readonly index: number
  readonly steps: readonly ProofStep[]
  readonly root: Uint8Array
}

/**
 * An inclusion proof, or `null` when the name is not in the tree.
 *
 * Each step carries its side and the leaf `index` travels with the proof, per
 * §8.3. A bare array of hashes — which §8.3 printed before r15 — is not
 * verifiable: odd-node promotion makes the tree shape depend on the leaf
 * count, so neither the sibling's side nor the promotion points can be
 * recovered from the hashes alone.
 */
export function merkleProof(state: NnsState, name: string): MerkleProof | null {
  const records = sortedRecords(state)
  const index = records.findIndex((record) => record.name === name)
  if (index < 0) return null

  const leaves = records.map(leafHash)
  const levels = buildLevels(leaves)
  const steps: ProofStep[] = []

  let position = index
  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level] as Uint8Array[]
    const isRightChild = position % 2 === 1
    const sibling = nodes[isRightChild ? position - 1 : position + 1]
    // No sibling means this node was promoted unchanged, so the level
    // contributes no step at all.
    if (sibling !== undefined) steps.push({ hash: sibling, side: isRightChild ? 'left' : 'right' })
    position = Math.floor(position / 2)
  }

  return {
    name,
    record: records[index] as NameRecord,
    leaf: leaves[index] as Uint8Array,
    index,
    steps,
    root: (levels[levels.length - 1] as Uint8Array[])[0] as Uint8Array,
  }
}

/** Recombine a leaf with its proof and compare to the root. */
export function verifyProof(leaf: Uint8Array, steps: readonly ProofStep[], root: Uint8Array): boolean {
  let current = leaf
  for (const step of steps) {
    current = step.side === 'left' ? nodeHash(step.hash, current) : nodeHash(current, step.hash)
  }
  return bytesEqual(current, root)
}

/**
 * Non-inclusion, per §8.3: the two leaves that lexicographically bracket the
 * queried name, each with its own proof. When the name sorts before the first
 * leaf or after the last, the single boundary leaf suffices — the proof path
 * itself shows that leaf is the extreme one.
 *
 * Because grace names are in the tree, this proves `AVAILABLE`.
 */
export type NonInclusionProof =
  | { readonly kind: 'EMPTY_TREE'; readonly root: Uint8Array }
  | { readonly kind: 'BEFORE_FIRST'; readonly next: MerkleProof; readonly root: Uint8Array }
  | { readonly kind: 'AFTER_LAST'; readonly previous: MerkleProof; readonly root: Uint8Array }
  | {
      readonly kind: 'BETWEEN'
      readonly previous: MerkleProof
      readonly next: MerkleProof
      readonly root: Uint8Array
    }

/** @throws {MerkleError} if the name *is* in the tree — ask for an inclusion proof instead. */
export function merkleNonInclusion(state: NnsState, name: string): NonInclusionProof {
  const records = sortedRecords(state)
  const root = merkleRoot(state)

  if (records.length === 0) return { kind: 'EMPTY_TREE', root }

  let after = -1 // last index sorting strictly before `name`
  for (let i = 0; i < records.length; i++) {
    const order = compareNames((records[i] as NameRecord).name, name)
    if (order === 0) throw new MerkleError(`${name} is in the tree; use merkleProof for an inclusion proof`)
    if (order < 0) after = i
    else break
  }

  const proofAt = (index: number): MerkleProof => merkleProof(state, (records[index] as NameRecord).name) as MerkleProof

  if (after < 0) return { kind: 'BEFORE_FIRST', next: proofAt(0), root }
  if (after === records.length - 1) return { kind: 'AFTER_LAST', previous: proofAt(after), root }
  return { kind: 'BETWEEN', previous: proofAt(after), next: proofAt(after + 1), root }
}

// ── The rest of the checkpoint (§8.1, final clause) ──────────────────────────

/**
 * §8.1 requires the checkpoint to commit to more than the name tree:
 *
 * > The **active prices and commission rate** and the **pending set** — in-flight
 * > `X`/`R` and open offers, each with its effective or expiry height — are
 * > consensus-relevant state and MUST be committed to in the checkpoint
 * > alongside the name tree, or independent replays diverge.
 *
 * When that was the whole clause it did not say *how*, and two
 * implementations committing them differently produce checkpoints that never
 * match — so the layout below was proposed here, together with a pending `P`
 * and a pending `U`, which the enumeration then omitted. **r15 ratified both**
 * and writes the bytes out in §8.1 itself; this file implements that clause,
 * and `vectors/merkle.json` pins every value it produces.
 */
export function pricesCommitment(prices: Prices): Uint8Array {
  return keccak_256(
    concat([u8(TAG.PRICES), u64be(prices.feeStandard), u64be(prices.feeLong), u64be(prices.commissionBp)]),
  )
}

/** Every pending item, each domain-separated and length-prefixed, in a fixed order. */
export function pendingCommitment(state: NnsState): Uint8Array {
  const entries: Uint8Array[] = []

  for (const item of [...state.transfers.values()].sort((a, b) => compareNames(a.name, b.name))) {
    entries.push(
      concat([
        u8(TAG.PENDING_TRANSFER),
        lengthPrefixed(item.name),
        addressToBytes(item.newOwner),
        u64be(item.effectiveHeight),
        u8(item.viaRecovery ? 1 : 0),
      ]),
    )
  }

  for (const item of [...state.recoveries.values()].sort((a, b) => compareNames(a.name, b.name))) {
    entries.push(
      concat([
        u8(TAG.PENDING_RECOVERY),
        lengthPrefixed(item.name),
        item.recovery === null ? ZERO_ADDRESS_BYTES : addressToBytes(item.recovery),
        u64be(item.effectiveHeight),
      ]),
    )
  }

  for (const item of [...state.offers.values()].sort((a, b) => compareNames(a.name, b.name))) {
    entries.push(
      concat([
        u8(TAG.PENDING_OFFER),
        lengthPrefixed(item.name),
        addressToBytes(item.seller),
        u64be(item.price),
        u64be(item.openedHeight),
        u64be(item.expiryHeight),
      ]),
    )
  }

  if (state.pendingGovernance !== null) {
    entries.push(
      concat([
        u8(TAG.PENDING_GOVERNANCE),
        pricesCommitment(state.pendingGovernance.prices),
        u64be(state.pendingGovernance.effectiveHeight),
      ]),
    )
  }

  for (const item of [...state.pendingUnreserve.values()].sort((a, b) => compareNames(a.name, b.name))) {
    entries.push(concat([u8(TAG.PENDING_UNRESERVE), lengthPrefixed(item.name), u64be(item.effectiveHeight)]))
  }

  return keccak_256(concat([u8(TAG.PENDING), ...entries]))
}

export interface Checkpoint {
  readonly height: number
  readonly nameRoot: Uint8Array
  readonly pricesRoot: Uint8Array
  readonly pendingRoot: Uint8Array
  readonly logHash: Uint8Array
  /** What an anchor publishes (§9). */
  readonly commitment: Uint8Array
}

/**
 * Bind the name tree, the prices, the pending set, the log hash (§8.2) and the
 * height into the single value an anchor publishes.
 *
 * @param logHash keccak256 of the canonical log file through this height.
 */
export function checkpoint(state: NnsState, logHash: Uint8Array): Checkpoint {
  if (logHash.length !== HASH_BYTES) throw new MerkleError(`logHash must be ${HASH_BYTES} bytes`)
  const nameRoot = merkleRoot(state)
  const pricesRoot = pricesCommitment(state.prices)
  const pendingRoot = pendingCommitment(state)
  const commitment = keccak_256(
    concat([u8(TAG.CHECKPOINT), nameRoot, pricesRoot, pendingRoot, logHash, u64be(state.height)]),
  )
  return { height: state.height, nameRoot, pricesRoot, pendingRoot, logHash, commitment }
}
