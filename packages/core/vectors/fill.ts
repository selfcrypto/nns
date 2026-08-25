/**
 * Fill the derived fields of the conformance vectors.
 *
 * Everything a human should review — inputs, expected verdicts, expected
 * owners, expected reason codes — is hand-authored in the JSON. Only values
 * that are mechanically derived from those inputs are written here: `data`
 * (hex of `text`), Merkle `enc`/`leaf`/`root`, the §8.1 checkpoint hashes, and
 * the log lines and hashes in `ordering.json`.
 *
 *     npx tsx vectors/fill.ts
 *
 * The runner re-derives all of them independently, so a wrong value here fails
 * the suite rather than hiding in it.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { canonicalLogLine, logHash } from '../src/log.js'
import { checkpoint, encodeLeaf, leafHash, merkleRoot } from '../src/merkle.js'
import { rankMessages } from '../src/ordering.js'
import { reduce } from '../src/reduce.js'
import { type NameRecord, type NnsState, initialState } from '../src/state.js'
import {
  type VectorCheckpointState,
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
const save = (name: string, value: unknown): void =>
  writeFileSync(join(here, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')

const stateWith = (config: ReturnType<typeof readConfig>, records: NameRecord[]): NnsState =>
  Object.freeze({ ...initialState(), names: new Map(records.map((r) => [r.name, r])) })

// ── codec.json ──────────────────────────────────────────────────────────────

{
  const file = load('codec.json')
  const book = readAddresses(file.addresses)
  const config = readConfig(file.config, book)

  for (const testCase of file.roundTrip.cases) {
    testCase.data = hexOf(testCase.text)
    // Cross-check: the builder must produce the same bytes as the authored text.
    const built = build(config, testCase.build, testCase.message.name ?? '', book)
    if (built.data !== testCase.data) {
      throw new Error(`${testCase.id}: builder produced ${built.data}, text says ${testCase.data}`)
    }
  }
  for (const testCase of file.parseOnly.cases) {
    if (typeof testCase.text === 'string') testCase.data = hexOf(testCase.text)
  }
  save('codec.json', file)
  console.log(`codec.json     ${file.roundTrip.cases.length} round-trip, ${file.parseOnly.cases.length} parse-only`)
}

// ── merkle.json ─────────────────────────────────────────────────────────────

{
  const file = load('merkle.json')
  const book = readAddresses(file.addresses)
  const config = readConfig(load('reduce.json').config, readAddresses(load('reduce.json').addresses))

  for (const testCase of file.leaves.cases) {
    const record = readRecord(testCase.record as VectorRecord, book)
    testCase.enc = bytesToHex(encodeLeaf(record))
    testCase.leaf = bytesToHex(leafHash(record))
  }

  const defaults = file.roots.defaults
  for (const testCase of file.roots.cases) {
    const records = (testCase.names as string[]).map((name) =>
      readRecord({ name, ...defaults, ...(testCase.overrides?.[name] ?? {}) } as VectorRecord, book),
    )
    testCase.root = bytesToHex(merkleRoot(stateWith(config, records)))
  }

  for (const testCase of file.checkpoints.cases) {
    const state = readCheckpointState(testCase.state as VectorCheckpointState, book, config)
    const result = checkpoint(state, hexToBytes(testCase.logHash))
    testCase.nameRoot = bytesToHex(result.nameRoot)
    testCase.pricesRoot = bytesToHex(result.pricesRoot)
    testCase.pendingRoot = bytesToHex(result.pendingRoot)
    testCase.unreservedRoot = bytesToHex(result.unreservedRoot)
    testCase.commitment = bytesToHex(result.commitment)
  }
  save('merkle.json', file)
  console.log(
    `merkle.json    ${file.leaves.cases.length} leaves, ${file.roots.cases.length} roots, ` +
      `${file.checkpoints.cases.length} checkpoints`,
  )
}

// ── ordering.json ───────────────────────────────────────────────────────────

{
  const file = load('ordering.json')
  const book = readAddresses(file.addresses)
  const config = readConfig(file.config, book)

  for (const testCase of file.cases) {
    // §5.2 (r27): rank the response-order transactions before reducing. The
    // authored txIndex is the reviewable expectation — a rank that disagrees,
    // or a transaction outside the universe carrying one, is an authoring
    // error, so it throws here rather than filling wrong derived values.
    const inputs: Array<{ blockNumber: number; hash: string; recipientData: string; raw: any }> =
      testCase.transactions.map((raw: any) => ({
        blockNumber: testCase.block as number,
        hash: raw.hash as string,
        recipientData: (raw.data ?? hexOf(raw.text ?? '')) as string,
        raw,
      }))
    const ranked = rankMessages(inputs)
    const rankByRaw = new Map(ranked.map((entry) => [entry.tx.raw, entry.txIndex]))
    for (const raw of testCase.transactions) {
      if (rankByRaw.get(raw) !== raw.txIndex) {
        throw new Error(
          `${testCase.id}: transaction ${raw.hash} authored txIndex ${raw.txIndex}, ranked ${rankByRaw.get(raw)}`,
        )
      }
    }

    let state = initialState()
    const lines: string[] = []
    for (const { tx: input, txIndex } of ranked) {
      const tx = readTx({ ...input.raw, blockNumber: testCase.block, txIndex }, book, file.config.networkId)
      const result = reduce(state, tx, config)
      state = result.state
      if (result.verdict.kind !== 'IGNORED') lines.push(canonicalLogLine(tx, result.verdict))
    }
    testCase.expect.logLines = lines
    testCase.expect.logHash = bytesToHex(logHash(lines))
    testCase.expect.root = bytesToHex(merkleRoot(state))
  }
  save('ordering.json', file)
  console.log(`ordering.json  ${file.cases.length} cases`)
}

console.log('\nSanity checks:')
const merkle = load('merkle.json')
const empty = merkle.roots.cases.find((c: any) => c.id === 'empty_tree')
const single = merkle.roots.cases.find((c: any) => c.id === 'one_leaf_root_is_the_leaf')
const singleLeaf = merkle.leaves.cases.find((c: any) => c.id === 'length_prefixes_prevent_collision_b')
console.log(`  empty tree is 32 zero bytes      ${/^0{64}$/.test(empty.root)}`)
console.log(`  one-leaf root equals its leaf    ${single.root === singleLeaf.leaf}`)
const ordering = load('ordering.json')
const [first, swapped] = ordering.cases
console.log(`  swapping hashes changes root     ${first.expect.root !== swapped.expect.root}`)
