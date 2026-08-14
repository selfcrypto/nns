/**
 * The conformance vector runner.
 *
 * The vectors are a shipped deliverable (§14), so the JSON is the artifact and
 * this file is only one consumer of it. An independent implementation reads
 * the JSON, not this TypeScript.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { parse } from '../src/codec.js'
import { canonicalLogLine, logHash } from '../src/log.js'
import {
  checkpoint,
  compareNames,
  encodeLeaf,
  leafHash,
  merkleNonInclusion,
  merkleProof,
  merkleRoot,
  verifyProof,
} from '../src/merkle.js'
import { isValidRef, parseQuery, validateHost, validateLabel, validateName } from '../src/name.js'
import { advanceTo, reduce } from '../src/reduce.js'
import { type NameRecord, type NnsState, initialState, lookup, resolve } from '../src/state.js'
import {
  type VectorRecord,
  build,
  hexOf,
  readAddresses,
  readCheckpointState,
  readConfig,
  readRecord,
  readTx,
} from './support.js'

const here = dirname(fileURLToPath(import.meta.url))
const load = (name: string): any => JSON.parse(readFileSync(join(here, name), 'utf8'))

/** Turn a case list into the [id, case] pairs `it.each` labels tests with. */
const entries = (list: readonly any[]): Array<[string, any]> => list.map((item) => [item.id, item])

// ── names.json ──────────────────────────────────────────────────────────────

describe('vectors/names.json', () => {
  const file = load('names.json')

  it.each(entries(file.cases))('name %s', (_id, testCase: any) => {
    const reserved = new Set<string>(testCase.reserved ?? [])
    const unreserved = new Set<string>(testCase.unreserved ?? [])
    const result = validateName(testCase.name, reserved, unreserved)
    expect(result.ok).toBe(testCase.valid)
    if (!testCase.valid) expect(result).toEqual({ ok: false, reason: testCase.reason })
  })

  it.each(entries(file.labels.cases))('label %s', (_id, testCase: any) => {
    const result = validateLabel(testCase.label)
    expect(result.ok).toBe(testCase.valid)
    if (!testCase.valid) expect(result).toEqual({ ok: false, reason: testCase.reason })
  })

  it.each(entries(file.hosts.cases))('host %s', (_id, testCase: any) => {
    const result = validateHost(testCase.host)
    expect(result.ok).toBe(testCase.valid)
    if (!testCase.valid) expect(result).toEqual({ ok: false, reason: testCase.reason })
  })

  it.each(entries(file.refs.cases))('ref %s', (_id, testCase: any) => {
    expect(isValidRef(testCase.ref)).toBe(testCase.valid)
  })

  it.each(entries(file.queries.cases))('query %s', (_id, testCase: any) => {
    const result = parseQuery(testCase.query)
    if (testCase.kind === 'invalid') {
      expect(result).toMatchObject({ ok: false, reason: testCase.reason })
      return
    }
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.query).toEqual(
      testCase.kind === 'name'
        ? { kind: 'name', name: testCase.name }
        : { kind: 'dotted', label: testCase.label, parent: testCase.parent },
    )
  })
})

// ── codec.json ──────────────────────────────────────────────────────────────

describe('vectors/codec.json', () => {
  const file = load('codec.json')
  const book = readAddresses(file.addresses)
  const config = readConfig(file.config, book)

  /** Message fields arrive as strings for luna and numbers for heights. */
  const normalise = (message: any): any =>
    Object.fromEntries(
      Object.entries(message).map(([key, value]) => [
        key,
        ['price', 'reserve', 'feeStandard', 'feeLong', 'commissionBp'].includes(key) ? BigInt(value as string) : value,
      ]),
    )

  it.each(entries(file.roundTrip.cases))('%s round-trips', (_id, testCase: any) => {
    // `data` must be the hex of the authored `text`, so the reviewable field
    // and the machine field cannot drift apart.
    expect(testCase.data).toBe(hexOf(testCase.text))

    const built = build(config, testCase.build, testCase.message.name ?? '', book)
    expect(built.data).toBe(testCase.data)
    expect(built.recipient).toBe(book[testCase.recipient])
    expect(built.value).toBe(BigInt(testCase.value))
    if (testCase.byteLength !== undefined) expect(testCase.data.length / 2).toBe(testCase.byteLength)

    expect(parse(testCase.data)).toEqual({ ok: true, message: normalise(testCase.message) })
  })

  it.each(entries(file.parseOnly.cases))('%s parses as stated', (_id, testCase: any) => {
    if (typeof testCase.text === 'string') expect(testCase.data).toBe(hexOf(testCase.text))
    const result = parse(testCase.data)
    if (testCase.result.ok) {
      expect(result).toEqual({ ok: true, message: normalise(testCase.result.message) })
    } else {
      expect(result).toEqual({ ok: false, reason: testCase.result.reason })
    }
  })

  it.each(entries(file.builderErrors.cases))('%s throws in the builder', (_id, testCase: any) => {
    const caseConfig =
      testCase.reservedNames === undefined
        ? config
        : readConfig({ ...file.config, reservedNames: testCase.reservedNames }, book)
    expect(() => build(caseConfig, testCase, testCase.name, book)).toThrow()
  })

  it('covers all fourteen §6 message types', () => {
    const covered = new Set(file.roundTrip.cases.map((c: any) => c.message.type))
    expect([...covered].sort()).toEqual(['A', 'B', 'D', 'F', 'G', 'K', 'M', 'N', 'O', 'P', 'R', 'S', 'U', 'X'])
  })
})

