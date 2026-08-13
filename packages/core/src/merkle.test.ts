import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { addressToBytes } from './address.js'
import { CONSTANTS } from './constants.js'
import {
  HASH_BYTES,
  MerkleError,
  bytesEqual,
  checkpoint,
  compareNames,
  encodeLeaf,
  leafHash,
  merkleNonInclusion,
  merkleProof,
  merkleRoot,
  pendingCommitment,
  sortedRecords,
  unreservedCommitment,
  verifyProof,
} from './merkle.js'
import { type NameRecord, type NnsState, initialState } from './state.js'
import { ALICE, BOB, CAROL, testConfig } from './test-fixtures.js'

const config = testConfig()

const record = (over: Partial<NameRecord> & { name: string }): NameRecord => ({
  owner: ALICE,
  target: ALICE,
  expiry: 215_680_000,
  status: 'REGISTERED',
  recovery: null,
  host: '',
  ...over,
})

const stateWith = (...records: NameRecord[]): NnsState =>
  Object.freeze({
    ...initialState(config),
    names: new Map(records.map((r) => [r.name, r])),
  })

describe('§8.1 leaf byte layout', () => {
  it('lays the fields out exactly as the spec writes them', () => {
    const r = record({ name: 'kike-one', target: BOB, recovery: CAROL, host: 'nns.x.com', status: 'GRACE' })
    const enc = encodeLeaf(r)

    // len(name):u8 ‖ name ‖ owner:20 ‖ target:20 ‖ expiry:u64BE ‖ status:u8
    //   ‖ recovery:20 ‖ len(host):u8 ‖ host
    expect(enc).toHaveLength(1 + 8 + 20 + 20 + 8 + 1 + 20 + 1 + 9)

    let at = 0
    expect(enc[at++]).toBe(8)
    expect(enc.slice(at, (at += 8))).toEqual(Uint8Array.from([...'kike-one'].map((c) => c.charCodeAt(0))))
    expect(enc.slice(at, (at += 20))).toEqual(addressToBytes(ALICE))
    expect(enc.slice(at, (at += 20))).toEqual(addressToBytes(BOB))
    expect(enc.slice(at, (at += 8))).toEqual(Uint8Array.from([0, 0, 0, 0, 0x0c, 0xdb, 0x04, 0x00])) // 215,680,000
    expect(enc[at++]).toBe(0x01) // GRACE
    expect(enc.slice(at, (at += 20))).toEqual(addressToBytes(CAROL))
    expect(enc[at++]).toBe(9)
    expect(enc.slice(at)).toEqual(Uint8Array.from([...'nns.x.com'].map((c) => c.charCodeAt(0))))
  })

  it('writes the expiry big-endian', () => {
    const enc = encodeLeaf(record({ name: 'kikename', expiry: 1 }))
    expect(enc.slice(1 + 8 + 40, 1 + 8 + 40 + 8)).toEqual(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1]))
  })

  it('encodes an unset recovery address as 20 zero bytes', () => {
    const enc = encodeLeaf(record({ name: 'kikename', recovery: null }))
    expect(enc.slice(1 + 8 + 40 + 8 + 1, 1 + 8 + 40 + 8 + 1 + 20)).toEqual(new Uint8Array(20))
  })

  it('encodes an unset host as a zero length prefix and nothing more', () => {
    const enc = encodeLeaf(record({ name: 'kikename', host: '' }))
    expect(enc[enc.length - 1]).toBe(0)
  })

  it('uses 0x00 for REGISTERED and 0x01 for GRACE', () => {
    const at = 1 + 8 + 40 + 8
    expect(encodeLeaf(record({ name: 'kikename', status: 'REGISTERED' }))[at]).toBe(0x00)
    expect(encodeLeaf(record({ name: 'kikename', status: 'GRACE' }))[at]).toBe(0x01)
  })

  it('domain-separates the leaf with 0x00', () => {
    const r = record({ name: 'kikename' })
    expect(leafHash(r)).toEqual(keccak_256(Uint8Array.from([0x00, ...encodeLeaf(r)])))
  })

  it('gives no two distinct states the same encoding, because every field is length-prefixed', () => {
    // Without the length prefixes, "ab" + host "c" and "abc" + no host would
    // collide. With them, they cannot.
    const a = encodeLeaf(record({ name: 'kikenam', host: 'e' }))
    const b = encodeLeaf(record({ name: 'kikename', host: '' }))
    expect(bytesToHex(a)).not.toBe(bytesToHex(b))
  })

  it('leaves the referrer out — it is accounting, not registry state', () => {
    // NameRecord has no ref field at all, which is the structural guarantee.
    expect(Object.keys(record({ name: 'kikename' })).sort()).toEqual([
      'expiry',
      'host',
      'name',
      'owner',
      'recovery',
      'status',
      'target',
    ])
  })
})

