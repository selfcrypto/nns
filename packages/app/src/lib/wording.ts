/**
 * Every user-visible string, keyed by docs/app-states.md. Components never
 * invent wording; a sentence missing here means the states doc needs amending
 * first.
 *
 * The load-bearing rules (states doc §5):
 * - Alarm vocabulary is reserved for halting failures and a pin mismatch.
 * - Never "unverified" for a healthy quorum-1 answer.
 * - Delegate failures are attributed to the host, never to the subdomain —
 *   NNS never reports whether a subdomain exists.
 * - Depth (proof pending, anchor pending) is neutral, never a warning.
 */

import type { QuorumReport, WarningCode } from '@nns/resolver'
import type { AppAction, GateReason } from './states'
import type { QueryFault } from './search'
import { CONSTANTS, type LabelInvalidReason, type NameInvalidReason } from '@nns/core'

// ── Verification lines ──────────────────────────────────────────────────────

/**
 * "Verified by 1 resolver" · "Verified by 2 resolvers" — the count alone, with
 * the parties listed under it by `resolverIdentityLine`.
 *
 * The operator used to be appended at N = 1 and nobody was named above it,
 * which is backwards: at N = 2 the line said two parties agreed and left the
 * user unable to name either (Kike, 2026-08-28, on adding a second resolver).
 * The list answers it at every N.
 */
export function verifiedByLine(quorum: QuorumReport): string {
  return `Verified by ${quorum.agreed} ${quorum.agreed === 1 ? 'resolver' : 'resolvers'}`
}

/**
 * One agreeing resolver: the party, then the endpoint that answered. The name
 * is chosen by whoever wrote the config, so it identifies nothing on its own —
 * the URL is the half a user can go and check.
 */
export const resolverIdentityLine = (resolver: { readonly name: string; readonly url: string }): string =>
  `${resolver.name} — ${resolver.url}`

/** The "?" beside a line — what a screen reader calls it. */
export const hintLabel = (): string => 'More about this'

/**
 * Behind the "?" on the verified line: what the count rests on. The count
 * and the resolver list stay on the card (states doc §5 #1); this is the
 * mechanism, one tap away.
 */
export const verifiedHint = (): string =>
  'Each resolver answered with a Merkle proof, and this app checked it against the resolver’s published checkpoint before showing the address.'

export const proofPendingLine = (): string =>
  'Proof pending — checkpoints are cut every ~12 minutes. The name works now.'

export const delegatedLine = (parent: string): string => `Resolved by ${parent}`

export const delegatedExplainer = (parent: string): string =>
  `${parent} is verified and delegates this resolver. The address is ${parent}’s word — no proof covers it.`

export const targetChangedLine = (): string =>
  'Repointed since the last checkpoint — the current address is newer than its proof.'

// ── Warning tones (states doc §2) ───────────────────────────────────────────

export type Tone = 'depth' | 'info' | 'couldnt-check' | 'alarm'

export const WARNING_TONE: Record<WarningCode, Tone> = {
  QUORUM_BELOW_SPEC: 'info',
  PROOF_PENDING: 'depth',
  TARGET_CHANGED_SINCE_CHECKPOINT: 'depth',
  DELEGATE_HOST_UNPROVEN: 'info',
  DELEGATED_ANSWER: 'info',
  ROOT_HEIGHTS_DIFFER: 'couldnt-check',
  ANCHOR_NOT_CHECKED: 'info',
  ANCHOR_UNAVAILABLE: 'couldnt-check',
  ANCHOR_QUORUM_NOT_MET: 'depth',
  ANCHOR_STALE: 'couldnt-check',
}

/**
 * Warnings whose content the UI already renders through a dedicated element,
 * so a second line would say it twice: the quorum count is the "Verified by
 * N" line, the delegated distinction is the badge and explainer, and
 * ANCHOR_NOT_CHECKED is the standing state while no publisher list ships —
 * a quiet status, not a note.
 */
