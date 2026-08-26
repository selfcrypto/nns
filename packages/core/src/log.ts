/**
 * The NNS log — spec §8.2.
 *
 * ```
 * <block_height> <tx_index> <tx_hash> <sender> <recipient> <value> <data> <verdict>
 * ```
 *
 * Every `NNS1`-prefixed transaction surviving §7.5 gets one line, in canonical
 * order, with its verdict. Nothing else. That is the whole rule (§7.6).
 *
 * The log is what makes verification cheap — Tier 1 is "fetch it by CID,
 * replay it, compare the root to the anchor" — so its bytes are consensus
 * material: **the committed log hash is keccak256 of the file bytes**, and a
 * single character out of place changes the checkpoint silently.
 *
 * ## `tx_index` is zero-based
 *
 * §8.2 states this explicitly because a one-based reading produces a different
 * log hash and therefore a different checkpoint, with nothing to notice.
 *
 * ## `data` is hex, and it has to be
 *
 * §8.2 says the field "carries the message verbatim" and separately that
 * "hashes and other hex fields" are lowercase, without saying which this is.
 * It must be hex. The fields are single-space separated and lines are
 * newline-terminated, so raw text would let any `NNS1`-prefixed message
 * containing a space or a newline — which nothing prevents, since a malformed
 * payload still earns a log line — break the field layout or **forge an
 * entire log line**. Hex is also the form the RPC uses in both directions
 * (§5.1). Recorded in `docs/decisions.md` as needing ratification.
 */

import { keccak_256 } from '@noble/hashes/sha3.js'
import type { ChainTransaction, Verdict } from './reduce.js'

export class LogError extends Error {
  override readonly name = 'LogError'
}

/** Field separator and line terminator, per §8.2's canonical form. */
const SEPARATOR = ' '
const TERMINATOR = '\n'

/**
 * The verdict token: `OK`, or the §7.4 reason code.
 *
 * Forfeit and refund reason codes are disjoint, so the column a message landed
 * in is recoverable from the code alone and needs no prefix. `log.test.ts`
 * asserts that disjointness, because it is an invariant of the format rather
 * than a coincidence of the current names.
 *
 * @throws {LogError} for an `IGNORED` verdict, which earns no line at all (§7.6).
 */
export function verdictToken(verdict: Verdict): string {
  switch (verdict.kind) {
    case 'IGNORED':
      throw new LogError(`an IGNORED verdict (${verdict.reason}) earns no log line — §7.5 discards it before §7.6`)
    case 'OK':
      return 'OK'
    case 'FORFEIT':
    case 'REFUND':
      return verdict.reason
  }
}

/** Lowercase, bare hex — no `0x`, which §8.2's field list does not carry. */
function normaliseHash(hash: string): string {
  const bare = hash.startsWith('0x') || hash.startsWith('0X') ? hash.slice(2) : hash
  if (!/^[0-9a-fA-F]+$/.test(bare)) throw new LogError(`transaction hash ${JSON.stringify(hash)} is not hex`)
  return bare.toLowerCase()
}

function normaliseData(data: string): string {
  if (!/^[0-9a-fA-F]*$/.test(data)) throw new LogError(`recipientData ${JSON.stringify(data)} is not hex`)
  return data.toLowerCase()
}

/**
 * One canonical line, **without** its terminator — {@link logFile} adds
 * exactly one `\n` per line, so a caller cannot double it.
 *
 * Addresses are written in the compact 36-character `NQ…` form. The
 * conventional spacing cannot be used here: it would introduce spaces into a
 * space-separated format.
 */
export function canonicalLogLine(tx: ChainTransaction, verdict: Verdict): string {
  if (!Number.isSafeInteger(tx.blockNumber) || tx.blockNumber < 0) {
    throw new LogError(`block height ${tx.blockNumber} is not a non-negative safe integer`)
  }
  if (!Number.isSafeInteger(tx.txIndex) || tx.txIndex < 0) {
    throw new LogError(`tx_index ${tx.txIndex} is not a non-negative safe integer — §8.2 is zero-based`)
  }
  if (tx.value < 0n) throw new LogError(`value ${tx.value} is negative`)

  const line = [
    String(tx.blockNumber),
    String(tx.txIndex),
    normaliseHash(tx.hash),
    tx.sender,
    tx.recipient,
    tx.value.toString(10),
    normaliseData(tx.recipientData),
    verdictToken(verdict),
  ].join(SEPARATOR)

  // The format is only unambiguous if no field contributes a separator of its
  // own. Every field above is constrained to make that impossible; this is the
  // assertion that keeps it true if one ever stops being.
  if (line.split(SEPARATOR).length !== 8) {
    throw new LogError(`log line has ${line.split(SEPARATOR).length} fields, expected 8: ${JSON.stringify(line)}`)
  }
  if (line.includes(TERMINATOR)) throw new LogError('log line contains a newline')

  return line
}

