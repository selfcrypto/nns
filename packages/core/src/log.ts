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
 * The committed log hash: keccak256 of the file bytes, from the first line
 * through the last message at or below the checkpoint height (§8.2).
 */
export const logHash = (lines: readonly string[]): Uint8Array => keccak_256(logFile(lines))
