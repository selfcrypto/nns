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
 *   (§10.4). A referral is earned once, at the moment the link is used, on
 *   what was paid then: a lifetime `G` pays one share of a fee that is ten
 *   yearly ones, and nothing later — `N` carries no `ref`, so a referred
 *   buyer who renews or extends next month earns the referrer nothing
 *   (Kike, 2026-09-12). Never `tx.value`: an overpayment must not farm a
 *   share;
 * - the rate is the table's row for `(ref, height)`, and the row's `selfBp`
 *   when the buyer already controls the referring name — the treasury does
 *   not pay somebody for bringing themselves. Only the naive case is
 *   catchable, since a second address defeats any test of this kind, but the
 *   naive case is the one the share link makes easy: copy your own link,
 *   open it once, and the next registration is self-referred;
 * - an `M` from `TREASURY_ADDRESS` referencing the `G`, to the payee, for
 *   exactly the amount, settles it — the four-coordinate match §6 `M` uses
 *   for the reducer's own legs.
 *
 * ## Recognising a payment is not the same as pricing it
 *
 * **Who** was paid and **for what** is in the log: the `M` names a `G`, that
 * `G` is `OK` and carried a `ref`, that name was `REGISTERED` before it, and
 * the payee is its `target`. Only the **amount** needs the table. So the two
 * are separate here — `referralOf` reads the log, `shareOwed` prices what it
 * read — and an `M` is recognised as a referral payment whether or not this
 * process holds a rate for it.
 *
 * That split is what keeps three different things from being reported as one.
 * A reader without the operator's table can price nothing, and used to see
 * every share as an `M` that "discharged nothing" — the words for money that
 * left the treasury against no obligation at all. It also hid the case worth
 * shouting about: a share paid at the **wrong** amount against a rate that is
 * right here in the table. `settled`, `unpriced` and `mispaid` are those three
 * answers, and what is left unmatched is genuinely unexplained.
 */

