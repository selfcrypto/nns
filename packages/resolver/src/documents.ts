/**
 * Reading §8.3 documents — and the API's responses that carry them — out of
 * untrusted JSON.
 *
 * **Everything a resolver serves is raw material, never an answer.** This is
 * the same posture `packages/api` takes toward the `checkpoint_names`
 * snapshot: the API re-derives the §8.1 root from the snapshot and compares
 * it to `checkpoints.name_root` before serving one proof from it, because a
 * table it did not compute is not a fact. The resolver stands one layer out
 * and takes the same view of the API. Nothing in this file trusts a value; it
 * only decides whether the bytes are the shape §8.3 fixes, and hands typed
 * material to {@link ./verify.ts}, which does the deciding.
 *
 * So: no field is defaulted, no field is coerced, and a missing one is a
 * {@link DocumentError} rather than an `undefined` that flows onward. The one
 * latitude taken is `delegate: null`, read as the empty host — §8.1 encodes
 * "no delegate" as a zero-length string and a JSON serialiser may reasonably
 * print either. It changes no leaf byte, so it cannot launder anything.
 *
 * Field names here are §8.3's, verbatim — `delegate`, `nimiq_height`,
 * `leaf_index` — because §8.3 is a wire format shared with every other
 * implementation, not this package's or the API's camelCase.
 */

import {
  HASH_BYTES,
  parseAddress,
  type Address,
  type NameRecord,
  type NameStatus,
  type ProofStep,
} from '@nns/core'

import { DocumentError } from './errors.js'

// ── Primitives ──────────────────────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function field(source: unknown, path: string, key: string): unknown {
  if (!isObject(source)) throw new DocumentError(path, 'expected an object')
  if (!(key in source)) throw new DocumentError(`${path}.${key}`, 'missing')
  return source[key]
}

function readString(source: unknown, path: string, key: string): string {
  const value = field(source, path, key)
  if (typeof value !== 'string') throw new DocumentError(`${path}.${key}`, `expected a string, got ${typeof value}`)
  return value
}

/** A height, an index, an expiry: all non-negative safe integers, never a float. */
function readCount(source: unknown, path: string, key: string): number {
  const value = field(source, path, key)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DocumentError(`${path}.${key}`, `expected a non-negative integer, got ${JSON.stringify(value)}`)
  }
  return value
}

function readAddress(source: unknown, path: string, key: string): Address {
  const value = readString(source, path, key)
  try {
    return parseAddress(value)
  } catch {
    throw new DocumentError(`${path}.${key}`, 'not a Nimiq address')
  }
}