export const RENDERED_ELSEWHERE: ReadonlySet<WarningCode> = new Set([
  'QUORUM_BELOW_SPEC',
  'DELEGATED_ANSWER',
  'PROOF_PENDING',
  'TARGET_CHANGED_SINCE_CHECKPOINT',
  'ANCHOR_NOT_CHECKED',
])

export const WARNING_TEXT: Record<WarningCode, string> = {
  QUORUM_BELOW_SPEC: 'One resolver is configured to answer.',
  PROOF_PENDING: proofPendingLine(),
  TARGET_CHANGED_SINCE_CHECKPOINT: targetChangedLine(),
  DELEGATE_HOST_UNPROVEN: 'The delegate host came from the live record, not a proven one.',
  DELEGATED_ANSWER: 'This address is the delegate host’s word — no proof covers it.',
  ROOT_HEIGHTS_DIFFER: 'Couldn’t compare resolver checkpoints this time.',
  ANCHOR_NOT_CHECKED: 'Second-chain check not run.',
  ANCHOR_UNAVAILABLE: 'Couldn’t check the second-chain anchor.',
  ANCHOR_QUORUM_NOT_MET: 'Anchor pending — publishers post each checkpoint within hours.',
  ANCHOR_STALE: 'Couldn’t confirm a recent anchor.',
}

// ── Halting failures (alarm tier) and availability failures ────────────────

export const alarmHeadline = (): string => 'Stop — resolvers disagree'

export const alarmBody = (code: string): string => {
  switch (code) {
    case 'PROOF_INVALID':
      return 'A resolver served a proof that does not hold. Do not pay any address it showed. This is the failure the verification exists to catch.'
    case 'QUORUM_DISAGREEMENT':
    case 'QUORUM_ROOT_MISMATCH':
      return 'The configured resolvers gave different answers. No address is shown, because there is no basis to pick one.'
    case 'CHECKPOINT_BINDING_INVALID':
      return 'A resolver contradicted its own checkpoint. Do not pay any address it showed.'
    case 'ANCHOR_MISMATCH':
      return 'The anchored checkpoint does not match what this resolver served. Do not pay any address it showed.'
    case 'ANCHOR_DIVERGENCE':
      return 'Anchor publishers contradict each other about the registry. Resolution is stopped.'
    default:
      return 'Verification failed. No address is shown.'
  }
}

export const unreachableLine = (): string =>
  'Couldn’t reach enough resolvers. Nothing is wrong with the name — try again.'

// ── Delegates (never blame the subdomain) ───────────────────────────────────

export const delegateFailedLine = (parent: string): string =>
  `${parent}’s resolver did not answer. Whether the subdomain exists is only its owner’s to say.`

export const parentNotDelegatingLine = (parent: string): string =>
  `${parent} doesn’t delegate subdomains.`

/**
 * Why a delegated card carries no name actions. States what NNS does *not*
 * hold — never whether the subdomain exists, which is the host's word alone
 * (§5 #4). What the card does still offer is the address: pay it, or ask the
 * parent's owner.
 */
export const subdomainNotRegistrableLine = (parent: string): string =>
  `Subdomains aren’t registered on NNS — ${parent}’s owner issues them.`

/** The handoff from a resolved card to the Pay tab, seeded with the query. */
export const payThisLabel = (): string => 'Pay this address'

/**
 * Messaging a subdomain goes to the address it resolved to — the only party
 * `label.parent` designates. Not the parent's owner: that is whoever runs the
 * host, and the address they gave out may belong to anyone.
 */
export const messageSubdomainLabel = (): string => 'Message this address'

export const messageSubdomainNote = (parent: string): string =>
  `Goes to the address above — ${parent}’s resolver gave it, and it may not be ${parent}’s owner.`

// ── Name states (states doc §1) ─────────────────────────────────────────────

export const availableLine = (): string => 'Available'

export const reservedLine = (): string =>
  'Reserved — held by the registry and not open for registration.'

