/**
 * The §10.7 referral share — the one debt this package computes that `core`
 * does not.
 *
 * Everything else the issuer pays is a leg in `state.outstanding`: a rule the
 * reducer applied, committed in every root, and discharged by an `M` the
 * reducer matched. The share is deliberately none of that. It is policy — a
 * rate table beside a name — and a policy in the reducer would make every
 * partner's row consensus and rebuild every database when it changed. So
 * this module rides the same replay (`replayLog`'s line observer), reads the
 * same state, and keeps its own ledger of what the treasury owes referrers,
 * matched against the `M`s the treasury sent. The reducer sees those `M`s as
 * `OK, discharging nothing` (§6 `M`), which is what keeps the two ledgers
 * from ever contradicting a root.
 *
 * The rules are §10.7's, restated in code once:
 *
 * - eligibility and payee are read from state **before the `G` reduces** —
 *   the `ref` must be a `REGISTERED` name then, and its `target` is paid;
 * - only an `OK` `G` owes anything;
 * - the amount is `⌊price × bp⌋` on the fee **owed** at the `G`'s height —
 *   the band's yearly fee, or the lifetime fee when the `G` carried `L`
 *   (2026-09-11: a lifetime is ten yearly fees and pays ten shares; the
 *   referrer drove ten times the revenue) — never the value sent;
 * - the rate is the table's row for `(ref, height)`;
 * - an `M` from `TREASURY_ADDRESS` referencing the `G`, to the payee, for
 *   exactly the amount, settles it — the four-coordinate match §6 `M` uses
 *   for the reducer's own legs.
 */

import {
  addressEquals,
  CONSTANTS,
  feeFor,
  parse,
  refKey,
  type Address,
  type ChainTransaction,
  type NnsState,
  type TxRef,
  type Verdict,
} from '@nns/core'

import { rateFor, shareAmount, type RateTable } from './rates.js'
import type { LineEvent } from './replay.js'

/** The ledger kind a share is recorded under — beside `core`'s three, never among them. */
export const SHARE_KIND = 'REFERRAL_SHARE' as const

export interface ShareLeg {
  /** The `G` that owes it. */
  readonly ref: TxRef
  /** The name the `G` registered. */
  readonly name: string
  /** The referring name. */
  readonly referrer: string
  readonly owedBy: Address
  /** The referrer's `target` at the `G`'s position. */
  readonly owedTo: Address
  readonly amount: bigint
  /** The fee owed the share was taken on — the band's, ×LIFETIME_MULTIPLIER for a lifetime `G`. */
  readonly price: bigint
  readonly rateBp: bigint
}

export interface SettledShare {
  readonly leg: ShareLeg
  readonly settledAt: TxRef
  readonly settledBy: string
}

export interface ShareResult {
  readonly created: readonly ShareLeg[]
  readonly settled: readonly SettledShare[]
  readonly outstanding: readonly ShareLeg[]
}

export const shareKey = (leg: Pick<ShareLeg, 'ref'>): string => `${refKey(leg.ref)}:${SHARE_KIND}`

/**
 * What one `OK` `G` owes its referrer, or `null`.
 *
 * `before` is the state the `G` reduced against — after the height's effects,
 * before the line — so a referrer that expired in the same block is already
 * in `GRACE` and owes nothing, and a `G` cannot refer to the name it is
 * registering.
 */
export function shareOwed(before: NnsState, tx: ChainTransaction, at: TxRef, verdict: Verdict, table: RateTable): ShareLeg | null {
  if (verdict.kind !== 'OK') return null
  const parsed = parse(tx.recipientData)
  if (!parsed.ok || parsed.message.type !== 'G' || parsed.message.ref === null) return null
  const referrer = before.names.get(parsed.message.ref)
  if (referrer === undefined || referrer.status !== 'REGISTERED') return null
  const row = rateFor(table, parsed.message.ref, at.height)
  if (row === null) return null
  const price = feeFor(parsed.message.name, before.prices, parsed.message.lifetime)
  const amount = shareAmount(price, row.bp)
  if (amount <= 0n) return null
  return Object.freeze({
    ref: at,
    name: parsed.message.name,
    referrer: parsed.message.ref,
    owedBy: CONSTANTS.TREASURY_ADDRESS,
    owedTo: referrer.target,
    amount,
    price,
    rateBp: row.bp,
  })
}

export interface ShareCollector {
  /** Feed to `replayLog` as its observer. */
  readonly observe: (event: LineEvent) => void
  result(): ShareResult
}

export function createShareCollector(table: RateTable): ShareCollector {
  const created: ShareLeg[] = []
  const settled: SettledShare[] = []
  const open = new Map<string, ShareLeg>()

  return {
    observe(event) {
      const leg = shareOwed(event.before, event.tx, event.at, event.verdict, table)
      if (leg !== null) {
        created.push(leg)
        open.set(shareKey(leg), leg)
        return
      }
      // A treasury `M` that names a share, to its payee, for its amount. The
      // reducer already said `OK` and matched nothing; this is the match.
      if (event.verdict.kind !== 'OK' || !addressEquals(event.tx.sender, CONSTANTS.TREASURY_ADDRESS)) return
      const parsed = parse(event.tx.recipientData)
      if (!parsed.ok || parsed.message.type !== 'M') return
      const key = shareKey({ ref: { height: parsed.message.height, txIndex: parsed.message.txIndex } })
      const candidate = open.get(key)
      if (candidate === undefined) return
      if (!addressEquals(candidate.owedTo, event.tx.recipient) || candidate.amount !== event.tx.value) return
      open.delete(key)
      settled.push({ leg: candidate, settledAt: event.at, settledBy: event.tx.hash })
    },
    result() {
      const outstanding = [...open.values()].sort((a, b) => a.ref.height - b.ref.height || a.ref.txIndex - b.ref.txIndex)
      return Object.freeze({ created: Object.freeze([...created]), settled: Object.freeze([...settled]), outstanding: Object.freeze(outstanding) })
    },
  }
}

/** The empty result, for callers that run without a table. */
export const NO_SHARES: ShareResult = Object.freeze({ created: Object.freeze([]), settled: Object.freeze([]), outstanding: Object.freeze([]) })
