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
import { rankMessages } from '../src/ordering.js'
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
    const unreserved = new Set<string>(testCase.unreserved ?? [])
    const result = validateName(testCase.name, unreserved)
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
        ['price', 'startingPrice', 'feeBase', 'commissionBp'].includes(key) ? BigInt(value as string) : value,
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
    expect(() => build(config, testCase, testCase.name, book)).toThrow()
  })

  it('covers all fourteen §6 message types', () => {
    const covered = new Set(file.roundTrip.cases.map((c: any) => c.message.type))
    expect([...covered].sort()).toEqual(['A', 'B', 'D', 'E', 'F', 'G', 'K', 'M', 'N', 'O', 'P', 'S', 'U', 'X'])
  })
})

// ── merkle.json ─────────────────────────────────────────────────────────────

describe('vectors/merkle.json', () => {
  const file = load('merkle.json')
  const book = readAddresses(file.addresses)
  const reduceFile = load('reduce.json')
  const config = readConfig(reduceFile.config, readAddresses(reduceFile.addresses))

  const stateWith = (records: NameRecord[]): NnsState =>
    Object.freeze({ ...initialState(), names: new Map(records.map((r) => [r.name, r])) })

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

    it('has no pending U anywhere in the file — tag 0x09 is retired, not empty (r22)', () => {
      // r17's pair of cases pinned the recipient inside a pending `U`; r22
      // deleted the pending form, so both pinned a state that cannot occur and
      // both are gone. This is the guard against a later session re-authoring
      // one from the r17 note and getting a green run out of a state no
      // reducer can reach.
      expect(JSON.stringify(cases)).not.toContain('pendingUnreserve')
      expect(Object.values(file.checkpoints.tags)).not.toContain('0x09')
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
    // §5.2 (r27): the transactions are authored in response order, which
    // deliberately never matches canonical order. Rank first, then reduce.
    const inputs: Array<{ blockNumber: number; hash: string; recipientData: string; raw: any }> =
      testCase.transactions.map((raw: any) => ({
        blockNumber: testCase.block,
        hash: raw.hash,
        recipientData: raw.data ?? hexOf(raw.text ?? ''),
        raw,
      }))
    const ranked = rankMessages(inputs)

    // The authored txIndex is the reviewable expectation: ranking must
    // reproduce it, and a transaction authored without one must be excluded
    // from the universe (its rank here reads back undefined).
    const rankByRaw = new Map(ranked.map((entry) => [entry.tx.raw, entry.txIndex]))
    for (const raw of testCase.transactions) {
      expect(rankByRaw.get(raw), `rank of ${raw.hash}`).toBe(raw.txIndex)
    }

    let state = initialState()
    const lines: string[] = []
    for (const { tx: input, txIndex } of ranked) {
      const tx = readTx({ ...input.raw, blockNumber: testCase.block, txIndex }, book, file.config.networkId)
      const result = reduce(state, tx, config)
      state = result.state
      expect(result.verdict).toMatchObject(input.raw.verdict)
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

  it('derives a different root when the two hashes swap — the rank is load-bearing', () => {
    const swapped = file.cases.find((c: any) => c.expect.differsFrom !== undefined)
    const other = file.cases.find((c: any) => c.id === swapped.expect.differsFrom)
    expect(swapped.expect.root).not.toBe(other.expect.root)
    expect(swapped.expect.logHash).not.toBe(other.expect.logHash)
  })

  it('logs no line for a transaction §7.5 discards, while it keeps its rank', () => {
    const testCase = file.cases.find((c: any) => c.id === 'a_discarded_message_still_occupies_its_rank')
    expect(testCase.transactions).toHaveLength(2)
    expect(testCase.expect.logLines).toHaveLength(1)
    expect(testCase.expect.logLines[0].split(' ')[1]).toBe('1')
  })

  it('keeps unprefixed transactions out of the universe — a lone message ranks 0', () => {
    const testCase = file.cases.find((c: any) => c.id === 'a_single_message_ranks_zero_whatever_else_the_block_carries')
    expect(testCase.transactions).toHaveLength(3)
    expect(testCase.transactions.filter((raw: any) => raw.txIndex !== undefined)).toHaveLength(1)
    expect(testCase.expect.logLines).toHaveLength(1)
    expect(testCase.expect.logLines[0].split(' ')[1]).toBe('0')
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
          key === 'owner' || key === 'target'
            ? value === null
              ? null
              : book[value as string]
            : value,
        )
      }
    }
  }

  /** An address alias, `null` for none — the shape every pending entry uses. */
  const maybeAddress = (alias: string | null): unknown => (alias === null ? null : book[alias])

  /**
   * Assert one entry of a pending map, or its absence. `expected: null` means
   * the entry is gone — which is how a boundary vector states that a scheduled
   * effect has fired, since firing is exactly the entry leaving the map.
   */
  const checkPending = (
    label: string,
    map: ReadonlyMap<string, any>,
    expected: Record<string, any>,
    fields: readonly string[],
  ): void => {
    for (const [name, want] of Object.entries(expected)) {
      const entry = map.get(name)
      if (want === null) {
        expect(entry, `${label}.${name} should be gone`).toBeUndefined()
        continue
      }
      expect(entry, `${label}.${name} should be present`).toBeDefined()
      for (const key of fields) {
        if (want[key] === undefined) continue
        const value =
          key === 'newOwner' || key === 'seller' || key === 'recipient' || key === 'bidder'
            ? maybeAddress(want[key])
            : key === 'price' || key === 'startingPrice' || key === 'bid'
              ? BigInt(want[key])
              : want[key]
        expect(entry[key], `${label}.${name}.${key}`).toEqual(value)
      }
    }
  }

  /**
   * The four §8.1 component digests, with the height and the log hash left
   * out.
   *
   * Height is excluded deliberately: `commitmentFrom` binds it, so two
   * checkpoints one block apart differ whether or not any effect fired, and a
   * comparison against the full commitment would prove nothing about a
   * boundary. These four are the whole of "the registry, minus the clock", so
   * a vector that pins which of them moved across `h-1 → h` pins the effect
   * itself rather than the passage of time.
   */
  const COMPONENTS = ['nameRoot', 'pricesRoot', 'pendingRoot', 'unreservedRoot'] as const
  const componentsOf = (state: NnsState): Record<string, string> => {
    const derived = checkpoint(state, new Uint8Array(32)) as unknown as Record<string, Uint8Array>
    return Object.fromEntries(COMPONENTS.map((key) => [key, bytesToHex(derived[key] as Uint8Array)]))
  }

  it.each(entries(file.scenarios))('%s', (_id, scenario: any) => {
    const config = readConfig({ ...file.config, ...(scenario.config ?? {}) }, book)
    let state = initialState()
    /** §8.2 lines, so a vector can assert a height crossing produced none. */
    const lines: string[] = []
    /** Component snapshots taken by `check.label`, compared by `check.since`. */
    const labels = new Map<string, Record<string, string>>()

    for (const step of scenario.steps) {
      if (step.advanceTo !== undefined) {
        state = advanceTo(state, step.advanceTo)
        continue
      }
      if (step.check !== undefined) {
        if (step.check.names !== undefined) checkNames(state, step.check.names)
        if (step.check.absent !== undefined) {
          for (const name of step.check.absent as string[]) {
            expect(lookup(state, name), `${name} should have no leaf`).toBeNull()
          }
        }
        if (step.check.resolves !== undefined) {
          for (const [name, target] of Object.entries(step.check.resolves)) {
            expect(resolve(state, name)).toBe(target === null ? null : book[target as string])
          }
        }
        if (step.check.prices !== undefined) {
          for (const [key, value] of Object.entries(step.check.prices)) {
            expect((state.prices as unknown as Record<string, bigint>)[key], key).toBe(BigInt(value as string))
          }
        }
        if (step.check.height !== undefined) expect(state.height).toBe(step.check.height)
        if (step.check.transfers !== undefined) {
          checkPending('transfers', state.transfers, step.check.transfers, ['newOwner', 'effectiveHeight'])
        }
        if (step.check.offers !== undefined) {
          checkPending('offers', state.offers, step.check.offers, [
            'seller',
            'price',
            'openedHeight',
            'expiryHeight',
          ])
        }
        if (step.check.auctions !== undefined) {
          checkPending('auctions', state.auctions, step.check.auctions, ['seller', 'startingPrice', 'endHeight', 'bidder', 'bid'])
        }
        if (step.check.pendingGovernance !== undefined) {
          if (step.check.pendingGovernance === null) expect(state.pendingGovernance).toBeNull()
          else expect(state.pendingGovernance?.effectiveHeight).toBe(step.check.pendingGovernance.effectiveHeight)
        }
        if (step.check.unreserved !== undefined) {
          for (const [name, want] of Object.entries(step.check.unreserved)) {
            expect(state.unreserved.has(name), `unreserved.${name}`).toBe(want)
          }
        }
        // The §6 `M` outstanding set, keyed by `refKey` ("height:txIndex").
        // `null` asserts the key is gone; a list is exhaustive and ordered —
        // discharge is exact-match-or-nothing (§6 `M`, r23), and this is the
        // one piece of §8.1-uncommitted state a vector must reach directly:
        // every `M` earns the same `OK` line whatever it discharged, so no
        // verdict, root, or log-hash assertion can see the difference.
        if (step.check.outstanding !== undefined) {
          for (const [key, want] of Object.entries(step.check.outstanding)) {
            const legs = state.outstanding.get(key)
            if (want === null) {
              expect(legs, `outstanding.${key} should be gone`).toBeUndefined()
              continue
            }
            expect(legs, `outstanding.${key} should be present`).toBeDefined()
            expect(
              (legs ?? []).map((leg) => ({
                kind: leg.kind,
                owedBy: leg.owedBy,
                owedTo: leg.owedTo,
                amount: leg.amount,
              })),
              `outstanding.${key}`,
            ).toEqual(
              (want as any[]).map((leg: any) => ({
                kind: leg.kind,
                owedBy: book[leg.owedBy],
                owedTo: book[leg.owedTo],
                amount: BigInt(leg.amount),
              })),
            )
          }
        }
        // A height-driven effect earns no log line (§7.6 logs only what
        // survives §7.5, and nothing survives that never arrived), so a
        // boundary vector states the count on both sides of the crossing.
        if (step.check.logLines !== undefined) expect(lines).toHaveLength(step.check.logLines)
        if (step.check.since !== undefined) {
          const before = labels.get(step.check.since)
          expect(before, `unknown label ${step.check.since}`).toBeDefined()
          const now = componentsOf(state)
          const changed = new Set<string>(step.check.changed ?? [])
          // `changed` is exhaustive: every component not named must be
          // byte-identical, which is what makes "the transition has not
          // occurred at h-1" an assertion rather than an absence of one.
          for (const key of COMPONENTS) {
            if (changed.has(key)) expect(now[key], `${key} since ${step.check.since}`).not.toBe(before?.[key])
            else expect(now[key], `${key} since ${step.check.since}`).toBe(before?.[key])
          }
        }
        if (step.check.label !== undefined) labels.set(step.check.label, componentsOf(state))
        continue
      }

      const tx = readTx(step.tx, book, file.config.networkId)
      const result = reduce(state, tx, config)
      state = result.state
      if (result.verdict.kind !== 'IGNORED') lines.push(canonicalLogLine(tx, result.verdict))
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
    if (scenario.expect.logLines !== undefined) expect(lines).toHaveLength(scenario.expect.logLines)
  })

  it('includes the named conformance case from §14', () => {
    expect(file.scenarios.map((s: any) => s.id)).toContain('failed_G_does_not_register_name')
  })

  // ── checkOrder ────────────────────────────────────────────────────────────

  describe('checkOrder — which check runs first', () => {
    const section = file.checkOrder
    const config = readConfig(file.config, book)

    /** Replay a named setup and return the state every probe starts from. */
    const stateAfter = (name: string): NnsState => {
      let state = initialState()
      for (const step of section.setups[name]) {
        if (step.advanceTo !== undefined) {
          state = advanceTo(state, step.advanceTo)
          continue
        }
        const result = reduce(state, readTx(step.tx, book, file.config.networkId), config)
        expect(result.verdict.kind, `setup ${name}`).toBe('OK')
        state = result.state
      }
      return state
    }

    const verdictOf = (state: NnsState, raw: any) => {
      const verdict = reduce(state, readTx(raw, book, file.config.networkId), config).verdict
      return { kind: verdict.kind, reason: (verdict as { reason?: string }).reason }
    }

    it.each(entries(section.cases))('%s', (_id, testCase: any) => {
      const before = stateAfter(testCase.setup)

      // The token the earlier check produces.
      expect(verdictOf(before, testCase.tx)).toEqual({
        kind: testCase.verdict.kind,
        reason: testCase.verdict.reason,
      })

      // …and the same probe rebuilt to trip only the later check, from the
      // same pre-state. Without this half the case would still pass against a
      // reducer that had simply deleted the later check, which is the other
      // way a carried token stops meaning what it meant.
      if (testCase.insteadOf === undefined) {
        expect(typeof testCase.insteadOfUnreachable, `${testCase.id} must say why`).toBe('string')
        return
      }
      expect(verdictOf(before, testCase.insteadOf.tx)).toEqual({
        kind: testCase.insteadOf.verdict.kind,
        reason: testCase.insteadOf.verdict.reason,
      })
    })

    it('covers every ordered pair of checks in every case arm of the reducer', () => {
      // One entry per message type that has more than one rejection check, so
      // adding a check to an arm without pinning where it sits fails here.
      const byType: Record<string, number> = {}
      for (const testCase of section.cases as any[]) {
        const type = testCase.id.split('_')[0]
        byType[type] = (byType[type] ?? 0) + 1
      }
      expect(byType).toEqual({
        discard: 3, // §7.5, before a message is parsed
        parse: 3, // §5.2 payload, before routing
        G: 5, // §7.4's fixed five-check order, four adjacent pairs plus grace
        S: 1,
        E: 2, // r26: recipient before state (pinned), state before sender (free, like S)
        X: 3, // r28: NOT_OWNER before AUCTION_OPEN; r30: and before OFFER_OPEN (a second X replaces, so no TRANSFER_PENDING row)
        D: 3,
        K: 3,
        N: 2,
        O: 4, // r28: NOT_OWNER before AUCTION_OPEN; r30: and before TRANSFER_PENDING (a second O replaces, so no OFFER_OPEN row)
        B: 3,
        A: 8, // r28: routing, name state, sender, AUCTION_OPEN, floor, notice, term (2026-09-03) — the version forfeit is gone; r30: OFFER_OPEN and TRANSFER_PENDING beside AUCTION_OPEN
        P: 3,
        U: 4, // r22 removed the notice row and its pair; 2026-09-11 split the last row by recipient and added the award's
        F: 1,
      })
    })

    it('separates the orderings the spec fixes from the ones it does not', () => {
      // Not a behavioural assertion — a census, so that the balance cannot
      // shift without somebody noticing. It has moved three times: r21
      // ratified `U`'s six-check order and `A`'s routing exception, taking
      // five rows from `pinnedBy: null` to a clause; r22 then shortened `U`'s
      // order to four checks, so one of those five pinned rows went away with
      // the notice it ordered; and r23's §5.2 amendment moved the two parse
      // rows — through r22 §5.2 called an unknown type and an over-length
      // payload "ignored", so the dispute was over the tokens' existence, not
      // their order, and the rows could not cite a clause both halves of the
      // spec agreed with. r28 activated `A`: its two version-forfeit rows
      // went, and seven rows citing the r28 check-order table came — five for
      // `A`'s own order, one each for the `AUCTION_OPEN` row in `O` and `X`.
      // 2026-09-11 widened `U` awards past the reserved set: the award's last
      // row is `NAME_NOT_AVAILABLE`, and one pinned row orders it behind the
      // name syntax as the release's twin does. r30 made the three pending
      // states exclusive with every opener of another kind — one pending
      // thing per name, the same kind replacing it — which is seven
      // (type × standing state) rows, each pinned against `NOT_OWNER` rather
      // than against its siblings, which it can never co-occur with: three
      // were r28's, four are r30's.
      const cases = section.cases as any[]
      const pinned = cases.filter((c) => c.pinnedBy !== null)
      const free = cases.filter((c) => c.pinnedBy === null)
      expect(pinned).toHaveLength(29)
      expect(free).toHaveLength(19)
      for (const testCase of cases) {
        expect(typeof testCase.note, `${testCase.id} needs a note`).toBe('string')
        expect(testCase.note.length, `${testCase.id} needs a real note`).toBeGreaterThan(40)
      }
      // Every §7.4-fixed row must cite the clause, not merely be marked.
      for (const testCase of pinned) expect(testCase.pinnedBy).toMatch(/§/)
    })
  })

  it('pins an exact firing height for every height-driven effect in §7.3', () => {
    // The gap these close: every other observation of a height-driven effect
    // is a root taken at a CHECKPOINT_INTERVAL boundary, which cannot tell h
    // from h+1, and none of them earns a verdict token — so a replay can agree
    // with a second implementation on all 28 tokens and still fire an effect a
    // block early. One vector per §7.3 category, each asserting both sides.
    //
    // The two `boundary_unreserve_*` vectors left with r22: a `U` executes in
    // its landing block, so there is no height at which it fires and no
    // crossing to pin. Their replacements assert the negative instead — that a
    // `U` schedules nothing — and are named `unreserve_*_completes_in_its_
    // landing_block` rather than `boundary_*`, so this census keeps meaning
    // "one per height-driven category" rather than quietly counting a vector
    // that no longer pins a height.
    const boundary = file.scenarios.filter((s: any) => s.id.startsWith('boundary_'))
    expect(boundary.map((s: any) => s.id).sort()).toEqual([
      'boundary_auction_closes_at_end_height',
      'boundary_expiry_grace_and_the_fall_to_available',
      'boundary_governance_activates_at_effective_height',
      'boundary_offer_expires_at_OFFER_MAX_LIFETIME',
      'boundary_renewal_window_closes_with_the_grace_period',
      'boundary_transfer_matures_at_XFER_TIMELOCK',
    ])
    // Each one must state the crossing on both sides: a `since` comparison
    // proving nothing moved at h-1, and one proving something moved at h.
    for (const scenario of boundary) {
      const comparisons = scenario.steps.filter((s: any) => s.check?.since !== undefined)
      expect(comparisons.length, `${scenario.id} needs both sides`).toBeGreaterThanOrEqual(2)
      expect(
        comparisons.some((s: any) => (s.check.changed ?? []).length === 0),
        `${scenario.id} must pin an h-1 with nothing changed`,
      ).toBe(true)
      expect(
        comparisons.some((s: any) => (s.check.changed ?? []).length > 0),
        `${scenario.id} must pin an h where something changed`,
      ).toBe(true)
    }
  })

  it('replaces the retired unreserve boundaries with the r22 negative', () => {
    // A `U` fires on landing, so the assertion is that advancing past it moves
    // nothing at all. Without these two, removing the boundary vectors would
    // have left the r22 rule with no vector saying a `U` schedules nothing —
    // which is exactly the divergence the boundary vectors were written for,
    // in the other direction.
    const landing = file.scenarios.filter((s: any) => s.id.endsWith('_completes_in_its_landing_block'))
    expect(landing.map((s: any) => s.id).sort()).toEqual([
      'unreserve_award_completes_in_its_landing_block',
      'unreserve_release_completes_in_its_landing_block',
    ])
    for (const scenario of landing) {
      const comparisons = scenario.steps.filter((s: any) => s.check?.since !== undefined)
      expect(comparisons.length, `${scenario.id} needs an after-comparison`).toBeGreaterThanOrEqual(1)
      expect(
        comparisons.every((s: any) => (s.check.changed ?? []).length === 0),
        `${scenario.id} must show nothing fires after the landing block`,
      ).toBe(true)
    }
  })
})