export const graceLine = (untilDate: string): string =>
  `Expired — in grace until ${untilDate}. Still its owner’s to renew; not available.`

/** `graceLine`'s date slot when no height is at hand to compute one. */
export const graceEndsUnknownPhrase = (): string => 'its grace period ends'

/** Detail-card expiry (states doc §1 REGISTERED: "expiry as ≈ date"). */
export const expiresLine = (whenDate: string): string => `Expires ${whenDate}.`

/** List-row form of the same fact. */
export const expiryUntilLine = (whenDate: string): string => `until ${whenDate}`

/** An availability miss that is neither reserved nor free: someone beat the lookup. */
export const justRegisteredLine = (): string =>
  'Just registered by someone — search again to see it.'

export const parentNotRegisteredLine = (parent: string): string =>
  `${parent} isn’t registered, so nothing can answer for its subdomains.`

export const pendingTransferLine = (newOwner: string, whenDate: string): string =>
  `Transferring to ${newOwner} ${whenDate}. The current owner stays in control until then.`

export const forSaleLine = (priceNim: string): string => `For sale at ${priceNim} NIM`

// ── Auctions (§6 `A`, r28) ──────────────────────────────────────────────────

export const auctionLine = (startingPriceNim: string, endDate: string): string =>
  `Up for auction — starting price ${startingPriceNim} NIM, ends ${endDate}.`

export const standingBidLine = (bidNim: string, bidder: string): string => `Highest bid ${bidNim} NIM from ${bidder}.`

export const noBidsLine = (): string => 'No bids yet.'

/** The API's `minimumBid` — `core.requiredBid`; a `B` below it refunds, it is not accepted. */
export const minimumBidLine = (nim: string): string => `Next bid: at least ${nim} NIM.`

/** Market row: what an auction is asking for while no bid stands. */
export const startingPriceLine = (nim: string): string => `Starting price ${nim} NIM`

export const auctionBadge = (): string => 'Auction'

/** List-row form of the end: "ends ≈ date" — an auction ends, it does not expire. */
export const auctionEndsLine = (whenDate: string): string => `ends ${whenDate}`

/**
 * §6 `A` has no rule against an end at or past expiry; the grace reset
 * cancels the auction and refunds the bid instead. Said before the `A` is
 * sent, because the owner's fix — renew first — is only available before.
 */
export const auctionOutlivesTermLine = (expiryDate: string): string =>
  `This auction would outlive the name’s term (${expiryDate}), and only the current term can be sold — renew first, or shorten it.`

/**
 * The bid reading of `WRONG_PRICE`, and of being outbid: neither is a
 * forfeit. Both are refunds, and both come from the operator (§8.5 #10).
 */
export const bidRefundLine = (): string =>
  'A bid below the minimum is refunded, not accepted — and so is yours the moment a higher one lands.'

/** §8.5 #10 for a bid: money is held for the whole window, not only in flight. */
export const bidCustodialWarning = (): string =>
  'Settlement is custodial: the marketplace operator holds your bid until the auction ends, and refunds it if it is outbid — auditable in the public log, but a promise, not a protocol rule.'

export const feeChangeLine = (whenDate: string): string =>
  `Fees change ${whenDate} — a scheduled governance update.`

export const renewDueLine = (whenDate: string): string => `Renew before ${whenDate}`

/** List-row form of the grace state: renewable until the grace **end** date. */
export const graceBadge = (untilDate: string): string => `In grace — renew by ${untilDate}`

// ── Gate reasons (states doc §4; shown on disabled actions) ─────────────────