/** Split a canonical line back into its eight fields. */
export function parseLogLine(line: string): {
  blockHeight: number
  txIndex: number
  txHash: string
  sender: string
  recipient: string
  value: bigint
  data: string
  verdict: string
} {
  const fields = line.split(SEPARATOR)
  if (fields.length !== 8) throw new LogError(`expected 8 fields, got ${fields.length}`)
  const [height, index, txHash, sender, recipient, value, data, verdict] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ]
  return {
    blockHeight: Number(height),
    txIndex: Number(index),
    txHash,
    sender,
    recipient,
    value: BigInt(value),
    data,
    verdict,
  }
}

/**
 * The canonical file bytes: UTF-8, one line per message, **every line
 * terminated by a single `\n`** — including the last.
 *
 * Every field is ASCII by construction, so UTF-8 encoding is the identity on
 * these bytes; the check makes that a guarantee rather than an assumption.
 */
export function logFile(lines: readonly string[]): Uint8Array {
  let length = 0
  for (const line of lines) length += line.length + 1

  const out = new Uint8Array(length)
  let offset = 0
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const code = line.charCodeAt(i)
      if (code > 0x7f) throw new LogError(`log line contains a non-ASCII character: ${JSON.stringify(line)}`)
      out[offset++] = code
    }
    out[offset++] = 0x0a
  }
  return out
}

/**
 * {@link logFile} inverted: the canonical file bytes back into §8.2 lines.
 *
 * Every line is terminated, including the last, so a well-formed file ends
 * with exactly one empty trailing element. **An unterminated final line is
 * rejected rather than accepted** — it hashes differently, and tolerating it
 * would let a truncated download pass a transport check that compares the
 * served bytes to the hash served with them.
 *
 * It lives here for the same reason {@link createLogHasher} does. Anyone who
 * fetches a log has to split it before hashing it, and a second opinion about
 * where the lines are is a second opinion about what §8.2 commits — which is
 * a divergence, not a parsing preference. `@nns/settlement` reads a log to
 * audit it and `@nns/indexer` reads one to bootstrap from it; those two are
 * deliberately independent of each other, so the one thing they must not each
 * invent is this.
 */
export function splitLogFile(bytes: Uint8Array): readonly string[] {
  if (bytes.length === 0) return []
  if (bytes[bytes.length - 1] !== 0x0a) {
    throw new LogError('log file does not end with a newline — §8.2 terminates every line, including the last')
  }
  // Decoded byte by byte rather than through `TextDecoder`, which is neither a
  // browser nor a Node global as far as this package's types are concerned —
  // and which would accept well-formed UTF-8 above U+007F that {@link logFile}
  // refuses to emit. Rejecting a high byte here makes the two exactly inverse.
  const lines: string[] = []
  let line = ''
  for (const byte of bytes) {
    if (byte === 0x0a) {
      lines.push(line)
      line = ''
      continue
    }
    if (byte > 0x7f) {
      throw new LogError(`log file contains a non-ASCII byte: 0x${byte.toString(16).padStart(2, '0')}`)
    }
    line += String.fromCharCode(byte)
  }
  return lines
}

/**
 * The committed log hash: keccak256 of the file bytes, from the first line
 * through the last message at or below the checkpoint height (§8.2).
 */
export const logHash = (lines: readonly string[]): Uint8Array => keccak_256(logFile(lines))

/**
 * The same value {@link logHash} produces, accumulated line by line.
 *
 * A checkpoint commits the log hash "from the first line through the last
 * message at or below the checkpoint height" (§8.2) — so an indexer needs that
 * hash once per `CHECKPOINT_INTERVAL`, over a file that only ever grows.
 * Re-hashing the whole file at every checkpoint is quadratic in the length of
 * the chain, which is fine at a hundred lines and hours of work over a
 * backfill.
 *
 * It lives here rather than in the indexer because the value is consensus
 * material: an implementation that streamed keccak over its own idea of the
 * file bytes would be reimplementing §8.2, and the failure mode of getting it
 * subtly wrong is a checkpoint nobody can reproduce. Every line still goes
 * through {@link logFile}, so the bytes are the same bytes by construction and
 * `log.test.ts` asserts the two agree.
 *
 * {@link digest} is non-destructive: it clones the sponge, so hashing at a
 * checkpoint does not end the stream.
 */
