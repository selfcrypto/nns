import { keccak_256 } from '@noble/hashes/sha3.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { LogError, canonicalLogLine, cidFromDigest, createLogHasher, digestFromCid, logFile, logHash, parseLogLine, verdictToken } from './log.js'
import type { ChainTransaction, Verdict } from './reduce.js'
import { ALICE, MAINNET_ID, TREASURY } from './test-fixtures.js'
import { unionMembers } from './vocabulary-fixture.js'

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
    //
    // Both sets come from the declarations themselves: this test once carried a
    // hand-copied list, which drifted a token behind `ForfeitReason` and so
    // stopped covering the token it had lost.
    const forfeits = unionMembers('ForfeitReason')
    const refunds = unionMembers('RefundReason')

    const overlap = forfeits.filter((reason) => refunds.includes(reason))
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

describe('createLogHasher — the incremental form of the same value', () => {
  const lines = [
    canonicalLogLine(tx({ txIndex: 0 }), OK),
    canonicalLogLine(tx({ txIndex: 1 }), OK),
    canonicalLogLine(tx({ blockNumber: 58_177_020, txIndex: 0 }), OK),
  ]

  it('agrees with logHash at every prefix', () => {
    // The property an indexer depends on: a checkpoint taken after line n must
    // equal the hash of the file that ends at line n. Anything less and a
    // streamed root is unverifiable by a replayer that hashes the file.
    const hasher = createLogHasher()
    expect(hasher.digest()).toEqual(logHash([]))
    lines.forEach((line, index) => {
      hasher.append(line)
      expect(hasher.digest()).toEqual(logHash(lines.slice(0, index + 1)))
      expect(hasher.lines).toBe(index + 1)
    })
  })

  it('does not end the stream when it digests', () => {
    const hasher = createLogHasher()
    hasher.append(lines[0] as string)
    const first = hasher.digest()
    expect(hasher.digest()).toEqual(first)
    hasher.append(lines[1] as string)
    expect(hasher.digest()).toEqual(logHash(lines.slice(0, 2)))
  })

  it('rejects a non-ASCII line, exactly as logFile does', () => {
    expect(() => createLogHasher().append('café')).toThrow(LogError)
  })
})

describe('cidFromDigest', () => {
  // Ground truth is kubo 0.32.1: `ipfs add --only-hash --cid-version=1
  // --raw-leaves=false --chunker=size-262144 -Q <file>`, cross-checked against
  // ipfs-unixfs-importer 17.0.1 with §8.2's parameters (identical CIDs, both
  // cases, 2026-08-14).

  it('rebuilds the CID of the empty log — the first snapshot a publisher could anchor', () => {
    // The digest is also plain sha2-256 of the canonical empty UnixFS file
    // block `0a 04 08 02 18 00`, confirmable with sha256sum alone.
    expect(cidFromDigest(hexToBytes('bfccda787baba32b59c78450ac3d20b633360b43992c77289f9ed46d843561e6'))).toBe(
      'bafybeif7ztnhq65lumvvtr4ekcwd2ifwgm3awq4zfr3srh462rwyinlb4y',
    )
  })

  it('rebuilds the CID of "hello world\\n"', () => {
    expect(cidFromDigest(hexToBytes('46d44814b9c5af141c3aaab7c05dc5e844ead5f91f12858b021eba45768b4c0e'))).toBe(
      'bafybeicg2rebjoofv4kbyovkw7af3rpiitvnl6i7ckcywaq6xjcxnc2mby',
    )
  })

  it('refuses any digest that is not 32 bytes', () => {
    expect(() => cidFromDigest(new Uint8Array(31))).toThrow(LogError)
    expect(() => cidFromDigest(new Uint8Array(33))).toThrow(LogError)
    expect(() => cidFromDigest(new Uint8Array(0))).toThrow(LogError)
  })
})

describe('digestFromCid', () => {
  // A base32 CIDv1 string over arbitrary prefix bytes, for building the
  // near-miss cases below. Deliberately local to the test: the shipped
  // encoder only ever emits the §8.2 prefix.
  function base32Cid(prefix: readonly number[], digest: Uint8Array): string {
    const bytes = Uint8Array.from([...prefix, ...digest])
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
    let out = 'b'
    let value = 0
    let bits = 0
    for (const byte of bytes) {
      value = (value << 8) | byte
      bits += 8
      while (bits >= 5) {
        bits -= 5
        out += alphabet.charAt((value >>> bits) & 31)
      }
    }
    if (bits > 0) out += alphabet.charAt((value << (5 - bits)) & 31)
    return out
  }

  it('inverts cidFromDigest on the pinned pairs', () => {
    for (const hex of [
      'bfccda787baba32b59c78450ac3d20b633360b43992c77289f9ed46d843561e6',
      '46d44814b9c5af141c3aaab7c05dc5e844ead5f91f12858b021eba45768b4c0e',
    ]) {
      const digest = hexToBytes(hex)
      expect(digestFromCid(cidFromDigest(digest))).toEqual(digest)
    }
  })

  it('extracts the digest from the pinned kubo CID directly', () => {
    expect(digestFromCid('bafybeif7ztnhq65lumvvtr4ekcwd2ifwgm3awq4zfr3srh462rwyinlb4y')).toEqual(
      hexToBytes('bfccda787baba32b59c78450ac3d20b633360b43992c77289f9ed46d843561e6'),
    )
  })

  it('refuses a raw-leaves CID — the kubo --cid-version=1 default trap', () => {
    const digest = hexToBytes('46d44814b9c5af141c3aaab7c05dc5e844ead5f91f12858b021eba45768b4c0e')
    // 0x55 is the raw codec: what kubo mints for a single-chunk file unless
    // --raw-leaves=false is passed explicitly (§8.2).
    expect(() => digestFromCid(base32Cid([0x01, 0x55, 0x12, 0x20], digest))).toThrow(/raw-leaves/)
  })

  it('refuses the wrong multibase, length, alphabet and padding', () => {
    const good = 'bafybeif7ztnhq65lumvvtr4ekcwd2ifwgm3awq4zfr3srh462rwyinlb4y'
    expect(() => digestFromCid(`z${good.slice(1)}`)).toThrow(LogError) // not multibase b
    expect(() => digestFromCid(good.slice(0, -1))).toThrow(LogError) // 58 chars
    expect(() => digestFromCid(`${good}a`)).toThrow(LogError) // 60 chars
    expect(() => digestFromCid(good.slice(0, -1) + '1')).toThrow(LogError) // '1' not in RFC 4648 base32
    expect(() => digestFromCid(good.toUpperCase())).toThrow(LogError) // uppercase is a different multibase
    // Last char with non-zero padding bits: 'y' ends the pinned CID with two
    // zero pad bits; '7' (31) has them set.
    expect(() => digestFromCid(good.slice(0, -1) + '7')).toThrow(/padding/)
  })
})