export const GATE_REASON_TEXT: Record<GateReason, string> = {
  taken: 'This name is registered.',
  reserved: 'Reserved names can’t be registered.',
  'in-grace': 'In grace — only renewal works until it ends.',
  'no-record': 'This name isn’t registered.',
  'no-viewer': 'Connect a wallet to act on names.',
  'not-owner': 'Only the owner can do this.',
  'nothing-to-cancel': 'Nothing is pending on this name.',
  'offer-irrevocable': 'The offer is in its irrevocable window.',
  'offer-open': 'An offer is already open — cancel it first.',
  'no-offer': 'No open offer on this name.',
  // One short line, because it appears on up to four rows at once — the
  // auction's own facts are in the overlay above them.
  'auction-open': 'Locked while the auction runs.',
  'no-auction': 'No open auction on this name.',
  'state-unknown': 'Couldn’t read this name’s record — try again.',
}

// ── Input validation (§4.1 in plain words, field-level) ────────────────────

/**
 * **Typed, and deliberately partial.** `Partial<Record<…>>` so a key that is not
 * a real `NameInvalidReason` fails to compile — an untyped `Record<string,
 * string>` here is what let label reasons be rendered with name wording for as
 * long as they were.
 *
 * Two reasons are absent and both absences are load-bearing:
 *
 * - **`RESERVED`** — reservation is never a field-level verdict. It is chain
 *   state a released name leaves behind (§6 `U`), so it reaches the user from
 *   the server, as the availability card's `reservedLine()`.
 * - **`TOO_SHORT`** — `queryFault` resolves it to the rule that actually
 *   failed, because core returns it for any string under the floor that also
 *   fails rules 2–5. Nothing reaching here can be merely short, so a sentence
 *   about length would be wrong every time it appeared.
 */
const NAME_REASON_TEXT: Partial<Record<NameInvalidReason, string>> = {
  TOO_LONG: `Too long — ${CONSTANTS.MAX_NAME_LEN} characters at most.`,
  BAD_CHARACTER: 'Only a–z, 0–9 and hyphens.',
  NO_LETTER: 'A name needs at least one letter.',
  LEADING_HYPHEN: 'Can’t start with a hyphen.',
  TRAILING_HYPHEN: 'Can’t end with a hyphen.',
  DOUBLE_HYPHEN: 'No two hyphens in a row.',
  INTERIOR_DIGIT: 'Digits can’t sit inside letters — only lead or trail.',
  // §4.2's r6 boundary clause, which this used to describe as "digits can only
  // lead or trail, not both" — a rule that does not exist: `2nimiq2`,
  // `9nimiq9` and `23nimiq45` are all valid. What is barred is `0` and `1` at
  // either end, closing `nimiq0`/`nimiqo` and `1kike`/`lkike`.
  BOUNDARY_DIGIT: 'A name can’t start or end with 0 or 1.',
}

/**
 * Labels are **not names** and this table exists because sharing the one above
 * told a user that `.shopper`'s empty label was a reserved five-character name.
 * §4.4 labels floor at **1** character, need no letter (`1` and `123` are valid
 * labels), have no positional digit rule and are never reserved — they are not
 * protocol state at all. Complete, not partial: a new `LabelInvalidReason` must
 * not compile until it has wording.
 */
const LABEL_REASON_TEXT: Record<LabelInvalidReason, string> = {
  TOO_SHORT: 'The part before the dot can’t be empty.',
  TOO_LONG: `The part before the dot is too long — ${CONSTANTS.MAX_LABEL_LEN} characters at most.`,
  BAD_CHARACTER: 'Before the dot: only a–z, 0–9 and hyphens.',
  LEADING_HYPHEN: 'The part before the dot can’t start with a hyphen.',
  TRAILING_HYPHEN: 'The part before the dot can’t end with a hyphen.',
  DOUBLE_HYPHEN: 'Before the dot: no two hyphens in a row.',
}

/**
 * Beside the field while a short name is typed, so the rule arrives before the
 * answer does. A **note, not an error**: it explains why most short names come
 * back reserved without claiming this one is — a released short name is
 * ordinary, and the states doc §3 keeps the fired `U` out of user-facing
 * language, so "deliberately released" is as specific as this gets.
 */
