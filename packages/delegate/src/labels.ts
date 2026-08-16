/**
 * The labels file: parsed, validated, and turned into the map the routes read.
 *
 * This is the whole of the delegate's source of truth. There is no database,
 * no chain read and no cache tier — §8.6 makes the owner's server the
 * authority for everything below the dot, and a JSON file is what an owner
 * actually edits.
 *
 * **A bad entry rejects the whole file, and the error names the key.** Both
 * halves matter. Skipping the bad entry and serving the rest would take one
 * subdomain out of service with no error anywhere the owner looks — the exact
 * silent failure this project keeps finding. Rejecting without naming the key
 * hands an owner with a hundred labels a file and a shrug.
 *
 * Label syntax is `core`'s `validateLabel` (§4.4) and addresses are `core`'s
 * `parseAddress`, not local regexes. A delegate that accepted a label the
 * client will never send, or served an address the client rejects as
 * malformed, is a divergence bought for nothing.
 */

import { parseAddress, validateLabel, validateNameSyntax, type Address } from '@nns/core'

/** One label's answer, as §8.6 step 3 puts it on the wire. */
export interface LabelAnswer {
  readonly address: Address
  readonly ttl: number
}

export interface LabelFile {
  /**
   * The name this file answers for, and **the gate** it is checked against
   * (r23). §8.6's URL carries the parent, so a request naming a different one
   * is answered `NO_ANSWER` — never a distinguishable error, which would leak
   * which names a host serves.
   *
   * Through r22 this was documentation that could never be a gate, because the
   * request carried only the label and there was nothing to compare it to.
   * That is the defect r23 closed: a stale `name` here used to be harmless and
   * is now load-bearing.
   */
  readonly name: string
  readonly defaultTtl: number
  readonly labels: ReadonlyMap<string, LabelAnswer>
}

/**
 * A ttl the client would ignore is a ttl the owner should not be able to
 * write: §8.6 step 4 caps caching at one hour anyway. A day is the outer
 * bound here — anything larger in a hand-edited file is a typo, and this is
 * the last place to say so before it becomes a stale address.
 */
export const MAX_TTL_SEC = 86_400

export const DEFAULT_TTL_SEC = 300

/** A file that cannot be served, with the key that made it so. */
export class LabelFileError extends Error {
  override readonly name = 'LabelFileError'
  /** `labels.shop`, `defaultTtl`, … — or `null` when the fault is the file itself. */
  readonly key: string | null

  constructor(key: string | null, detail: string) {
    super(key === null ? detail : `${key}: ${detail}`)
    this.key = key
  }
}

const TOP_LEVEL = new Set(['version', 'name', 'defaultTtl', 'labels'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readTtl(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new LabelFileError(key, `ttl must be an integer number of seconds, got ${JSON.stringify(value)}`)
  }
  if (value < 1 || value > MAX_TTL_SEC) {
    throw new LabelFileError(key, `ttl must be in 1..${MAX_TTL_SEC} seconds, got ${value}`)
  }
  return value
}

function readAddress(value: unknown, key: string): Address {
  if (typeof value !== 'string') {
    throw new LabelFileError(key, `address must be a string, got ${JSON.stringify(value)}`)
  }
  try {
    return parseAddress(value)
  } catch (error) {
    throw new LabelFileError(key, `not a Nimiq address: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readAnswer(value: unknown, key: string, defaultTtl: number): LabelAnswer {
  // The shorthand is the common case — an owner with a hundred labels writes
  // `"shop": "NQ…"` — and the object form exists for the label that needs its
  // own ttl. It is the one union in this file, and deliberately so.
  if (typeof value === 'string') return { address: readAddress(value, key), ttl: defaultTtl }
  if (!isObject(value)) {
    throw new LabelFileError(key, `must be an address string or {address, ttl}, got ${JSON.stringify(value)}`)
  }
  for (const field of Object.keys(value)) {
    if (field !== 'address' && field !== 'ttl') {
      throw new LabelFileError(`${key}.${field}`, 'unknown field — expected address, ttl')
    }
  }
  const address = readAddress(value['address'], `${key}.address`)
  const ttl = value['ttl'] === undefined ? defaultTtl : readTtl(value['ttl'], `${key}.ttl`)
  return { address, ttl }
}

/**
 * Validate a parsed JSON document into a servable {@link LabelFile}.
 *
 * `fallbackTtl` is the deployment's `NNS_DELEGATE_DEFAULT_TTL`, used when the
 * file states no `defaultTtl` of its own.
 */
export function parseLabelFile(raw: unknown, fallbackTtl: number = DEFAULT_TTL_SEC): LabelFile {
  if (!isObject(raw)) throw new LabelFileError(null, 'file must contain a JSON object')

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL.has(key)) {
      throw new LabelFileError(key, 'unknown top-level key — expected version, name, defaultTtl, labels')
    }
  }

  if (raw['version'] !== 1) {
    throw new LabelFileError('version', `must be 1, got ${JSON.stringify(raw['version'])}`)
  }

  const name = raw['name']
  if (typeof name !== 'string') {
    throw new LabelFileError('name', `must be the name this file answers for, got ${JSON.stringify(name)}`)
  }
  const nameCheck = validateNameSyntax(name)
  if (!nameCheck.ok) {
    throw new LabelFileError('name', `not a valid §4.1 name: ${nameCheck.reason}`)
  }

  const defaultTtl = raw['defaultTtl'] === undefined ? fallbackTtl : readTtl(raw['defaultTtl'], 'defaultTtl')

  const labelsRaw = raw['labels']
  if (!isObject(labelsRaw)) {
    throw new LabelFileError('labels', 'must be an object of label → address')
  }

  const labels = new Map<string, LabelAnswer>()
  for (const [label, value] of Object.entries(labelsRaw)) {
    const key = `labels.${label}`
    const check = validateLabel(label)
    if (!check.ok) throw new LabelFileError(key, `not a valid §4.4 label: ${check.reason}`)
    labels.set(label, readAnswer(value, key, defaultTtl))
  }

  return Object.freeze({ name, defaultTtl, labels })
}

/** Parse the file's bytes. A JSON syntax error is a file-level fault, so it carries no key. */
export function readLabelFile(text: string, fallbackTtl: number = DEFAULT_TTL_SEC): LabelFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new LabelFileError(null, `not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseLabelFile(raw, fallbackTtl)
}