// ── merkle.json ─────────────────────────────────────────────────────────────

describe('vectors/merkle.json', () => {
  const file = load('merkle.json')
  const book = readAddresses(file.addresses)
  const reduceFile = load('reduce.json')
  const config = readConfig(reduceFile.config, readAddresses(reduceFile.addresses))

  const stateWith = (records: NameRecord[]): NnsState =>
    Object.freeze({ ...initialState(config), names: new Map(records.map((r) => [r.name, r])) })

  const recordsFor = (testCase: any): NameRecord[] =>
    (testCase.names as string[]).map((name) =>
      readRecord({ name, ...file.roots.defaults, ...(testCase.overrides?.[name] ?? {}) } as VectorRecord, book),
    )

  it.each(entries(file.leaves.cases))('leaf %s', (_id, testCase: any) => {
    const record = readRecord(testCase.record as VectorRecord, book)
    expect(bytesToHex(encodeLeaf(record))).toBe(testCase.enc)
    expect(bytesToHex(leafHash(record))).toBe(testCase.leaf)
  })

  it('gives two distinct states distinct encodings, because every field is length-prefixed', () => {
    const [a, b] = ['length_prefixes_prevent_collision_a', 'length_prefixes_prevent_collision_b'].map(
      (id: string) => file.leaves.cases.find((c: any) => c.id === id).enc,
    )
    expect(a).not.toBe(b)
  })

  it.each(entries(file.roots.cases))('root %s', (_id, testCase: any) => {
    expect(bytesToHex(merkleRoot(stateWith(recordsFor(testCase))))).toBe(testCase.root)
    if (testCase.sameRootAs !== undefined) {
      const other = file.roots.cases.find((c: any) => c.id === testCase.sameRootAs)
      expect(testCase.root).toBe(other.root)
    }
  })

  it('roots an empty tree at 32 zero bytes and a single leaf at the leaf itself', () => {
    const empty = file.roots.cases.find((c: any) => c.id === 'empty_tree')
    expect(empty.root).toMatch(/^0{64}$/)
    const single = file.roots.cases.find((c: any) => c.id === 'one_leaf_root_is_the_leaf')
    const leaf = file.leaves.cases.find((c: any) => c.id === 'length_prefixes_prevent_collision_b')
    expect(single.root).toBe(leaf.leaf)
  })

  it.each(entries(file.sorting.cases))('sorting %s', (_id, testCase: any) => {
    expect([...testCase.input].sort(compareNames)).toEqual(testCase.sorted)
  })

  describe('checkpoints — the §8.1 commitment', () => {
    const cases = file.checkpoints.cases as any[]
    const derive = (testCase: any) =>
      checkpoint(readCheckpointState(testCase.state, book, config), hexToBytes(testCase.logHash))

    it.each(entries(cases))('%s', (_id, testCase: any) => {
      const result = derive(testCase)
      expect(bytesToHex(result.nameRoot)).toBe(testCase.nameRoot)
      expect(bytesToHex(result.pricesRoot)).toBe(testCase.pricesRoot)
      expect(bytesToHex(result.pendingRoot)).toBe(testCase.pendingRoot)
      expect(bytesToHex(result.unreservedRoot)).toBe(testCase.unreservedRoot)
      expect(bytesToHex(result.commitment)).toBe(testCase.commitment)
      expect(result.height).toBe(testCase.state.height)

      // The cross-references are the point of each pair: the same names
      // committed under different prices, a different pending set or a
      // different unreserved set must keep the name root and move the
      // checkpoint — while a set authored in a different order must not move it.
      for (const [field, other] of [
        ['sameNameRootAs', testCase.sameNameRootAs],
        ['sameCommitmentAs', testCase.sameCommitmentAs],
        ['differsFrom', testCase.differsFrom],
      ] as const) {
        if (other === undefined) continue
        const reference = cases.find((c) => c.id === other)
        if (field === 'sameNameRootAs') expect(testCase.nameRoot).toBe(reference.nameRoot)
        else if (field === 'sameCommitmentAs') expect(testCase.commitment).toBe(reference.commitment)
        else expect(testCase.commitment).not.toBe(reference.commitment)
      }
    })

    it('commits an empty pending or unreserved set as keccak256 of its tag byte alone, not as zeros', () => {
      const empty = cases.find((c) => c.id === 'empty_state_at_launch')
      expect(empty.nameRoot).toMatch(/^0{64}$/)
      expect(empty.pendingRoot).not.toMatch(/^0{64}$/)
      expect(empty.pendingRoot).toBe(bytesToHex(keccak_256(Uint8Array.of(0x04))))
      expect(empty.unreservedRoot).toBe(bytesToHex(keccak_256(Uint8Array.of(0x0a))))
    })

    it('keeps a fired U in the commitment, which is the whole of r16 (tag 0x0A)', () => {
      // Same names, same prices, same log hash, nothing pending on either side —
      // the two differ only in whether `binance` has been released. Through r15
      // they were the same 32 bytes.
      const before = cases.find((c) => c.id === 'one_name_nothing_pending')
      const after = cases.find((c) => c.id === 'one_fired_unreserve')
      expect(after.nameRoot).toBe(before.nameRoot)
      expect(after.pendingRoot).toBe(before.pendingRoot)
      expect(after.unreservedRoot).not.toBe(before.unreservedRoot)
      expect(after.commitment).not.toBe(before.commitment)
    })

    it('commits a pending U’s recipient, which is the whole of r17 (tag 0x09)', () => {
      // Same names, same unreserved set, same log hash — the two differ only
      // in who the pending `U` hands `binance` to. Through r16 the recipient
      // was not committed, and these were the same 32 bytes.
      const release = cases.find((c) => c.id === 'fired_unreserve_is_not_a_pending_one')
      const award = cases.find((c) => c.id === 'pending_award_commits_the_awardee')
      expect(award.nameRoot).toBe(release.nameRoot)
      expect(award.unreservedRoot).toBe(release.unreservedRoot)
      expect(award.pendingRoot).not.toBe(release.pendingRoot)
      expect(award.commitment).not.toBe(release.commitment)
    })
  })

  describe('proofs', () => {
    const state = stateWith(
      (file.proofs.tree as string[]).map((name) =>
        readRecord({ name, ...file.roots.defaults } as VectorRecord, book),
      ),
    )
    const root = merkleRoot(state)

    it.each(entries(file.proofs.cases))('%s', (_id, testCase: any) => {
      const proof = merkleProof(state, testCase.name)
      expect(proof).not.toBeNull()
      if (proof === null) throw new Error('unreachable')
      expect(proof.index).toBe(testCase.index)
      expect(proof.steps).toHaveLength(testCase.steps)
      expect(verifyProof(proof.leaf, proof.steps, root)).toBe(true)
    })

    it.each(entries(file.proofs.nonInclusion))('non-inclusion %s', (_id, testCase: any) => {
      const proof = merkleNonInclusion(state, testCase.name) as any
      expect(proof.kind).toBe(testCase.kind)
      if (testCase.previous !== undefined) expect(proof.previous.name).toBe(testCase.previous)
      if (testCase.next !== undefined) expect(proof.next.name).toBe(testCase.next)
      for (const side of ['previous', 'next'] as const) {
        if (proof[side] !== undefined) {
          expect(verifyProof(proof[side].leaf, proof[side].steps, proof.root)).toBe(true)
        }
      }
    })
  })
})

