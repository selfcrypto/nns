import { formatAddress } from '@nimiqnames/core'
import { describe, expect, it } from 'vitest'

import { readInclusionDocument, readNonInclusionDocument } from './documents.js'
import { ProofError } from './errors.js'
import { address, inclusionJson, nonInclusionJson, record } from './test-fixtures.js'
import { verifyInclusion, verifyNonInclusion } from './verify.js'

/**
 * The tree sizes matter more than they look. §8.1 promotes odd nodes
 * unchanged, so the tree's *shape* — and therefore which levels contribute a
 * proof step at all — depends on the leaf count. A verifier that works at 4
 * leaves and not at 5 is the exact bug §8.3's `side` field exists to prevent,
 * so every case below runs across a spread that includes both.
 */
const SIZES = [1, 2, 3, 4, 5, 8, 9]

const names = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `name${String(i).padStart(2, '0')}`)

const treeOfSize = (count: number) => names(count).map((name) => record(name))

describe('inclusion', () => {
  for (const size of SIZES) {
    it(`verifies every leaf of a ${size}-leaf tree`, () => {
      const records = treeOfSize(size)
      for (const { name } of records) {
        const document = readInclusionDocument(inclusionJson(records, name))
        expect(verifyInclusion(document, name).name).toBe(name)
      }
    })
  }

  it('verifies a leaf carrying every optional field', () => {
    const records = [
      record('alpha'),
      record('bravo', { host: 'nns.binance.com', status: 'GRACE' }),
      record('charlie'),
    ]
    const document = readInclusionDocument(inclusionJson(records, 'bravo'))
    const proven = verifyInclusion(document, 'bravo')
    expect(proven.host).toBe('nns.binance.com')
    expect(proven.status).toBe('GRACE')
  })

  // Each of these is a field the §8.1 leaf encodes. Changing one and keeping
  // the path is precisely the attack the format exists to defeat: the proof
  // still "looks like" a proof, and the preimage no longer hashes to it.
  const attacker = formatAddress(address(42))
  const tampered: ReadonlyArray<readonly [string, (json: Record<string, unknown>) => void]> = [
    ['owner', (json) => void (json['owner'] = attacker)],
    ['target', (json) => void (json['target'] = attacker)],
    ['expiry', (json) => void (json['expiry'] = 1)],
    ['status', (json) => void (json['status'] = 'GRACE')],
    // The stripped-field case: `delegate` inherits the witness `recovery` held
    // until r20 removed it. A leaf field silently dropped from the document
    // must break verification, or the document stops binding the record (§8.3).
    ['delegate stripped', (json) => void (json['delegate'] = null)],
    ['delegate', (json) => void (json['delegate'] = 'evil.example')],
    // `evm` joined the leaf in r26 and carries the same witness: a cleared or
    // substituted record must stop the preimage hashing to the proven leaf.
    ['evm stripped', (json) => void (json['evm'] = '')],
    ['evm', (json) => void (json['evm'] = '0x00000000000000000000000000000000000000ff')],
  ]

  for (const [field, mutate] of tampered) {
    it(`rejects a proof whose ${field} was altered`, () => {
      const records = [
        record('alpha'),
        record('bravo', { host: 'ok.example', evm: '0x1b3f6a09e2c40d55c8a1b2c3d4e5f60718293a4b' }),
        record('charlie'),
      ]
      const json = inclusionJson(records, 'bravo')
      mutate(json)
      expect(() => verifyInclusion(readInclusionDocument(json), 'bravo')).toThrow(ProofError)
    })
  }

  it('rejects a valid proof of a different name', () => {
    const records = treeOfSize(5)
    const document = readInclusionDocument(inclusionJson(records, 'name02'))
    expect(() => verifyInclusion(document, 'name03')).toThrow(/proof is for "name02"/)
  })

  it('rejects a flipped step side', () => {
    const records = treeOfSize(5)
    const json = inclusionJson(records, 'name01')
    const steps = json['proof'] as { side: string }[]
    const first = steps[0] as { side: string }
    first.side = first.side === 'left' ? 'right' : 'left'
    expect(() => verifyInclusion(readInclusionDocument(json), 'name01')).toThrow(ProofError)
  })

  it('rejects an odd leaf_index whose first sibling is not on the left', () => {
    // name00 is leaf 0 and every sibling on its path sits to the right.
    // Relabelling it as an odd index is unverifiable arithmetic, and
    // non-inclusion adjacency is computed from exactly this number.
    const records = treeOfSize(5)
    const json = inclusionJson(records, 'name00')
    json['leaf_index'] = 3
    expect(() => verifyInclusion(readInclusionDocument(json), 'name00')).toThrow(/odd/)
  })
})

