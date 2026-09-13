/**
 * The §10.7 referral payouts — the two debts this package computes that
 * `core` does not.
 *
 * Everything else the issuer pays is a leg in `state.outstanding`: a rule the
 * reducer applied, committed in every root, and discharged by an `M` the
 * reducer matched. The share is deliberately none of that. It is policy — a
 * rate table beside a name — and a policy in the reducer would make every
 * partner's row consensus and rebuild every database when it changed. So
 * this module rides the same replay (`replayLog`'s line observer), reads the
 * same state, and keeps its own ledger of what the treasury owes on a
 * referral, matched against the `M`s the treasury sent. The reducer sees
 * those `M`s as `OK, discharging nothing` (§6 `M`), which is what keeps the
 * two ledgers from ever contradicting a root.
 *
 * ## One referral, two payouts
 *
 * A referred `G` earns a **share** for the referring name's `target` and a
 * **rebate** for the buyer (Kike, 2026-09-12: "5% share and 5% rebate — the
 * same as an initial 10% for the referrer, now split"). They are two legs and
 * not one because they pay two different addresses, and the audit is only
 * worth anything if each `M` is matched to the thing it paid.
 *
 * The rebate is a second `M` rather than a discount at the price because §6
 * `G` checks `value` against the band's fee: a referred buyer paying 95% would
 * be `INSUFFICIENT_VALUE` and refunded, so a discount is impossible without
 * making referrals consensus. Sending the money back afterwards costs the
 * protocol nothing and needs no rule.
 *
 * Both rates are published **net of the §10.2 burn share** (`rate-table.ts` has
 * the arithmetic). Nothing here knows that — a rate is a rate — but it is why the
 * committed table says 400 bp where the programme says 5%.
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
 * - the rate is the table's row for `(ref, height)` — its `bp` for the share,
 *   its `rebateBp` for the rebate — and the row's `selfBp` for **both** when
 *   the buyer already controls the referring name. The treasury does not pay
 *   somebody for bringing themselves, and it does not discount them either:
 *   a self-referred rebate is not a referral programme, it is a standing
 *   discount for anyone who owns one name. Only the naive case is catchable,
 *   since a second address defeats any test of this kind, but the naive case
 *   is the one the share link makes easy: copy your own link, open it once,
 *   and the next registration is self-referred;
 * - an `M` from `TREASURY_ADDRESS` referencing the `G`, to one of the two
 *   payees, for exactly that payout's amount, settles it — the
 *   four-coordinate match §6 `M` uses for the reducer's own legs. **The
 *   recipient is what tells the two apart**, and it always can: the share
 *   pays the referrer's `target` and the rebate pays the buyer, and those are
 *   the same address only when `selfReferred` is true, where both payouts are
 *   priced at `selfBp` and the issuer sends neither.
 *
 * ## Recognising a payment is not the same as pricing it
 *
 * **Who** was paid and **for what** is in the log: the `M` names a `G`, that
 * `G` is `OK` and carried a `ref`, that name was `REGISTERED` before it, and
 * the payee is its `target`. Only the **amount** needs the table. So the two
 * are separate here — `referralOf` reads the log, `priced` prices what it
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
} from '@nimiqnames/core'

import { rateFor, rebateFor, shareAmount, type RateRow, type RateTable } from './rate-table.js'
import type { LineEvent } from './replay.js'

/** The ledger kind the referrer's share is recorded under — beside `core`'s three, never among them. */
export const SHARE_KIND = 'REFERRAL_SHARE' as const

/** The ledger kind the buyer's rebate is recorded under. Same story as {@link SHARE_KIND}. */
export const REBATE_KIND = 'REFERRAL_REBATE' as const

/** Which of a referral's two payouts a leg is. */
export type ReferralKind = typeof SHARE_KIND | typeof REBATE_KIND

/**
 * The two payouts, in the order a referral creates and matches them.
 *
 * The order is only reachable when both payees are the same address, which is
 * exactly the self-referral case — where both are priced at `selfBp` and the
 * issuer pays neither. Fixed anyway, so two runs over one log report the same
 * thing.
 */
export const REFERRAL_KINDS: readonly ReferralKind[] = Object.freeze([SHARE_KIND, REBATE_KIND])

/** The word a report uses for a payout — the kind is the ledger's, this is the reader's. */
export const payoutWord = (kind: ReferralKind): string => (kind === REBATE_KIND ? 'rebate' : 'share')

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
  /** The referrer's `target` at the `G`'s position — the share's payee. */
  readonly referrerTarget: Address
  /** Who bought — the `G`'s effective sender (§7.2), which is the new name's owner. */
  readonly buyer: Address
  /**
   * The buyer already controls the referring name, so both payouts would move
   * money from the payer back to the payer. Priced by the row's `selfBp`.
   */
  readonly selfReferred: boolean
  /** The fee owed the share is taken on — the band's, ×LIFETIME_MULTIPLIER for a lifetime `G`. */
  readonly price: bigint
}

/** One of a referral's two payouts, priced by the table. */
export interface ShareLeg extends Referral {
  readonly kind: ReferralKind
  /** Who this payout pays: the referrer's `target` for a share, the buyer for a rebate. */
  readonly payee: Address
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
  readonly kind: ReferralKind
  /** Who was paid — which is also what said this `M` was the share rather than the rebate. */
  readonly payee: Address
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
  /** Payouts the table priced — the population `settled` and `outstanding` partition. */
  readonly created: readonly ShareLeg[]
  readonly settled: readonly SettledShare[]
  readonly outstanding: readonly ShareLeg[]
  readonly unpriced: readonly UnpricedShare[]
  readonly mispaid: readonly MispaidShare[]
}