describe('compareNames — bytewise-lexicographic', () => {
  it('orders by byte value, putting digits and hyphen before letters', () => {
    const sorted = ['kike-one', 'kike0one', 'kikename', 'zebraname'].sort(compareNames)
    expect(sorted).toEqual(['kike-one', 'kike0one', 'kikename', 'zebraname'])
  })

  it('sorts a prefix before the string that extends it', () => {
    expect(compareNames('kikename', 'kikenames')).toBeLessThan(0)
  })

  it('agrees with JavaScript string comparison across the permitted character set', () => {
    const chars = [...'abcdefghijklmnopqrstuvwxyz0123456789-']
    const names = chars.flatMap((a) => chars.slice(0, 6).map((b) => `nn${a}${b}n`))
    const byBytes = [...names].sort(compareNames)
    const byString = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    expect(byBytes).toEqual(byString)
  })
})

describe('merkleRoot', () => {
  it('is 32 zero bytes for an empty tree', () => {
    expect(merkleRoot(initialState(config))).toEqual(new Uint8Array(HASH_BYTES))
  })

  it('is the leaf hash itself for a single leaf', () => {
    const r = record({ name: 'kikename' })
    expect(merkleRoot(stateWith(r))).toEqual(leafHash(r))
  })

  it('hashes a pair with the 0x01 node prefix', () => {
    const a = record({ name: 'aaaaaname' })
    const b = record({ name: 'bbbbbname' })
    const expected = keccak_256(Uint8Array.from([0x01, ...leafHash(a), ...leafHash(b)]))
    expect(merkleRoot(stateWith(a, b))).toEqual(expected)
  })

  it('promotes the odd node unchanged', () => {
    const a = record({ name: 'aaaaaname' })
    const b = record({ name: 'bbbbbname' })
    const c = record({ name: 'cccccname' })
    const ab = keccak_256(Uint8Array.from([0x01, ...leafHash(a), ...leafHash(b)]))
    const expected = keccak_256(Uint8Array.from([0x01, ...ab, ...leafHash(c)]))
    expect(merkleRoot(stateWith(a, b, c))).toEqual(expected)
  })

  it('does not depend on insertion order — leaves are sorted', () => {
    const a = record({ name: 'aaaaaname' })
    const b = record({ name: 'bbbbbname' })
    const c = record({ name: 'cccccname' })
    expect(merkleRoot(stateWith(c, a, b))).toEqual(merkleRoot(stateWith(a, b, c)))
  })

  it('changes when any committed field changes', () => {
    const base = record({ name: 'kikename' })
    const root = merkleRoot(stateWith(base))
    for (const variant of [
      record({ name: 'kikename', owner: BOB }),
      record({ name: 'kikename', target: BOB }),
      record({ name: 'kikename', expiry: base.expiry + 1 }),
      record({ name: 'kikename', status: 'GRACE' }),
      record({ name: 'kikename', recovery: BOB }),
      record({ name: 'kikename', host: 'a.com' }),
    ]) {
      expect(bytesEqual(merkleRoot(stateWith(variant)), root)).toBe(false)
    }
  })

  it('keeps grace names in the tree, which is what makes non-inclusion mean AVAILABLE', () => {
    expect(sortedRecords(stateWith(record({ name: 'kikename', status: 'GRACE' })))).toHaveLength(1)
  })
})

describe('merkleProof', () => {
  const names = ['aaaaaname', 'bbbbbname', 'cccccname', 'dddddname', 'eeeeename']
  const records = names.map((name) => record({ name }))
  const state = stateWith(...records)

  it('verifies every leaf against the root, at every tree size', () => {
    for (let size = 1; size <= records.length; size++) {
      const subset = stateWith(...records.slice(0, size))
      const root = merkleRoot(subset)
      for (const name of names.slice(0, size)) {
        const proof = merkleProof(subset, name)
        expect(proof).not.toBeNull()
        expect(verifyProof(proof!.leaf, proof!.steps, root)).toBe(true)
      }
    }
  })

  it('returns null for a name that is not in the tree', () => {
    expect(merkleProof(state, 'missingname')).toBeNull()
  })

  it('fails verification against a tampered leaf', () => {
    const proof = merkleProof(state, 'cccccname')!
    const tampered = leafHash(record({ name: 'cccccname', owner: BOB }))
    expect(verifyProof(tampered, proof.steps, proof.root)).toBe(false)
  })

  it('fails verification when a sibling swaps sides', () => {
    const proof = merkleProof(state, 'bbbbbname')!
    const flipped = proof.steps.map((s) => ({ ...s, side: s.side === 'left' ? ('right' as const) : ('left' as const) }))
    expect(verifyProof(proof.leaf, flipped, proof.root)).toBe(false)
  })

  it('contributes no step for a promoted node', () => {
    // Index 4 of 5 is promoted unchanged at levels 0 and 1, and only meets a
    // sibling at level 2 — so the proof is one step, not the three a
    // balanced tree of this depth would need.
    const proof = merkleProof(state, 'eeeeename')!
    expect(proof.index).toBe(4)
    expect(proof.steps).toHaveLength(1)
    expect(proof.steps[0]?.side).toBe('left')

    // Index 0 of 5 meets a sibling at every level.
    expect(merkleProof(state, 'aaaaaname')?.steps).toHaveLength(3)
  })
})

