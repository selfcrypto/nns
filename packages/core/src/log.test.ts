import { keccak_256 } from '@noble/hashes/sha3.js'
import { describe, expect, it } from 'vitest'
import { LogError, canonicalLogLine, logFile, logHash, parseLogLine, verdictToken } from './log.js'
import type { ChainTransaction, ForfeitReason, RefundReason, Verdict } from './reduce.js'
import { ALICE, MAINNET_ID, TREASURY } from './test-fixtures.js'

const tx = (over: Partial<ChainTransaction> = {}): ChainTransaction => ({
  blockNumber: 58_060_800,
  txIndex: 0,
  hash: 'ab'.repeat(32),
  sender: ALICE,
  recipient: TREASURY,
  value: 400_000_000n,
  recipientData: '4e4e533147746573746e616d65', // NNS1Gtestname
  executionResult: true,
  networkId: MAINNET_ID,
  ...over,
})

const OK: Verdict = { kind: 'OK', obligations: [] }

describe('canonicalLogLine — §8.2', () => {
  it('writes the eight fields in order, single-space separated', () => {
    expect(canonicalLogLine(tx(), OK)).toBe(
      `58060800 0 ${'ab'.repeat(32)} ${ALICE} ${TREASURY} 400000000 4e4e533147746573746e616d65 OK`,
    )
  })

  it('keeps tx_index zero-based', () => {
    // §8.2 says so explicitly because a one-based reading changes the log
    // hash and therefore the checkpoint, silently.
    expect(canonicalLogLine(tx({ txIndex: 0 }), OK).split(' ')[1]).toBe('0')
    expect(canonicalLogLine(tx({ txIndex: 3 }), OK).split(' ')[1]).toBe('3')
  })

  it('writes addresses compactly — the conventional spacing would break the format', () => {
    const fields = canonicalLogLine(tx(), OK).split(' ')
    expect(fields).toHaveLength(8)
    expect(fields[3]).toBe(ALICE)
    expect(fields[3]).not.toMatch(/\s/)
  })

  it('lowercases the hash and drops any 0x prefix', () => {
    const line = canonicalLogLine(tx({ hash: `0x${'AB'.repeat(32)}` }), OK)
    expect(line.split(' ')[2]).toBe('ab'.repeat(32))
  })

  it('carries the message as hex, so a payload cannot forge a line', () => {
    // A malformed but NNS1-prefixed message still earns a log line (§7.6).
    // As raw text this payload would inject an entire second line; as hex it
    // is inert. NNS1G\nBAD → 4e4e533147 0a 424144
    const injected = '4e4e5331470a424144'
    const line = canonicalLogLine(tx({ recipientData: injected }), { kind: 'FORFEIT', reason: 'INVALID_NAME' })
    expect(line).not.toContain('\n')
    expect(line.split(' ')).toHaveLength(8)
    expect(line.split(' ')[6]).toBe(injected)
  })

  it('rejects a non-hex hash or payload', () => {
    expect(() => canonicalLogLine(tx({ hash: 'zz' }), OK)).toThrow(LogError)
    expect(() => canonicalLogLine(tx({ recipientData: 'NNS1G hello' }), OK)).toThrow(LogError)
  })

  it('rejects a negative value or a non-integer height', () => {
    expect(() => canonicalLogLine(tx({ value: -1n }), OK)).toThrow(LogError)
    expect(() => canonicalLogLine(tx({ blockNumber: 1.5 }), OK)).toThrow(LogError)
    expect(() => canonicalLogLine(tx({ txIndex: -1 }), OK)).toThrow(LogError)
  })

  it('round-trips through parseLogLine', () => {
    const original = tx({ txIndex: 4, value: 1n })
    const parsed = parseLogLine(canonicalLogLine(original, OK))
    expect(parsed).toEqual({
      blockHeight: original.blockNumber,
      txIndex: 4,
      txHash: original.hash,
      sender: ALICE,
      recipient: TREASURY,
      value: 1n,
      data: original.recipientData,
      verdict: 'OK',
    })
  })
})