// ── ordering.json ───────────────────────────────────────────────────────────

describe('vectors/ordering.json', () => {
  const file = load('ordering.json')
  const book = readAddresses(file.addresses)
  const config = readConfig(file.config, book)

  const run = (testCase: any): { state: NnsState; lines: string[] } => {
    let state = initialState(config)
    const lines: string[] = []
    for (const raw of testCase.transactions) {
      const tx = readTx({ ...raw, blockNumber: testCase.block }, book, file.config.networkId)
      const result = reduce(state, tx, config)
      state = result.state
      expect(result.verdict).toMatchObject(raw.verdict)
      if (result.verdict.kind !== 'IGNORED') lines.push(canonicalLogLine(tx, result.verdict))
    }
    return { state, lines }
  }

  it.each(entries(file.cases))('%s', (_id, testCase: any) => {
    const { state, lines } = run(testCase)
    for (const [name, owner] of Object.entries(testCase.expect.owner)) {
      expect(lookup(state, name)?.owner).toBe(book[owner as string])
    }
    expect(lines).toEqual(testCase.expect.logLines)
    expect(bytesToHex(logHash(lines))).toBe(testCase.expect.logHash)
    expect(bytesToHex(merkleRoot(state))).toBe(testCase.expect.root)
  })

  it('derives a different root when the two positions swap — ordering is load-bearing', () => {
    const swapped = file.cases.find((c: any) => c.expect.differsFrom !== undefined)
    const other = file.cases.find((c: any) => c.id === swapped.expect.differsFrom)
    expect(swapped.expect.root).not.toBe(other.expect.root)
    expect(swapped.expect.logHash).not.toBe(other.expect.logHash)
  })

  it('logs no line for a transaction §7.5 discards, while it keeps its position', () => {
    const testCase = file.cases.find((c: any) => c.id === 'a_failed_transaction_still_occupies_its_position')
    expect(testCase.transactions).toHaveLength(2)
    expect(testCase.expect.logLines).toHaveLength(1)
    expect(testCase.expect.logLines[0].split(' ')[1]).toBe('1')
  })
})