describe('merkleNonInclusion — §8.3', () => {
  const records = ['bbbbbname', 'dddddname', 'fffffname'].map((name) => record({ name }))
  const state = stateWith(...records)

  it('reports an empty tree', () => {
    expect(merkleNonInclusion(initialState(config), 'kikename').kind).toBe('EMPTY_TREE')
  })

  it('returns the two bracketing leaves for a name in the middle', () => {
    const proof = merkleNonInclusion(state, 'cccccname')
    expect(proof.kind).toBe('BETWEEN')
    if (proof.kind !== 'BETWEEN') throw new Error('unreachable')
    expect(proof.previous.name).toBe('bbbbbname')
    expect(proof.next.name).toBe('dddddname')
    expect(verifyProof(proof.previous.leaf, proof.previous.steps, proof.root)).toBe(true)
    expect(verifyProof(proof.next.leaf, proof.next.steps, proof.root)).toBe(true)
  })

  it('returns a single boundary leaf past either end', () => {
    const before = merkleNonInclusion(state, 'aaaaaname')
    expect(before.kind).toBe('BEFORE_FIRST')
    const after = merkleNonInclusion(state, 'zzzzzname')
    expect(after.kind).toBe('AFTER_LAST')
  })

  it('refuses when the name is actually in the tree', () => {
    expect(() => merkleNonInclusion(state, 'dddddname')).toThrow(MerkleError)
  })
})