export interface LogHasher {
  /** One canonical line, **without** its terminator — as {@link canonicalLogLine} returns it. */
  append(line: string): void
  /** Lines appended so far. */
  readonly lines: number
  /** The log hash through the last appended line. Safe to call repeatedly. */
  digest(): Uint8Array
}

export function createLogHasher(): LogHasher {
  const sponge = keccak_256.create()
  let count = 0
  return {
    append(line: string): void {
      sponge.update(logFile([line]))
      count += 1
    },
    get lines(): number {
      return count
    },
    digest: (): Uint8Array => sponge.clone().digest(),
  }
}

/** CIDv1, dag-pb, sha2-256, 32-byte digest — §8.2's fixed prefix. */
const CID_PREFIX = [0x01, 0x70, 0x12, 0x20]
/** RFC 4648 base32, lowercase, unpadded — multibase prefix `b`. */
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * The log snapshot's CID **string**, rebuilt from the 32-byte multihash digest
 * the `Anchored` event carries (§9 `logDigest`). Every other component is a
 * constant of §8.2, so the digest determines the CID.
 *
 * This is the repo's only CID computation, deliberately. Deriving a CID from
 * log *bytes* is UnixFS/dag-pb work done by whatever performs the IPFS add;
 * a client verifies fetched bytes with keccak256 against the committed log
 * hash, and IPFS itself refuses to serve content that does not match its CID.
 * See "The CID is a locator, not a verifier" in `docs/decisions.md`.
 *
 * @throws {LogError} unless the digest is exactly 32 bytes.
 */
export function cidFromDigest(digest: Uint8Array): string {
  if (digest.length !== 32) throw new LogError(`a §9 logDigest is 32 bytes, got ${digest.length}`)
  const bytes = Uint8Array.from([...CID_PREFIX, ...digest])
  let out = 'b'
  let value = 0
  let bits = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32.charAt((value >>> bits) & 31)
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31)
  return out
}

/**
 * The 32-byte multihash digest a §8.2-conforming CID string carries — the
 * inverse of {@link cidFromDigest}, for the party that *has* a CID (an IPFS
 * add's answer, a pin listing) and needs the `logDigest` the `Anchored`
 * event carries (§9).
 *
 * This is parsing, not derivation: no bytes are hashed, and a CID never
 * enters or leaves except as the string a reference implementation minted.
 * The prefix check is the §8.2 conformance gate, and its most likely
 * customer is a misconfigured add — kubo turns raw leaves **on** the moment
 * `--cid-version=1` is given, which mints a `raw` (0x55) root for any
 * single-chunk file, so a publisher that forgot `--raw-leaves=false` is
 * caught here rather than anchoring a digest no conforming client can
 * rebuild a CID from.
 *
 * @throws {LogError} unless the string is a multibase-`b`, base32, CIDv1
 * `dag-pb` sha2-256 CID with a 32-byte digest — §8.2's exact shape.
 */
export function digestFromCid(cid: string): Uint8Array {
  // 1 multibase char + ceil((4 prefix + 32 digest) * 8 / 5) = 59.
  if (cid.length !== 59 || !cid.startsWith('b')) {
    throw new LogError(`not a §8.2 CID: expected 59 chars starting 'b' (base32 CIDv1), got ${JSON.stringify(cid)}`)
  }
  const bytes: number[] = []
  let value = 0
  let bits = 0
  for (const char of cid.slice(1)) {
    const index = BASE32.indexOf(char)
    if (index < 0) throw new LogError(`not a §8.2 CID: ${JSON.stringify(char)} is not lowercase base32`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >>> bits) & 0xff)
    }
  }
  // 58 chars decode to 36 bytes with 2 leftover bits, which canonical
  // encoding leaves zero.
  if ((value & ((1 << bits) - 1)) !== 0) {
    throw new LogError('not a §8.2 CID: non-zero padding bits')
  }
  for (let i = 0; i < CID_PREFIX.length; i += 1) {
    if (bytes[i] !== CID_PREFIX[i]) {
      const got = bytes
        .slice(0, 4)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(' ')
      throw new LogError(
        `not a §8.2 CID: prefix is ${got}, expected 01 70 12 20 (CIDv1 dag-pb sha2-256) — ` +
          'a 01 55 prefix is a raw-leaves root, which §8.2 forbids (pass --raw-leaves=false; ' +
          "kubo's --cid-version=1 default turns raw leaves on)",
      )
    }
  }
  return Uint8Array.from(bytes.slice(CID_PREFIX.length))
}