function readStatus(source: unknown, path: string, key: string): NameStatus {
  const value = readString(source, path, key)
  if (value !== 'REGISTERED' && value !== 'GRACE') {
    throw new DocumentError(`${path}.${key}`, `expected REGISTERED or GRACE, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * `0x`-prefixed hex of exactly `bytes` bytes, as §8.3 prints hashes.
 *
 * Strict about the prefix and the length on purpose: a short root that
 * happened to compare equal to a truncated derivation would be a verification
 * that passed on less than 32 bytes.
 */
function readHex(source: unknown, path: string, key: string, bytes: number): Uint8Array {
  const value = readString(source, path, key)
  const where = `${path}.${key}`
  if (!value.startsWith('0x')) throw new DocumentError(where, 'expected a 0x-prefixed hash')
  const body = value.slice(2)
  if (body.length !== bytes * 2) {
    throw new DocumentError(where, `expected ${bytes} bytes of hex, got ${body.length / 2}`)
  }
  // parseInt alone would accept "0x", " 1" and "1z"; the test is what rejects them.
  if (!/^[0-9a-fA-F]*$/.test(body)) throw new DocumentError(where, 'not hexadecimal')
  const out = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return out
}

function readArray(source: unknown, path: string, key: string): readonly unknown[] {
  const value = field(source, path, key)
  if (!Array.isArray(value)) throw new DocumentError(`${path}.${key}`, 'expected an array')
  return value
}

/** Bare lowercase hex, for comparing and reporting roots. */
export const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

// ── §8.3 documents ──────────────────────────────────────────────────────────

/**
 * One proven leaf: the record rebuilt from the document's own fields, plus
 * the path that is supposed to bind it.
 *
 * The record is rebuilt rather than read: §8.3 carries every field the §8.1
 * leaf encodes precisely so a verifier can reconstruct the preimage, and a
 * verifier that cannot rebuild the preimage is checking a hash it was handed,
 * which proves nothing about the fields beside it.
 */
export interface ProvenLeaf {
  readonly record: NameRecord
  readonly index: number
  readonly steps: readonly ProofStep[]
}

function readSteps(source: unknown, path: string): readonly ProofStep[] {
  return readArray(source, path, 'proof').map((raw, i) => {
    const where = `${path}.proof[${i}]`
    const side = readString(raw, where, 'side')
    if (side !== 'left' && side !== 'right') {
      throw new DocumentError(`${where}.side`, `expected "left" or "right", got ${JSON.stringify(side)}`)
    }
    return { hash: readHex(raw, where, 'hash', HASH_BYTES), side }
  })
}

/**
 * §8.3's `evm` — lowercase `0x`-hex when set, `''` when unset, rebuilt into
 * the leaf as 20 raw bytes (zero bytes for `''`). Strict on case: the §5.1
 * hex convention is lowercase, and an uppercase digit here would re-derive
 * the same bytes while disagreeing with every other document — reject it
 * rather than normalise.
 */
function readEvm(source: unknown, path: string): string {
  const value = readString(source, path, 'evm')
  if (value !== '' && !/^0x[0-9a-f]{40}$/.test(value)) {
    throw new DocumentError(`${path}.evm`, 'expected "" or a lowercase 0x-prefixed 20-byte hex address')
  }
  return value
}

function readLeaf(source: unknown, path: string): ProvenLeaf {
  // `delegate: null` and `delegate: ""` are the same leaf: §8.1 length-prefixes
  // the host, so both encode as a single zero byte.
  const delegate = field(source, path, 'delegate')
  if (delegate !== null && typeof delegate !== 'string') {
    throw new DocumentError(`${path}.delegate`, `expected a string or null, got ${typeof delegate}`)
  }

  return {
    record: {
      name: readString(source, path, 'name'),
      owner: readAddress(source, path, 'owner'),
      target: readAddress(source, path, 'target'),
      evm: readEvm(source, path),
      expiry: readCount(source, path, 'expiry'),
      status: readStatus(source, path, 'status'),
      host: delegate ?? '',
    },
    index: readCount(source, path, 'leaf_index'),
    steps: readSteps(source, path),
  }
}

/** A §8.3 inclusion document: one leaf, its path, and the root it claims. */
export interface InclusionDocument {
  readonly leaf: ProvenLeaf
  readonly root: Uint8Array
  /** §8.3's `nimiq_height` — the checkpoint the root belongs to, not the state height. */
  readonly nimiqHeight: number
}

export function readInclusionDocument(value: unknown, path = 'proof'): InclusionDocument {
  return {
    leaf: readLeaf(value, path),
    root: readHex(value, path, 'root', HASH_BYTES),
    nimiqHeight: readCount(value, path, 'nimiq_height'),
  }
}

/**
 * A §8.3 non-inclusion document: the leaves that bracket the queried name.
 *
 * The `kind` the API prints is read but not believed — which of the four
 * cases this is gets derived from which leaves are actually present, and
 * `kind` is then required to agree. Deriving it is what stops a server
 * choosing the weakest case for itself; the cross-check is what turns a
 * disagreement into an error instead of a silently different verification.
 */
export interface NonInclusionDocument {
  readonly previous: ProvenLeaf | null
  readonly next: ProvenLeaf | null
  readonly root: Uint8Array
  readonly nimiqHeight: number
}

export function readNonInclusionDocument(value: unknown, path = 'proof'): NonInclusionDocument {
  const previousRaw = field(value, path, 'previous')
  const nextRaw = field(value, path, 'next')
  const previous = previousRaw === null ? null : readLeaf(previousRaw, `${path}.previous`)
  const next = nextRaw === null ? null : readLeaf(nextRaw, `${path}.next`)

  const derived =
    previous === null && next === null
      ? 'EMPTY_TREE'
      : previous === null
        ? 'BEFORE_FIRST'
        : next === null
          ? 'AFTER_LAST'
          : 'BETWEEN'

  if (isObject(value) && 'kind' in value) {
    const kind = readString(value, path, 'kind')
    if (kind !== derived) {
      throw new DocumentError(`${path}.kind`, `says ${kind}, but the leaves present are ${derived}`)
    }
  }

  return {
    previous,
    next,
    root: readHex(value, path, 'root', HASH_BYTES),
    nimiqHeight: readCount(value, path, 'nimiq_height'),
  }
}

// ── API responses ───────────────────────────────────────────────────────────

/**
 * `GET /resolve/{name}`, as `packages/api` serves it.
 *
 * `proof` is `null` when the latest checkpoint cannot prove the record — a
 * name registered since the boundary, most often. That is §8.7 depth pending
 * and not an error, which is why it is a nullable field here rather than a
 * throw in the reader.
 */
export interface ResolveResponse {
  readonly name: string
  readonly target: Address
  readonly status: NameStatus
  readonly expiry: number
  readonly host: string
  readonly proof: InclusionDocument | null
  /** The state height this answer is as of — ahead of `proof.nimiqHeight` most of the time. */
  readonly height: number
}

export function readResolveResponse(value: unknown, path = 'response'): ResolveResponse {
  const proof = field(value, path, 'proof')
  return {
    name: readString(value, path, 'name'),
    target: readAddress(value, path, 'target'),
    status: readStatus(value, path, 'status'),
    expiry: readCount(value, path, 'expiry'),
    host: readString(value, path, 'host'),
    proof: proof === null ? null : readInclusionDocument(proof, `${path}.proof`),
    height: readCount(value, path, 'height'),
  }
}

/** `GET /available/{name}`. `reason` is present only when `available` is false. */
export interface AvailableResponse {
  readonly name: string
  readonly available: boolean
  readonly reason: string | null
  readonly proof: NonInclusionDocument | null
  readonly height: number
}

export function readAvailableResponse(value: unknown, path = 'response'): AvailableResponse {
  const available = field(value, path, 'available')
  if (typeof available !== 'boolean') {
    throw new DocumentError(`${path}.available`, `expected a boolean, got ${typeof available}`)
  }

  const name = readString(value, path, 'name')
  const height = readCount(value, path, 'height')

  if (!available) {
    return { name, available: false, reason: readString(value, path, 'reason'), proof: null, height }
  }

  const proof = field(value, path, 'proof')
  return {
    name,
    available: true,
    reason: null,
    proof: proof === null ? null : readNonInclusionDocument(proof, `${path}.proof`),
    height,
  }
}

/** An error body, as the API prints them: `{ "error": "NOT_FOUND", ... }`. */
export function readErrorCode(value: unknown): string | null {
  if (!isObject(value)) return null
  const code = value['error']
  return typeof code === 'string' ? code : null
}

/** §8.6 step 3: `{"address": "NQ...", "ttl": <seconds>}` from a delegate host. */
export interface DelegateResponse {
  readonly address: Address
  readonly ttl: number
}

export function readDelegateResponse(value: unknown, path = 'delegate'): DelegateResponse {
  return { address: readAddress(value, path, 'address'), ttl: readCount(value, path, 'ttl') }
}