describe('checkpoint — §8.1 final clause', () => {
  it('binds the name root, prices, pending set, log hash and height', () => {
    const state = stateWith(record({ name: 'kikename' }))
    const log = new Uint8Array(HASH_BYTES).fill(7)
    const base = checkpoint(state, log)

    expect(base.nameRoot).toEqual(merkleRoot(state))
    expect(base.commitment).toHaveLength(HASH_BYTES)

    // A different log hash, height or price set must move the commitment.
    expect(bytesEqual(checkpoint(state, new Uint8Array(HASH_BYTES).fill(8)).commitment, base.commitment)).toBe(false)
    const later = Object.freeze({ ...state, height: state.height + 1 })
    expect(bytesEqual(checkpoint(later, log).commitment, base.commitment)).toBe(false)
    const repriced = Object.freeze({ ...state, prices: { ...state.prices, feeStandard: 1n } })
    expect(bytesEqual(checkpoint(repriced, log).commitment, base.commitment)).toBe(false)
  })

  it('moves when the pending set changes — the reason §8.1 requires it committed', () => {
    const state = stateWith(record({ name: 'kikename' }))
    const empty = pendingCommitment(state)

    const withTransfer = Object.freeze({
      ...state,
      transfers: new Map([
        ['kikename', { name: 'kikename', newOwner: BOB, effectiveHeight: 100, viaRecovery: false }],
      ]),
    })
    expect(bytesEqual(pendingCommitment(withTransfer), empty)).toBe(false)

    const withOffer = Object.freeze({
      ...state,
      offers: new Map([
        ['kikename', { name: 'kikename', seller: ALICE, price: 5n, openedHeight: 1, expiryHeight: 2 }],
      ]),
    })
    expect(bytesEqual(pendingCommitment(withOffer), empty)).toBe(false)
  })

  it('also commits a pending P and a pending U, which §8.1 does not enumerate', () => {
    const state = stateWith(record({ name: 'kikename' }))
    const empty = pendingCommitment(state)

    const withGovernance = Object.freeze({
      ...state,
      pendingGovernance: {
        prices: { feeStandard: 1n, feeLong: 1n, commissionBp: 0n },
        effectiveHeight: 100,
      },
    })
    expect(bytesEqual(pendingCommitment(withGovernance), empty)).toBe(false)

    const withUnreserve = Object.freeze({
      ...state,
      pendingUnreserve: new Map([['binance', { name: 'binance', recipient: null, effectiveHeight: 100 }]]),
    })
    expect(bytesEqual(pendingCommitment(withUnreserve), empty)).toBe(false)
  })

  it('commits a pending U’s recipient — release and award are different bytes (r17)', () => {
    // Two indexers agreeing a U is pending and disagreeing about who the name
    // goes to must not derive identical checkpoints until it fires — the shape
    // of hole tag 0x0A closed in r16, this time with an owner at stake (§8.1).
    const state = stateWith(record({ name: 'kikename' }))
    const pendingTo = (recipient: typeof BOB | null): NnsState =>
      Object.freeze({
        ...state,
        pendingUnreserve: new Map([['binance', { name: 'binance', recipient, effectiveHeight: 100 }]]),
      })
    const release = pendingCommitment(pendingTo(null))
    expect(bytesEqual(pendingCommitment(pendingTo(BOB)), release)).toBe(false)
    expect(bytesEqual(pendingCommitment(pendingTo(ALICE)), pendingCommitment(pendingTo(BOB)))).toBe(false)

    // The release form is the same 20 zero bytes a clearing R uses — pinned
    // byte for byte so "no recipient" can never drift to a sentinel address.
    expect(release).toEqual(
      keccak_256(
        Uint8Array.from([
          0x04,
          0x09,
          7, ...[...'binance'].map((c) => c.charCodeAt(0)),
          ...new Uint8Array(20),
          0, 0, 0, 0, 0, 0, 0, 100,
        ]),
      ),
    )
  })

  it('moves when a U fires — the r16 hole, tag 0x0A', () => {
    const state = stateWith(record({ name: 'kikename' }))
    const log = new Uint8Array(HASH_BYTES).fill(7)
    // A fired `U` leaves no leaf and no pending entry, so through r15 these two
    // states committed alike while disagreeing about whether `binance` was
    // registrable at all.
    const released = Object.freeze({ ...state, unreserved: new Set(['binance']) })
    expect(bytesEqual(checkpoint(released, log).commitment, checkpoint(state, log).commitment)).toBe(false)
  })

  it('commits an empty unreserved set as keccak256 of its tag byte alone', () => {
    expect(unreservedCommitment(initialState(config))).toEqual(keccak_256(Uint8Array.of(0x0a)))
  })

  it('orders the unreserved names bytewise, so insertion order cannot move a root', () => {
    const forward = Object.freeze({ ...initialState(config), unreserved: new Set(['aname', 'bname', 'cname']) })
    const backward = Object.freeze({ ...initialState(config), unreserved: new Set(['cname', 'aname', 'bname']) })
    expect(unreservedCommitment(forward)).toEqual(unreservedCommitment(backward))
    expect(unreservedCommitment(forward)).toEqual(
      keccak_256(
        Uint8Array.from([
          0x0a,
          5, ...[...'aname'].map((c) => c.charCodeAt(0)),
          5, ...[...'bname'].map((c) => c.charCodeAt(0)),
          5, ...[...'cname'].map((c) => c.charCodeAt(0)),
        ]),
      ),
    )
  })

  it('length-prefixes the names, so no two sets share an encoding', () => {
    const split = Object.freeze({ ...initialState(config), unreserved: new Set(['ab', 'cd']) })
    const joined = Object.freeze({ ...initialState(config), unreserved: new Set(['abcd']) })
    expect(bytesEqual(unreservedCommitment(split), unreservedCommitment(joined))).toBe(false)
  })

  it('rejects a log hash of the wrong length', () => {
    expect(() => checkpoint(initialState(config), new Uint8Array(31))).toThrow(MerkleError)
  })

  it('is stable across identical states built independently', () => {
    const a = stateWith(record({ name: 'kikename' }), record({ name: 'othername' }))
    const b = stateWith(record({ name: 'othername' }), record({ name: 'kikename' }))
    const log = new Uint8Array(HASH_BYTES)
    expect(checkpoint(a, log).commitment).toEqual(checkpoint(b, log).commitment)
  })
})

describe('a name longer than a u8 length prefix cannot occur', () => {
  it('because MAX_NAME_LEN and MAX_HOST_LEN are both well under 255', () => {
    expect(CONSTANTS.MAX_NAME_LEN).toBeLessThan(256)
    expect(CONSTANTS.MAX_HOST_LEN).toBeLessThan(256)
  })
})
