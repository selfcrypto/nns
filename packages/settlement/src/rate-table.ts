/**
 * The §10.7 referral rate table — policy, never a rule in `core`.
 *
 * Pure: types, the parser and the selection rule, and nothing that reads a
 * file. `rates.ts` is the file half. The split exists because the app states
 * the rates this table pays, and it must state them by running **this**
 * selection rule on the committed file rather than a restatement of it: the
 * browser cannot import `node:fs`, and a second copy of `rateFor` was one
 * more thing a test had to hold equal.
 *
 * A `ref` on a `G` is a registered name, and the treasury pays out twice on
 * it: a **share** to the referring name's `target`, and a **rebate** to the
 * buyer. *How much* is this table's answer: a default row (`ref: null`) and
 * per-name overrides, each with the height it applies from. The table is
 * committed in the package and published by the app's docs, because
 * settled-versus-owed for referrals is only auditable if everyone computes
 * against the same rows — the log alone is not enough here, which is exactly
 * why neither payout is a reducer rule.
 *
 * **The rates here are net of the §10.2 burn share, and that is deliberate.**
 * The burn base is the treasury's *inflows* — `queries.ts`'s `SUM(value)` of
 * `OK` `G`/`N`/`O`/`M` lines **to** the treasury — so an `M` the treasury
 * sends reduces nothing, and a gross 5% payout would leave the treasury
 * paying the burn on money that never stayed with it. Deducting the burn from
 * each payout instead makes the treasury's net position identical to a burn
 * computed on a net base (`f(1−b)(1−s−r) = f(1−s−r)(1−b)`, for any fee and
 * any rates) **without amending §10.2 at all**, so the burn stays something
 * any outsider computes from the log alone. Practically: a headline 5% is
 * written here as 400 bp, and the referrer and the buyer each carry the burn
 * on their own portion (Rico, 2026-09-12).
 *
 * Rows are appended, never edited: a recomputation next month must reproduce
 * the payouts made last month, so a rate change is a new row with a height,
 * as a `P` is a new price with an effective height. `selfBp` and `rebateBp`
 * are part of that — the rate for a buyer who already owns the referring
 * name, and the rate the buyer gets back, are prices the row states, not
 * rules the code hides.
 */

import { CONSTANTS, validateNameSyntax } from '@nimiqnames/core'

export class RateTableError extends Error {
  override readonly name = 'RateTableError'
}

export interface RateRow {
  /** A registered name, or `null` for the default row. */
  readonly ref: string | null
  /** The referrer's share, in basis points of the fee in effect at the `G`'s height (§10.7). */
  readonly bp: bigint
  /**
   * The buyer's rebate, in basis points of the same fee — the second §10.7
   * payout, paid to the `G`'s effective sender (§7.2).
   *
   * `null` is **no rebate**, not a fallback to `bp`: a row written before this
   * column existed made one payout, and reading its silence as "rebate at the
   * share's rate" would double what it published. `selfBp`'s `null` falls back
   * because there the row is silent about a *case* of a rate it does state;
   * here it is silent about a payout it never made.
   *
   * It is a rebate and not a discount at the price because §6 `G` checks
   * `value` against the band's fee: a referred buyer paying less would be
   * `INSUFFICIENT_VALUE` and refunded. The buyer pays the full fee and the
   * treasury sends it back a second `M`, which costs the protocol nothing.
   */
  readonly rebateBp: bigint | null
  /**
   * Basis points when the payee would be the payer — the buyer already owns
   * the referring name. It prices **both** payouts: a self-referral earns
   * neither a share nor a rebate, because a rebate to a self-referrer is not
   * a referral programme, it is a permanent discount for anyone who owns one
   * name. `null` means the row says nothing, and each payout's own rate
   * applies, which is what every row written before this field existed meant.
   *
   * It is a rate rather than a flag because it is a rate: a row is the place
   * the operator states a price, and a policy that pays nothing for a
   * self-referral is that price set to zero. It also inherits the row's
   * `fromHeight` for free, so changing the policy is appending a row, and a
   * recomputation of an old log still reproduces the payouts that were made.
   */
  readonly selfBp: bigint | null
  /** First height this row applies to, inclusive. */
  readonly fromHeight: number
  /**
   * The row's rates already have the §10.2 burn taken out, so a reader
   * states the headline they came from (400 bp reads as 5%). A label, never
   * an input to a payout: adding it to a row changes nothing anybody is paid.
   */
  readonly netOfBurn: boolean
  /** Free text for the reader of the published table. Never computed on. */
  readonly note: string | null
}

export interface RateTable {
  readonly rows: readonly RateRow[]
}

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

  const optionalBp = (field: 'rebateBp' | 'selfBp'): bigint | null => {
    const raw = value[field]
    if (raw === undefined || raw === null) return null
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || BigInt(raw) > CONSTANTS.BASIS_POINTS) {
      throw new RateTableError(`${where}.${field} must be an integer between 0 and ${CONSTANTS.BASIS_POINTS} (basis points), or absent`)
    }
    return BigInt(raw)
  }
  const rebateBp = optionalBp('rebateBp')
  const selfBp = optionalBp('selfBp')

  const fromHeight = value['fromHeight']
  if (typeof fromHeight !== 'number' || !Number.isInteger(fromHeight) || fromHeight < 0) {
    throw new RateTableError(`${where}.fromHeight must be a non-negative integer height`)
  }

  const note = value['note']
  if (note !== undefined && note !== null && typeof note !== 'string') {
    throw new RateTableError(`${where}.note must be a string when present`)
  }

  const netOfBurn = value['netOfBurn']
  if (netOfBurn !== undefined && typeof netOfBurn !== 'boolean') {
    throw new RateTableError(`${where}.netOfBurn must be a boolean when present`)
  }

  return Object.freeze({
    ref,
    bp: BigInt(bp),
    rebateBp,
    selfBp,
    netOfBurn: netOfBurn === true,
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

/**
 * The row the **buyer's** rebate comes from at a height: the referrer's own
 * where it states one, otherwise the default row in effect — `null` before
 * any row starts.
 *
 * The rebate is the buyer's, not the referrer's (Rico, 2026-09-12: "any user
 * using a referral gets a fixed 5%, always, no matter the % we set for a
 * certain referral"). A partner's row exists to raise *their* share, and
 * before this it silently dropped the buyer's rebate to nothing whenever it
 * did not restate it — so the person the programme is meant to attract got
 * less for using the better link. Falling back to the default is the rule
 * that makes a partner row about one side only.
 *
 * It moves no past payout: below the 2026-09-12 split the default row states
 * no rebate either, so the fallback is 0 exactly where 0 was paid.
 */
export function rebateRowFor(table: RateTable, ref: string, height: number): RateRow | null {
  const own = rateFor(table, ref, height)
  return own !== null && own.rebateBp !== null ? own : rateFor(table, '', height)
}

/** The buyer's rebate in basis points — `0` where the row in effect states none. */
export const rebateFor = (table: RateTable, ref: string, height: number): bigint =>
  rebateRowFor(table, ref, height)?.rebateBp ?? 0n

/** `⌊price × bp ÷ 10,000⌋` — the §10.7 amount, on the fee in effect, never the value sent. */
export const shareAmount = (price: bigint, bp: bigint): bigint => (price * bp) / CONSTANTS.BASIS_POINTS