/** A payout's stable identity, and the issuer's idempotency key: `<height>:<txIndex>:<KIND>`. */
export const shareKey = (leg: Pick<Referral, 'ref'> & { readonly kind: ReferralKind }): string =>
  `${refKey(leg.ref)}:${leg.kind}`

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
    referrerTarget: referrer.target,
    buyer,
    // The owner as well as the payee: an owner who points `target` at a
    // second address of their own would otherwise be paid for buying from
    // themselves, which is the whole of what this catches.
    selfReferred: addressEquals(buyer, referrer.target) || addressEquals(buyer, referrer.owner),
    price: feeFor(parsed.message.name, before.prices, parsed.message.lifetime),
  })
}

/** Who a payout pays. The share's payee is the referrer's target; the rebate's is the buyer. */
export const payeeFor = (referral: Referral, kind: ReferralKind): Address =>
  kind === SHARE_KIND ? referral.referrerTarget : referral.buyer

/**
 * The row's rate for one payout. The share is the referrer's row's; the
 * rebate is the **buyer's**, and a partner row that raises a share must not
 * quietly take it away (`rebateFor`). A missing `rebateBp` is **no rebate**,
 * not the share's rate: a row written before the column existed made one
 * payout, and reading its silence as "rebate at `bp`" would double every
 * published rate retroactively.
 */
const rateOf = (table: RateTable, referral: Referral, kind: ReferralKind, row: RateRow): bigint =>
  kind === SHARE_KIND ? row.bp : rebateFor(table, referral.referrer, referral.ref.height)

/** The priced form of one of a referral's payouts, or `null` when no row prices it. */
function priced(referral: Referral, kind: ReferralKind, table: RateTable): ShareLeg | null {
  const row = rateFor(table, referral.referrer, referral.ref.height)
  if (row === null) return null
  // A self-referral is priced by the row's own answer for that case — for
  // both payouts, since a rebate to a buyer who brought themselves is a
  // standing discount rather than a referral. Published where the rates are,
  // so it carries their height.
  const bp = (referral.selfReferred ? row.selfBp : null) ?? rateOf(table, referral, kind, row)
  const amount = shareAmount(referral.price, bp)
  if (amount <= 0n) return null
  return Object.freeze({ ...referral, kind, payee: payeeFor(referral, kind), amount, rateBp: bp })
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
  /** Every payout seen and not yet paid, priced or not, keyed `<ref>:<KIND>`. */
  const open = new Map<string, { referral: Referral; kind: ReferralKind; leg: ShareLeg | null }>()

  return {
    observe(event) {
      const referral = referralOf(event.before, event.tx, event.at, event.verdict)
      if (referral !== null) {
        for (const kind of REFERRAL_KINDS) {
          const leg = priced(referral, kind, table)
          if (leg !== null) created.push(leg)
          open.set(shareKey({ ref: referral.ref, kind }), { referral, kind, leg })
        }
        return
      }
      // A treasury `M` that names a referral, to its payee. The reducer
      // already said `OK` and matched nothing; this is the match — and the
      // amount is what tells the three answers apart.
      if (event.verdict.kind !== 'OK' || !addressEquals(event.tx.sender, CONSTANTS.TREASURY_ADDRESS)) return
      const parsed = parse(event.tx.recipientData)
      if (!parsed.ok || parsed.message.type !== 'M') return
      const named: TxRef = { height: parsed.message.height, txIndex: parsed.message.txIndex }
      // **The recipient decides which of the two payouts this is.** A treasury
      // `M` naming a referred `G` and paying neither payee is not a referral
      // payment at all; left to the reducer's own reading.
      for (const kind of REFERRAL_KINDS) {
        const key = shareKey({ ref: named, kind })
        const entry = open.get(key)
        if (entry === undefined || !addressEquals(payeeFor(entry.referral, kind), event.tx.recipient)) continue
        // An `M` the reducer matched to one of its own legs is that leg's
        // payment, whatever else it resembles. This is load-bearing for the
        // **rebate** rather than exotic: a surplus on a referred `G` is a
        // `REFUND` leg to the same buyer under the same ref (§10.5), so the
        // refund and the rebate differ only in amount, and only the reducer
        // says which `M` was which. (The share has the same collision when the
        // referrer's target registers through its own link and overpays.)
        // Without this the refund would close the payout's entry at the wrong
        // amount and the payout itself would be left as money against nothing.
        if (legsAt(event.before, named) !== legsAt(event.after, named)) return
        open.delete(key)
        const paid = { paidAt: event.at, paidBy: event.tx.hash, paid: event.tx.value }
        if (entry.leg === null) {
          unpriced.push({
            referral: entry.referral,
            kind,
            payee: payeeFor(entry.referral, kind),
            ...paid,
            reason: entry.referral.selfReferred ? 'self-referral' : 'no-rate',
          })
        }
        else if (entry.leg.amount === event.tx.value) settled.push({ leg: entry.leg, settledAt: event.at, settledBy: event.tx.hash })
        else mispaid.push({ leg: entry.leg, ...paid })
        return
      }
    },
    result() {
      // Only a priced referral can be outstanding: nobody may claim a debt
      // whose amount they cannot compute, and `watch` pays out of this list.
      const outstanding = [...open.values()]
        .map((entry) => entry.leg)
        .filter((leg): leg is ShareLeg => leg !== null)
        .sort(
          (a, b) =>
            a.ref.height - b.ref.height ||
            a.ref.txIndex - b.ref.txIndex ||
            REFERRAL_KINDS.indexOf(a.kind) - REFERRAL_KINDS.indexOf(b.kind),
        )
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