export const shortNameNoteLine = (): string =>
  `Names under ${CONSTANTS.MIN_NAME_LEN} characters are reserved unless deliberately released.`

/**
 * One sentence for a resolved `QueryFault`. The generic fallback is for a reason
 * with no wording yet — vague, but never a wrong claim about which rule failed.
 */
export function queryFaultLine(fault: QueryFault): string {
  switch (fault.kind) {
    case 'many-dots':
      return 'One dot at most — name, or label.name.'
    case 'dot-shape':
      return 'Write a subdomain as label.name — for example pay.shopper.'
    case 'label':
      return LABEL_REASON_TEXT[fault.reason]
    case 'name':
      return NAME_REASON_TEXT[fault.reason] ?? 'Not a valid name.'
    case 'unspecified':
      return 'Not a valid name.'
  }
}

// ── Buy (§8.5 #10 — wording fixed now, flow blocked on the probe) ──────────

export const custodialWarning = (): string =>
  'Settlement is custodial: if this purchase loses a race or hits a cancelled offer, the refund comes from the marketplace operator — auditable in the public log, but a promise, not a protocol rule.'

/** app-ux §5: the sheet shows only the marketplace address, so the app says who is selling. */
export const soldByLine = (seller: string): string => `Sold by ${seller}.`

// ── Send flows (docs/app-ux.md §4 — one state machine, one vocabulary) ─────

/**
 * Current-state lines, shown at the top of an action sheet so the owner sees
 * what they are about to change before typing anything (Kike, 2026-08-23).
 * The expiry date is the block-clock approximation — ~1 block/s — and keeps
 * the `≈` the states doc requires.
 */
export const currentTargetLine = (target: string): string => `Currently points to ${target}.`

export const currentEvmLine = (evm: string): string => `Currently linked to ${evm}.`

export const noEvmLine = (): string => 'No address linked yet.'

export const currentHostLine = (host: string): string => `${host} currently answers for subdomains.`

export const noHostLine = (): string => 'No subdomain resolver set.'

export const currentExpiryLine = (approx: string): string => `Currently expires ${approx}.`

/** The silent pre-fill: the host wallet already exposed the address. */
export const suggestedEvmLabel = (evm: string): string => `Use this wallet’s address: ${evm}`

/**
 * The gesture-driven path: raises the wallet's own connect sheet
 * (`eth_requestAccounts`), the same flow every EVM dApp gets in Pay's
 * browser. The ellipsis is the "a dialog follows" convention.
 */
export const connectEvmLabel = (): string => 'Use my wallet’s USDC / USDT address…'

export const connectEvmFailedLine = (): string => 'The wallet offered no address — paste it instead.'

export const ACTION_LABEL: Record<AppAction, string> = {
  register: 'Register',
  setTarget: 'Change where it points',
  setEvm: 'Link USDC / USDT address',
  transfer: 'Transfer ownership',
  delegate: 'Set subdomain resolver',
  cancel: 'Cancel what’s pending',
  renew: 'Renew',
  offer: 'Put up for sale',
  buy: 'Buy',
  auction: 'Put up for auction',
  bid: 'Bid',
}

export const sendSubmittingLine = (): string => 'Waiting for the wallet…'

export const sendConfirmingLine = (): string => 'Sent — confirming…'

export const sendConfirmedLine = (): string => 'Done.'

export const sendDeclinedLine = (): string => 'Nothing was sent.'

/** Never "sent ✓": the network did not show the effect, and that is all anyone can say. */
/**
 * The strongest negative the app is entitled to, and weaker than it used to
 * be. It claimed "the network did not include this transaction" on evidence
 * that only concerned our own indexer's visibility — and said it about a
 * registration that was already registered (Kike, 2026-08-21). The send
 * machine now asks the chain before reaching this line at all, so by the time
 * it shows, the transaction was not found in a block either. Even then it is
 * "hasn't appeared", never "was refused": a transaction can still be in
 * flight, and a retry re-signs a different one and pays a second fee.
 */