import {
  addressEquals,
  CONSTANTS,
  effectiveSender,
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

/**
 * A referral as the log alone establishes it: an `OK` `G` that named a
 * registered `ref`, and the payee that `ref` resolved to at that position.
 * Everything but the amount.
 */
export interface Referral {
  /** The `G` that earned it. */
  readonly ref: TxRef
  /** The name the `G` registered. */
  readonly name: string
  /** The referring name. */
  readonly referrer: string
  readonly owedBy: Address
  /** The referrer's `target` at the `G`'s position. */
  readonly owedTo: Address
  /** Who bought — the `G`'s effective sender (§7.2), which is the new name's owner. */
  readonly buyer: Address
  /**
   * The buyer already controls the referring name, so a share would move
   * money from the payer back to the payer. Priced by the row's `selfBp`.
   */
  readonly selfReferred: boolean
  /** The fee owed the share is taken on — the band's, ×LIFETIME_MULTIPLIER for a lifetime `G`. */
  readonly price: bigint
}

/** A referral the table priced. */
export interface ShareLeg extends Referral {
  readonly amount: bigint
  readonly rateBp: bigint
}

export interface SettledShare {
  readonly leg: ShareLeg
  readonly settledAt: TxRef
  readonly settledBy: string
}

/**
 * A referral payment with no amount behind it: the log says who was paid and
 * for which `G`, and the table priced it at nothing. `reason` says which of
 * the two very different cases this is.
 */
export interface UnpricedShare {
  readonly referral: Referral
  readonly paidAt: TxRef
  readonly paidBy: string
  readonly paid: bigint
  /**
   * Why no amount was owed. `no-rate` is the outsider's reading — no row here
   * prices it. `self-referral` is a policy answer, not a missing one: the row
   * prices this case at nothing, and somebody paid anyway.
   */
  readonly reason: 'no-rate' | 'self-referral'
}

/**
 * A referral payment that disagrees with a rate that *is* here: the treasury
 * paid the right payee for the right `G`, and not the amount the published
 * table says. A finding.
 */
export interface MispaidShare {
  readonly leg: ShareLeg
  readonly paidAt: TxRef
  readonly paidBy: string
  readonly paid: bigint
}

export interface ShareResult {
  /** Referrals the table priced — the population `settled` and `outstanding` partition. */
  readonly created: readonly ShareLeg[]
  readonly settled: readonly SettledShare[]
  readonly outstanding: readonly ShareLeg[]
  readonly unpriced: readonly UnpricedShare[]
  readonly mispaid: readonly MispaidShare[]
}

export const shareKey = (leg: Pick<Referral, 'ref'>): string => `${refKey(leg.ref)}:${SHARE_KIND}`

/**
 * The referral one `OK` `G` earned, or `null` — read from the log, priced by
 * nobody.
 *
 * `before` is the state the `G` reduced against — after the height's effects,
 * before the line — so a referrer that expired in the same block is already
 * in `GRACE` and owes nothing, and a `G` cannot refer to the name it is
 * registering.
 */
export function referralOf(before: NnsState, tx: ChainTransaction, at: TxRef, verdict: Verdict): Referral | null {
  if (verdict.kind !== 'OK') return null
  const parsed = parse(tx.recipientData)
  if (!parsed.ok || parsed.message.type !== 'G' || parsed.message.ref === null) return null
  const referrer = before.names.get(parsed.message.ref)
  if (referrer === undefined || referrer.status !== 'REGISTERED') return null
  // Who bought is the attributed sender, never `tx.sender`: a registration
  // from Nimiq Pay arrives from a one-shot HTLC, and comparing that address
  // to anything would say no every time (§7.2).
  const buyer = effectiveSender(tx)
  return Object.freeze({
    ref: at,
    name: parsed.message.name,
    referrer: parsed.message.ref,
    owedBy: CONSTANTS.TREASURY_ADDRESS,
    owedTo: referrer.target,
    buyer,
    // The owner as well as the payee: an owner who points `target` at a
    // second address of their own would otherwise be paid for buying from
    // themselves, which is the whole of what this catches.
    selfReferred: addressEquals(buyer, referrer.target) || addressEquals(buyer, referrer.owner),
    price: feeFor(parsed.message.name, before.prices, parsed.message.lifetime),
  })
}

/**
 * What one `OK` `G` owes its referrer, or `null`.
 *
 * `null` covers both "no referral" and "no rate for it": a table with no row
 * for `(ref, height)`, or one that prices the referral at zero, is a table
 * saying it has no rate here — which is exactly how a reader without the
 * operator's rows says so, since §10.7's format has no way to express an
 * absent table. Nothing is owed on either, and the issuer pays nothing.
 */
export function shareOwed(before: NnsState, tx: ChainTransaction, at: TxRef, verdict: Verdict, table: RateTable): ShareLeg | null {
  const referral = referralOf(before, tx, at, verdict)
  if (referral === null) return null
  return priced(referral, table)
}

/** The priced form of a referral, or `null` when no row prices it. */
function priced(referral: Referral, table: RateTable): ShareLeg | null {
  const row = rateFor(table, referral.referrer, referral.ref.height)
  if (row === null) return null
  // A self-referral is priced by the row's own answer for that case, so the
  // policy is published where the rates are and carries their height.
  const bp = referral.selfReferred ? (row.selfBp ?? row.bp) : row.bp
  const amount = shareAmount(referral.price, bp)
  if (amount <= 0n) return null
  return Object.freeze({ ...referral, amount, rateBp: bp })
}

export interface ShareCollector {
  /** Feed to `replayLog` as its observer. */
  readonly observe: (event: LineEvent) => void
  result(): ShareResult
}

const legsAt = (state: NnsState, ref: TxRef): number => state.outstanding.get(refKey(ref))?.length ?? 0

export function createShareCollector(table: RateTable): ShareCollector {
  const created: ShareLeg[] = []
  const settled: SettledShare[] = []
  const unpriced: UnpricedShare[] = []
  const mispaid: MispaidShare[] = []
  /** Every referral seen and not yet paid, priced or not. */
  const open = new Map<string, { referral: Referral; leg: ShareLeg | null }>()

  return {
    observe(event) {
      const referral = referralOf(event.before, event.tx, event.at, event.verdict)
      if (referral !== null) {
        const leg = priced(referral, table)
        if (leg !== null) created.push(leg)
        open.set(shareKey(referral), { referral, leg })
        return
      }
      // A treasury `M` that names a referral, to its payee. The reducer
      // already said `OK` and matched nothing; this is the match — and the
      // amount is what tells the three answers apart.
      if (event.verdict.kind !== 'OK' || !addressEquals(event.tx.sender, CONSTANTS.TREASURY_ADDRESS)) return
      const parsed = parse(event.tx.recipientData)
      if (!parsed.ok || parsed.message.type !== 'M') return
      const named: TxRef = { height: parsed.message.height, txIndex: parsed.message.txIndex }
      const candidate = open.get(shareKey({ ref: named }))
      if (candidate === undefined) return
      // An `M` the reducer matched to one of its own legs is that leg's
      // payment, whatever else it resembles. A refund and a share can name
      // the same `G` and pay the same address — a referrer's target
      // registering through its own link and overpaying — and only the
      // reducer says which `M` was the refund. Without this the refund would
      // close the share's entry at the wrong amount and the share itself
      // would be left as money against nothing.
      if (legsAt(event.before, named) !== legsAt(event.after, named)) return
      // A treasury `M` naming a referred `G` and paying somebody else is not
      // this referral's payment. Left to the reducer's own reading.
      if (!addressEquals(candidate.referral.owedTo, event.tx.recipient)) return
      open.delete(shareKey({ ref: named }))
      const paid = { paidAt: event.at, paidBy: event.tx.hash, paid: event.tx.value }
      if (candidate.leg === null) {
        unpriced.push({ referral: candidate.referral, ...paid, reason: candidate.referral.selfReferred ? 'self-referral' : 'no-rate' })
      }
      else if (candidate.leg.amount === event.tx.value) settled.push({ leg: candidate.leg, settledAt: event.at, settledBy: event.tx.hash })
      else mispaid.push({ leg: candidate.leg, ...paid })
    },
    result() {
      // Only a priced referral can be outstanding: nobody may claim a debt
      // whose amount they cannot compute, and `watch` pays out of this list.
      const outstanding = [...open.values()]
        .map((entry) => entry.leg)
        .filter((leg): leg is ShareLeg => leg !== null)
        .sort((a, b) => a.ref.height - b.ref.height || a.ref.txIndex - b.ref.txIndex)
      return Object.freeze({
        created: Object.freeze([...created]),
        settled: Object.freeze([...settled]),
        outstanding: Object.freeze(outstanding),
        unpriced: Object.freeze([...unpriced]),
        mispaid: Object.freeze([...mispaid]),
      })
    },
  }
}

/**
 * Where every `M` this collector accounted for sits — settled, unpriced or
 * mispaid. What the reducer calls an unmatched settlement and this explains,
 * so the two readings are subtracted from each other in one place.
 */
export function explainedSettlements(shares: ShareResult): ReadonlySet<string> {
  return new Set([
    ...shares.settled.map((item) => refKey(item.settledAt)),
    ...shares.unpriced.map((item) => refKey(item.paidAt)),
    ...shares.mispaid.map((item) => refKey(item.paidAt)),
  ])
}

/** The empty result, for callers that run without a table. */
export const NO_SHARES: ShareResult = Object.freeze({
  created: Object.freeze([]),
  settled: Object.freeze([]),
  outstanding: Object.freeze([]),
  unpriced: Object.freeze([]),
  mispaid: Object.freeze([]),
})