// ── reduce.json ─────────────────────────────────────────────────────────────

describe('vectors/reduce.json', () => {
  const file = load('reduce.json')
  const book = readAddresses(file.addresses)

  const checkNames = (state: NnsState, expected: Record<string, any>): void => {
    for (const [name, fields] of Object.entries(expected)) {
      const record = lookup(state, name)
      expect(record, `expected ${name} to be present`).not.toBeNull()
      for (const [key, value] of Object.entries(fields)) {
        const actual = (record as unknown as Record<string, unknown>)[key]
        expect(actual, `${name}.${key}`).toEqual(
          key === 'owner' || key === 'target' || key === 'recovery'
            ? value === null
              ? null
              : book[value as string]
            : value,
        )
      }
    }
  }

  it.each(entries(file.scenarios))('%s', (_id, scenario: any) => {
    const config = readConfig({ ...file.config, ...(scenario.config ?? {}) }, book)
    let state = initialState(config)

    for (const step of scenario.steps) {
      if (step.advanceTo !== undefined) {
        state = advanceTo(state, step.advanceTo)
        continue
      }
      if (step.check !== undefined) {
        if (step.check.names !== undefined) checkNames(state, step.check.names)
        if (step.check.resolves !== undefined) {
          for (const [name, target] of Object.entries(step.check.resolves)) {
            expect(resolve(state, name)).toBe(target === null ? null : book[target as string])
          }
        }
        continue
      }

      const tx = readTx(step.tx, book, file.config.networkId)
      const result = reduce(state, tx, config)
      state = result.state
      expect(result.verdict.kind, `${scenario.id} step verdict`).toBe(step.verdict.kind)
      if (step.verdict.reason !== undefined) {
        expect((result.verdict as { reason?: string }).reason).toBe(step.verdict.reason)
      }
      if (step.verdict.obligations !== undefined) {
        const actual = (result.verdict as { obligations?: readonly any[] }).obligations ?? []
        expect(actual.map((o) => ({ kind: o.kind, owedBy: o.owedBy, owedTo: o.owedTo, amount: o.amount }))).toEqual(
          step.verdict.obligations.map((o: any) => ({
            kind: o.kind,
            owedBy: book[o.owedBy],
            owedTo: book[o.owedTo],
            amount: BigInt(o.amount),
          })),
        )
      }
    }

    if (scenario.expect.names !== undefined) {
      checkNames(state, scenario.expect.names)
      // An empty `names` expectation means the registry is empty.
      if (Object.keys(scenario.expect.names).length === 0) expect(state.names.size).toBe(0)
    }
    if (scenario.expect.resolves !== undefined) {
      for (const [name, target] of Object.entries(scenario.expect.resolves)) {
        expect(resolve(state, name)).toBe(target === null ? null : book[target as string])
      }
    }
    if (scenario.expect.prices !== undefined) {
      for (const [key, value] of Object.entries(scenario.expect.prices)) {
        expect((state.prices as unknown as Record<string, bigint>)[key]).toBe(BigInt(value as string))
      }
    }
  })

  it('includes the named conformance case from §14', () => {
    expect(file.scenarios.map((s: any) => s.id)).toContain('failed_G_does_not_register_name')
  })
})