export const sendUnconfirmedLine = (): string =>
  'Not confirmed — it hasn’t appeared on chain. It may still arrive; check the name before retrying.'

/**
 * On chain and executed, with the effect not yet visible at the API. The
 * common ending for a registry effect rather than an exceptional one: the
 * indexer scans by batch, so the API can be up to a full batch behind the
 * chain. Says nothing went wrong, because nothing did.
 */
export const sendSettlingLine = (): string =>
  'Confirmed on chain — the registry is catching up. It will show within a minute or two; no need to send again.'

/**
 * In a block, and it did not execute. The one case where the transaction is
 * definitely spent and definitely ineffective, so it must not read like
 * either of the "check again" outcomes.
 */
export const sendRejectedLine = (): string =>
  'Included on chain but did not execute. Nothing changed and the fee is spent — check the name before trying again.'

/**
 * The checker was down, not the send — a broken checker never reads as a
 * negative result. No failure claim, no retry prompt: a retry re-signs a
 * different transaction and can pay a second fee.
 */
export const sendUncheckedLine = (): string =>
  'Sent to the wallet, but the service didn’t answer, so it couldn’t be confirmed. It may well have gone through — check again later.'

export const sendNoRpcLine = (): string =>
  'No RPC endpoint is configured (VITE_NNS_RPC), so nothing can be broadcast.'

/**
 * Names no wallet: the app runs against Hub and Pay behind one seam, and a
 * button that names one of them is wrong in the other. Which wallet answers is
 * `detectWallet`'s business, not the label's.
 */
export const connectWalletLabel = (): string => 'Connect Wallet'

export const addAddressLabel = (): string => 'Add another address'

export const disconnectLabel = (): string => 'Disconnect'

/**
 * Pay hands its account set over with no prompt and offers no revocation, so
 * the app's disconnect is device-local. That was spelled out under the row as
 * a sentence, and it read as a warning about something that had gone wrong
 * (Kike, 2026-08-22) — a caveat nobody asked for, attached to a button whose
 * behaviour is obvious from pressing it. The label carries what it needs to.
 */
export const payConnectLabel = (): string => 'Connect Nimiq Pay'

/** The identity row while `detectWallet` is still deciding — never nothing. */
export const walletCheckingLine = (): string => 'Checking wallet…'

/** The rest of the address set, behind the one being shown. */
export const moreAddressesLabel = (count: number): string => `+${count}`

// ── Buy → My names handoff (docs/app-ux.md §2) ─────────────────────────────

export const ownNameLine = (): string => 'You own this name.'

export const manageOwnNameLabel = (): string => 'Manage it'

export const backToNamesLabel = (): string => '‹ My Names'

// ── Pay (docs/app-ux.md §4) ────────────────────────────────────────────────

export const payToLabel = (): string => 'Paying'

export const payFromLabel = (): string => 'From'

export const payAmountLabel = (): string => 'Amount in NIM'

export const payButtonLabel = (nim: string | null): string => (nim === null ? 'Pay' : `Pay ${nim} NIM`)

// ── The USDT · Polygon mode (§6 E consumes the record it wrote) ────────────

export const payModeNimLabel = (): string => 'NIM'

export const payModeUsdtLabel = (): string => 'USDT · Polygon'

export const payUsdtEmptyBody = (): string =>
  'Type a name to send USDT on Polygon to the address its owner linked.'

/** The name resolves, and its owner never sent an `E` — honest, not an error. */
export const usdtNoLinkLine = (name: string): string => `${name} hasn’t linked a USDC / USDT address.`

export const usdtAmountLabel = (): string => 'Amount in USDT'

export const usdtButtonLabel = (amount: string | null): string =>
  amount === null ? 'Send USDT' : `Send ${amount} USDT on Polygon`

export const usdtNoProviderLine = (): string =>
  'No EVM wallet answered. Open this page inside Nimiq Pay, or in a browser with an EVM wallet.'