describe('non-inclusion', () => {
  for (const size of SIZES) {
    it(`proves a name absent from the middle of a ${size}-leaf tree`, () => {
      const records = treeOfSize(size)
      // Sorts strictly between name00 and name01 without colliding with either.
      const document = readNonInclusionDocument(nonInclusionJson(records, 'name00a'))
      expect(() => verifyNonInclusion(document, 'name00a')).not.toThrow()
    })

    it(`proves a name before the first leaf of a ${size}-leaf tree`, () => {
      const records = treeOfSize(size)
      const document = readNonInclusionDocument(nonInclusionJson(records, 'aaaaa'))
      expect(() => verifyNonInclusion(document, 'aaaaa')).not.toThrow()
    })

    it(`proves a name after the last leaf of a ${size}-leaf tree`, () => {
      const records = treeOfSize(size)
      const document = readNonInclusionDocument(nonInclusionJson(records, 'zzzzz'))
      expect(() => verifyNonInclusion(document, 'zzzzz')).not.toThrow()
    })
  }

  it('accepts the empty tree, whose all-zero root is itself the proof', () => {
    const document = readNonInclusionDocument(nonInclusionJson([], 'kikeee'))
    expect(() => verifyNonInclusion(document, 'kikeee')).not.toThrow()
  })

  it('rejects an empty-tree claim over a non-zero root', () => {
    const json = nonInclusionJson([], 'kikeee')
    json['root'] = `0x${'11'.repeat(32)}`
    expect(() => verifyNonInclusion(readNonInclusionDocument(json), 'kikeee')).toThrow(/32 zero bytes/)
  })

  it('rejects brackets that are not adjacent', () => {
    // Both leaves are genuinely in the tree and both proofs verify — and the
    // gap between them still holds name01, so it proves nothing about it.
    const records = treeOfSize(5)
    const json = nonInclusionJson(records, 'name00a')
    json['next'] = nonInclusionJson(records, 'name02a')['next']
    expect(() => verifyNonInclusion(readNonInclusionDocument(json), 'name00a')).toThrow(/not adjacent/)
  })

  it('rejects a bracket that does not bracket', () => {
    const records = treeOfSize(5)
    const json = nonInclusionJson(records, 'name00a')
    expect(() => verifyNonInclusion(readNonInclusionDocument(json), 'name03a')).toThrow(/brackets nothing/)
  })

  it('rejects a before-first claim over a leaf that is not leftmost', () => {
    const records = treeOfSize(5)
    const json = nonInclusionJson(records, 'name02a')
    json['previous'] = null
    json['kind'] = 'BEFORE_FIRST'
    expect(() => verifyNonInclusion(readNonInclusionDocument(json), 'name02a')).toThrow(/not the leftmost leaf/)
  })

  it('rejects an after-last claim over a leaf that is not rightmost', () => {
    const records = treeOfSize(5)
    const json = nonInclusionJson(records, 'name02a')
    json['next'] = null
    json['kind'] = 'AFTER_LAST'
    expect(() => verifyNonInclusion(readNonInclusionDocument(json), 'name02a')).toThrow(/not the rightmost leaf/)
  })

  it('rejects a kind that disagrees with the leaves present', () => {
    const records = treeOfSize(5)
    const json = nonInclusionJson(records, 'name02a')
    json['kind'] = 'AFTER_LAST'
    expect(() => readNonInclusionDocument(json)).toThrow(/says AFTER_LAST/)
  })
})