describe('verdictToken', () => {
  it('writes OK for a success', () => {
    expect(verdictToken(OK)).toBe('OK')
  })

  it('writes the bare §7.4 reason code for a forfeit or a refund', () => {
    expect(verdictToken({ kind: 'FORFEIT', reason: 'NAME_IN_GRACE' })).toBe('NAME_IN_GRACE')
    expect(verdictToken({ kind: 'REFUND', reason: 'LOST_REGISTRATION_RACE', obligations: [] })).toBe(
      'LOST_REGISTRATION_RACE',
    )
  })

  it('refuses an IGNORED verdict — §7.5 discards it before it can be logged', () => {
    expect(() => verdictToken({ kind: 'IGNORED', reason: 'FAILED_EXECUTION' })).toThrow(LogError)
  })

  it('keeps forfeit and refund reason codes disjoint', () => {
    // The format carries no prefix, so the column a message landed in is only
    // recoverable if no code appears in both sets. That is an invariant of the
    // log format, not a coincidence of the current names.
    const forfeits: readonly ForfeitReason[] = [
      'UNKNOWN_TYPE',
      'OVER_LENGTH',
      'MALFORMED_PAYLOAD',
      'WRONG_RECIPIENT',
      'WRONG_SENDER',
      'INSUFFICIENT_VALUE',
      'INVALID_NAME',
      'RESERVED_NAME',
      'NAME_IN_GRACE',
      'NAME_NOT_REGISTERED',
      'NAME_NOT_FOUND',
      'NOT_OWNER',
      'NOT_OWNER_OR_RECOVERY',
      'INVALID_HOST',
      'NOT_ADMIN',
      'GOVERNANCE_BOUND_VIOLATED',
      'INSUFFICIENT_NOTICE',
      'TOO_SOON',
      'NOTHING_TO_CANCEL',
      'BELOW_REFUND_FLOOR',
      'AUCTION_NOT_IN_V1',
    ]
    const refunds: readonly RefundReason[] = ['LOST_REGISTRATION_RACE', 'OFFER_NOT_OPEN', 'WRONG_PRICE']

    const overlap = forfeits.filter((reason) => (refunds as readonly string[]).includes(reason))
    expect(overlap).toEqual([])
    expect(forfeits).not.toContain('OK')
    expect(refunds).not.toContain('OK')
  })
})

describe('logFile and logHash — §8.2 canonical form', () => {
  it('terminates every line with a single \\n, including the last', () => {
    const bytes = logFile(['a', 'bb'])
    expect(bytes).toEqual(Uint8Array.from([0x61, 0x0a, 0x62, 0x62, 0x0a]))
  })

  it('is empty for an empty log', () => {
    expect(logFile([])).toEqual(new Uint8Array(0))
    expect(logHash([])).toEqual(keccak_256(new Uint8Array(0)))
  })

  it('hashes the file bytes, not the lines', () => {
    const lines = [canonicalLogLine(tx(), OK), canonicalLogLine(tx({ txIndex: 1 }), OK)]
    expect(logHash(lines)).toEqual(keccak_256(logFile(lines)))
  })

  it('changes if a single character moves', () => {
    const a = logHash([canonicalLogLine(tx({ txIndex: 0 }), OK)])
    const b = logHash([canonicalLogLine(tx({ txIndex: 1 }), OK)])
    expect(a).not.toEqual(b)
  })

  it('changes if two lines swap — canonical order is part of the commitment', () => {
    const first = canonicalLogLine(tx({ txIndex: 0 }), OK)
    const second = canonicalLogLine(tx({ txIndex: 1 }), OK)
    expect(logHash([first, second])).not.toEqual(logHash([second, first]))
  })

  it('rejects a non-ASCII line rather than encoding it silently', () => {
    expect(() => logFile(['café'])).toThrow(LogError)
  })
})