export const usdtWrongChainLine = (): string => 'The wallet wouldn’t switch to Polygon — nothing was sent.'

/**
 * Not enough USDT for the amount typed. One line for both moments it can
 * arrive: before a send, when the displayed balance already answers, and
 * after one, when the wallet refused and the measured balance explains why —
 * so it states the shortfall and stays silent about sending.
 */
export const usdtShortBalanceLine = (held: string, asked: string): string =>
  `The wallet holds ${held} USDT — not enough to send ${asked}.`

/**
 * Only ever shown on a *measured* zero POL balance with enough USDT — never
 * inferred from the wallet's error text, which says "insufficient funds" for
 * gas and token shortfalls alike (the guess put "no POL" on a zero-USDT
 * account, tester 2026-08-25). Why POL at all: Nimiq Pay's own USDT flow is
 * gasless through its relay, but that relay lives behind Pay's native send
 * UI — a mini app's transfer goes through the injected provider as a plain
 * on-chain transaction, and that path pays Polygon's fee in POL.
 */
export const usdtNoGasLine = (): string =>
  'The wallet has no POL to pay Polygon’s network fee — nothing was sent.'

/**
 * The wallet returned a hash — which is not confirmation, and no endpoint of
 * ours watches Polygon, so the honest report names the wallet as the actor
 * and hands over the one thing that can be tracked.
 */
export const usdtAcceptedLine = (): string => 'The wallet accepted it — track it on Polygonscan:'

/** One shape for both assets: "Balance: 123.45 NIM", "Balance: 12.5 USDT". */
export const balanceLine = (amount: string, symbol: string): string => `Balance: ${amount} ${symbol}`

/**
 * A known account whose balance no endpoint would answer. Shown in the
 * balance row's place — a visible miss, because the row hiding entirely read
 * as a broken control (tester, 2026-08-27). Never worded as a zero: an
 * unreadable balance is unknown, not empty.
 */
export const usdtBalanceUnknownLine = (): string => 'Couldn’t read the USDT balance right now.'

/** The network rejects a zero value outright (§5.4) — say so before the wallet opens. */
export const payZeroLine = (): string => 'Enter an amount above zero.'

/**
 * Nimiq drops a self-transaction *silently* — the RPC accepts it and answers
 * with a hash — so this is the only place it can be reported.
 */
export const paySelfLine = (): string =>
  'This is your own address — Nimiq drops a payment to yourself, so nothing would arrive.'

export const buyAcknowledgeLabel = (): string =>
  'I understand a refund would come from the marketplace operator'

// ── Pinning (§8.5; states doc §2 — mismatch is the alarm tier) ─────────────

export const pinFirstUseLine = (): string => 'First time you’ve used this name on this device.'

export const pinMismatchTitle = (): string => 'Stop — this name changed address'

export const pinMismatchBody = (query: string, sinceDate: string): string =>
  `When you last used ${query} on this device (${sinceDate}), it pointed to a different address. The owner may have repointed it — or someone is redirecting payments. Do not pay until you know which.`

export const pinPreviousLabel = (): string => 'Address you used before'

export const pinCurrentLabel = (): string => 'Address it points to now'

export const pinOverrideLabel = (): string => 'Use the new address anyway'

export const pinOverrideConfirmLabel = (): string => 'Yes — replace what this device remembers'

// ── NC chat (docs/app-chat.md §5 — wording is part of the threat model) ────

export const messageOwnerLabel = (): string => 'Message the owner'

export const chatPublicNotice = (): string =>
  'Messages are public, permanent, and attached to your address — anyone can read them on-chain, forever.'

export const chatOwnNameLine = (): string =>
  'This name is yours — a message to yourself can’t be sent.'

export const chatBudgetLine = (used: number, budget: number): string => `${used}/${budget} bytes`

