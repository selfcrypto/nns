/**
 * The labels file: parsed, validated, and turned into the map the routes read.
 *
 * This is the whole of the delegate's source of truth. There is no database,
 * no chain read and no cache tier — §8.6 makes the owner's server the
 * authority for everything below the dot, and a JSON file is what an owner
 * actually edits.
 *
 * **One file serves many names.** §8.6's request carries the parent, so a
 * single process can answer for every name pointing at this host — which is
 * what r23 put the parent in the request for, and what §6 `D` means when it
 * says the short path "is **not** what separates two names sharing a host".
 * The file is therefore `name → label → address`, and the alternative — one
 * process, one port and one proxy route per name — is what that shape exists
 * to avoid.
 *
 * **A bad entry rejects the whole file, and the error names the key.** Both
 * halves matter. Skipping the bad entry and serving the rest would take one
 * subdomain out of service with no error anywhere the owner looks — the exact
 * silent failure this project keeps finding. Rejecting without naming the key
 * hands an owner with a hundred labels a file and a shrug.
 *
 * Name syntax is `core`'s `validateNameSyntax` (§4.1 rules 1–5), label syntax
 * is `validateLabel` (§4.4) and addresses are `parseAddress`, not local
 * regexes. A delegate that accepted a label the client will never send, or
 * served an address the client rejects as malformed, is a divergence bought
 * for nothing. `validateNameSyntax` rather than `validateName`: a parent may
 * be a short name a fired `U` released, which rule 6 still rejects.
 */

import { parseAddress, validateLabel, validateNameSyntax, type Address } from '@nimiqnames/core'

/** One label's answer, as §8.6 step 3 puts it on the wire. */
export interface LabelAnswer {
  readonly address: Address
  readonly ttl: number
}

/** One name's labels. */
export type NameLabels = ReadonlyMap<string, LabelAnswer>

export interface LabelFile {
  readonly defaultTtl: number
  /**
   * The names this host answers for, and **the gate** each request is checked
   * against (r23). A request naming a name absent here is answered
   * `NO_ANSWER` — never a distinguishable error, which would leak which names
   * a host serves.
   */
  readonly names: ReadonlyMap<string, NameLabels>
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
  /** `names.binance.shop`, `defaultTtl`, … — or `null` when the fault is the file itself. */
  readonly key: string | null

  constructor(key: string | null, detail: string) {
    super(key === null ? detail : `${key}: ${detail}`)
    this.key = key
  }
}

/**
 * Top-level keys are a closed set, and that is what lets `names` stay as a
 * wrapper rather than hoisting names to the top level. Hoisted, every
 * unrecognised key would silently *become a name*: a `defaulttl` typo would
 * parse as a name nobody ever queries, with no error anywhere the owner looks.
 * The one extra word buys the error.
 *
 * `defaultTtl` cannot collide with a name or a label for a reason worth
 * stating: both are `a-z`, `0-9`, `-` only (§4.1 rule 2, §4.4), so any key
 * carrying an uppercase letter is unreachable as either.
 */
const TOP_LEVEL = new Set(['defaultTtl', 'names'])

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

function readNameLabels(raw: unknown, nameKey: string, defaultTtl: number): NameLabels {
  if (!isObject(raw)) {
    throw new LabelFileError(nameKey, `must be an object of label → address, got ${JSON.stringify(raw)}`)
  }
  const labels = new Map<string, LabelAnswer>()
  for (const [label, value] of Object.entries(raw)) {
    const key = `${nameKey}.${label}`
    const check = validateLabel(label)
    if (!check.ok) throw new LabelFileError(key, `not a valid §4.4 label: ${check.reason}`)
    labels.set(label, readAnswer(value, key, defaultTtl))
  }
  return labels
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
      throw new LabelFileError(key, 'unknown top-level key — expected defaultTtl, names')
    }
  }

  const defaultTtl = raw['defaultTtl'] === undefined ? fallbackTtl : readTtl(raw['defaultTtl'], 'defaultTtl')

  const namesRaw = raw['names']
  if (!isObject(namesRaw)) {
    throw new LabelFileError('names', 'must be an object of name → labels')
  }

  const names = new Map<string, NameLabels>()
  for (const [name, labelsRaw] of Object.entries(namesRaw)) {
    const nameKey = `names.${name}`
    const check = validateNameSyntax(name)
    if (!check.ok) throw new LabelFileError(nameKey, `not a valid §4.1 name: ${check.reason}`)
    names.set(name, readNameLabels(labelsRaw, nameKey, defaultTtl))
  }

  return Object.freeze({ defaultTtl, names })
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

/**
 * Total labels across every name — the only figure `/healthz` reports about
 * the file's contents, because the names themselves are not the operator's to
 * publish (see `routes.ts`).
 */
export function countLabels(file: LabelFile): number {
  let total = 0
  for (const labels of file.names.values()) total += labels.size
  return total
}
