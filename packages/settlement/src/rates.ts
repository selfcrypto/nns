/**
 * The §10.7 referral rate table — policy, read from a file, never from `core`.
 *
 * A `ref` on a `G` is a registered name, and the treasury pays its `target`
 * a share of the fee in effect. *How much* is this table's answer: a default
 * row (`ref: null`) and per-name overrides, each with the height it applies
 * from. The table is committed in the package and published by the app's
 * docs, because settled-versus-owed for shares is only auditable if everyone
 * computes against the same rows — the log alone is not enough here, which is
 * exactly why the share is not a reducer rule.
 *
 * Rows are appended, never edited: a recomputation next month must reproduce
 * the shares paid last month, so a rate change is a new row with a height,
 * as a `P` is a new price with an effective height. `selfBp` is part of that
 * — the rate for a buyer who already owns the referring name is a price the
 * row states, not a rule the code hides.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { CONSTANTS, validateNameSyntax } from '@nns/core'

export class RateTableError extends Error {
  override readonly name = 'RateTableError'
}

export interface RateRow {
  /** A registered name, or `null` for the default row. */
  readonly ref: string | null
  /** Basis points of the fee in effect at the `G`'s height (§10.7). */
  readonly bp: bigint
  /**
   * Basis points when the payee would be the payer — the buyer already owns
   * the referring name. `null` means the row says nothing, and `bp` applies,
   * which is what every row written before this field existed meant.
   *
   * It is a rate rather than a flag because it is a rate: a row is the place
   * the operator states a price, and a policy that pays nothing for a
   * self-referral is that price set to zero. It also inherits the row's
   * `fromHeight` for free, so changing the policy is appending a row, and a
   * recomputation of an old log still reproduces the shares that were paid.
   */
  readonly selfBp: bigint | null
  /** First height this row applies to, inclusive. */
  readonly fromHeight: number
  /** Free text for the reader of the published table. Never computed on. */
  readonly note: string | null
}

export interface RateTable {
  readonly rows: readonly RateRow[]
}

/** The committed table, beside `package.json` — the default when `NNS_REFERRAL_RATES` is unset. */
export const DEFAULT_RATES_PATH: string = fileURLToPath(new URL('../referral-rates.json', import.meta.url))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseRow(value: unknown, index: number): RateRow {
  const where = `rates[${index}]`
  if (!isRecord(value)) throw new RateTableError(`${where} is not an object`)

  const ref = value['ref']
  if (ref !== null && typeof ref !== 'string') throw new RateTableError(`${where}.ref must be a name or null`)
  if (typeof ref === 'string' && validateNameSyntax(ref).ok !== true) {
    throw new RateTableError(`${where}.ref ${JSON.stringify(ref)} is not a valid §4.1 name — a ref is a registered name`)
  }

  const bp = value['bp']
  if (typeof bp !== 'number' || !Number.isInteger(bp) || bp < 0 || BigInt(bp) > CONSTANTS.BASIS_POINTS) {
    throw new RateTableError(`${where}.bp must be an integer between 0 and ${CONSTANTS.BASIS_POINTS} (basis points)`)
  }

  const selfBp = value['selfBp']
  if (selfBp !== undefined && selfBp !== null) {
    if (typeof selfBp !== 'number' || !Number.isInteger(selfBp) || selfBp < 0 || BigInt(selfBp) > CONSTANTS.BASIS_POINTS) {
      throw new RateTableError(`${where}.selfBp must be an integer between 0 and ${CONSTANTS.BASIS_POINTS} (basis points), or absent`)
    }
  }

  const fromHeight = value['fromHeight']
  if (typeof fromHeight !== 'number' || !Number.isInteger(fromHeight) || fromHeight < 0) {
    throw new RateTableError(`${where}.fromHeight must be a non-negative integer height`)
  }

  const note = value['note']
  if (note !== undefined && note !== null && typeof note !== 'string') {
    throw new RateTableError(`${where}.note must be a string when present`)
  }

  return Object.freeze({
    ref,
    bp: BigInt(bp),
    selfBp: typeof selfBp === 'number' ? BigInt(selfBp) : null,
    fromHeight,
    note: typeof note === 'string' ? note : null,
  })
}

/** Validates a parsed JSON document into a table. Refuses rather than guesses: a bad table pays wrong amounts into final `M`s. */
export function parseRateTable(value: unknown): RateTable {
  if (!isRecord(value) || !Array.isArray(value['rates'])) {
    throw new RateTableError('the rate table must be an object with a `rates` array')
  }
  const rows = value['rates'].map(parseRow)
  const seen = new Set<string>()
  for (const row of rows) {
    const key = `${row.ref ?? '*'}@${row.fromHeight}`
    if (seen.has(key)) {
      throw new RateTableError(`two rows for ${row.ref ?? 'the default'} from height ${row.fromHeight} — append a later height instead of a second row`)
    }
    seen.add(key)
  }
  if (!rows.some((row) => row.ref === null)) {
    throw new RateTableError('the table has no default row (`ref: null`) — nothing would decide the rate for an unlisted name')
  }
  return Object.freeze({ rows: Object.freeze(rows) })
}

export function readRateTable(path: string = DEFAULT_RATES_PATH): RateTable {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new RateTableError(`cannot read the rate table at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new RateTableError(`${path} is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  return parseRateTable(parsed)
}

/**
 * The row in effect for a referrer at a height: the most specific `ref`
 * (an exact match beats the default) among rows with `fromHeight ≤ height`,
 * latest `fromHeight` winning. `null` when no row has started yet — the
 * table's first default row at height 0 makes that unreachable in practice,
 * but a table is data and the caller owes nothing on a `null`.
 */
export function rateFor(table: RateTable, ref: string, height: number): RateRow | null {
  let best: RateRow | null = null
  for (const row of table.rows) {
    if (row.fromHeight > height) continue
    if (row.ref !== null && row.ref !== ref) continue
    if (best === null) {
      best = row
      continue
    }
    const moreSpecific = row.ref !== null && best.ref === null
    const sameSpecificityLater = (row.ref === null) === (best.ref === null) && row.fromHeight > best.fromHeight
    if (moreSpecific || sameSpecificityLater) best = row
  }
  return best
}

/** `⌊price × bp ÷ 10,000⌋` — the §10.7 amount, on the fee in effect, never the value sent. */
export const shareAmount = (price: bigint, bp: bigint): bigint => (price * bp) / CONSTANTS.BASIS_POINTS