export const CHAT_ENCODE_TEXT: Record<'BAD_NAME' | 'EMPTY_MESSAGE' | 'CONTROL_CHARS' | 'OVER_BUDGET', string> = {
  BAD_NAME: 'Not a valid name.',
  EMPTY_MESSAGE: 'Write something first.',
  CONTROL_CHARS: 'Plain text only — no control characters.',
  OVER_BUDGET: 'Too long — messages travel in a 64-byte transaction.',
}

export const inboxWindowLine = (sinceDate: string): string => `Messages since ${sinceDate}.`

/**
 * Said on an **incoming** message whose subject name is not one of yours.
 * It replaced a whole collapsed “Other messages” bucket, which applied the
 * same test to conversations you started yourself — filing your own outgoing
 * messages under a spoofing warning. The doubt is per message and only ever
 * about what someone else claimed.
 */
export const notYourNameLine = (): string =>
  'Not one of your names — the name in a message is only the sender’s claim.'

export const hiddenSendersLabel = (count: number): string => `Hidden (${count})`

export const hideSenderAction = (): string => 'Hide sender'

export const unhideSenderAction = (): string => 'Unhide'

export const inboxNoWalletLine = (): string =>
  'Connect a wallet to read the messages sent to its address.'

export const inboxNotConfiguredLine = (): string =>
  'No RPC endpoint configured. Set VITE_NNS_RPC to the operator-run relay URL.'

/** Attributed to the inbox service, never to resolvers — and nothing is lost. */
export const inboxDownLine = (): string =>
  'Couldn’t load messages — the inbox service didn’t answer. They are on-chain and will appear when it returns.'

export const inboxEmptyLine = (): string =>
  'When someone messages one of your names, it lands here.'

/** The overflow when an address holds more names than a header shows. */
export const peerMoreNamesLine = (more: number): string => `+${more} more`

/**
 * Why the names above an address can be trusted, said once per thread. The
 * distinction is the whole point: the name a message is *about* is the
 * sender's claim, the names beside their address are the registry's answer.
 */
export const peerNamesHint = (): string =>
  'Names above an address come from the registry, not from the message.'

// ── Empty states (one title + body per screen; components add nothing) ──────

export const buyEmptyTitle = (): string => 'Every name is an address'

export const buyEmptyBody = (): string =>
  'Look one up to see where it pays, or find a free one to register.'

export const myNamesNoWalletTitle = (): string => 'No wallet connected'

export const myNamesNoWalletBody = (): string => 'Your names are listed by your wallet addresses.'

export const myNamesEmptyTitle = (): string => 'No names yet'

export const myNamesEmptyBody = (): string =>
  'Register a free name in Buy — it points at your address from the moment it lands.'

export const offersEmptyTitle = (): string => 'Nothing for sale'

export const offersEmptyBody = (): string => 'Names for sale and open auctions show here.'

export const inboxNoWalletTitle = (): string => 'No wallet connected'

export const inboxNotConfiguredTitle = (): string => 'Inbox not set up'

export const inboxEmptyTitle = (): string => 'No messages'

// ── The burn record (§10.2 — burned, owed, and the gap between them) ────────

export const burnTitle = (): string => 'Fee burn'

export const burnBurnedLabel = (): string => 'Burned so far'

export const burnOwedLabel = (): string => 'Owed so far'

export const burnShortfallLine = (nim: string): string => `Behind by ${nim} NIM — owed but not yet burned.`

export const burnSurplusLine = (nim: string): string => `Ahead by ${nim} NIM — more burned than owed.`

export const burnEvenLine = (): string => 'Burned exactly what is owed.'

/**
 * Both halves or nothing: burned alone says nothing about whether the
 * commitment is being kept, which is why §10.2 calls the record auditable
 * rather than promised. The share is computed, not written out — a `P`
 * cannot move it, but a spec revision can.
 */
export const burnExplainer = (): string =>
  `${Number(CONSTANTS.BURN_SHARE_BP) / 100}% of registry revenue is committed to be burned. The figures come from the public log, so anyone can check.`
