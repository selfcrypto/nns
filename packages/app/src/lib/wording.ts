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
import type { AppAction, Cancellable, GateReason } from './states'
import type { QueryFault } from './search'
import type { PayMessageFault } from './payRequest'
import { CONSTANTS, type LabelInvalidReason, type NameInvalidReason } from '@nns/core'
import { blocksApprox, lunaToNim } from './format'

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
  `${resolver.name} — ${resolverUrlShown(resolver.url)}`

/**
 * The URL as a user can go and check it: absolute. The configured value may
 * be a same-origin path (`/api`, `config.ts`), which is right for `fetch` and
 * wrong on a card — "NIMIQNAMES.COM — /api" reads as a path that is not the
 * API (Kike, 2026-09-10), when `https://nimiqnames.com/api` is exactly where
 * it answers. Resolved against `base`, the document by default; a value that
 * is not a URL at all is shown as configured.
 */
export function resolverUrlShown(url: string, base: string = globalThis.document?.baseURI ?? ''): string {
  try {
    return new URL(url, base === '' ? undefined : base).href.replace(/\/$/, '')
  } catch {
    return url
  }
}

/** The "?" beside a line — what a screen reader calls it. */
export const hintLabel = (): string => 'More about this'

/**
 * Behind the "?" on the verified line: what the count rests on. The count
 * and the resolver list stay on the card (states doc §5 #1); this is the
 * mechanism, one tap away.
 */
export const verifiedHint = (): string =>
  'Each resolver answered with a Merkle proof, and this app checked it against the resolver’s published checkpoint before showing the address.'

/** The interval is `CHECKPOINT_INTERVAL` rendered, never typed — a tempo era cuts one a minute (tasks/17). */
export const proofPendingLine = (): string =>
  `Proof pending — checkpoints are cut every ${blocksApprox(CONSTANTS.CHECKPOINT_INTERVAL)}. The name works now.`

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

// ── Propagation (states doc §2, `QUORUM_LAGGING`) ───────────────────────────

/**
 * The resolvers answered as of different heights and differ: a change from
 * the newest blocks has reached one and not yet the other. Neutral on
 * purpose — this is the expected state for the seconds after every
 * registration, and the alarm vocabulary is not spent on it (Kike,
 * 2026-09-10, on the first live registration of the demo era).
 */
export const propagatingLine = (): string =>
  'A recent change is still reaching every resolver. This takes a few seconds.'

/** Under the line above: whether the screen is asking again on its own. */
export const propagatingRetryLine = (retrying: boolean): string =>
  retrying ? 'Checking again…' : 'Still catching up — search again in a moment.'

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

/** The handoff from a resolved card to My names when the viewer owns the name. */
export const manageThisLabel = (): string => 'Manage this name'

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

/**
 * `N` on Buy, for a name the viewer does not hold (Kike, 2026-09-09: "Lets
 * allow it as gift"). Anyone may renew (§6 `N`); the label says what the
 * payer gets — nothing — so the button cannot read as a way to acquire.
 */
/** The registration review's first line; the term is `TERM_LENGTH` rendered, never typed (tasks/17). */
export const registerPaysLine = (nim: string, term: string): string =>
  `Pays ${nim} NIM to the registry for a ${term} term.`

/**
 * The lifetime registration's first line (§10.4, tasks/19 D3): the date a
 * hundred terms actually reach, never the word "lifetime" as a promise —
 * that word is the choice's label and nothing else.
 */
export const registerLifetimePaysLine = (nim: string, untilDate: string): string =>
  `Pays ${nim} NIM to the registry — yours until ${untilDate}.`

/** Where a renewal's clock lands, as ≈ date — for a lifetime the only honest rendering of a hundred terms. */
export const newExpiryLine = (approx: string): string => `New expiry ${approx}.`

/**
 * The term choice on Register and Renew. The first label is `TERM_LENGTH`
 * rendered — "1 year" on mainnet, "7 days" in a tempo era — never typed;
 * "Lifetime" is a label only, and the review under it shows the date.
 */
export function termChoiceLabel(blocks: number = CONSTANTS.TERM_LENGTH): string {
  const days = blocks / 86_400
  if (days >= 364) return '1 year'
  if (days >= 2) return `${Math.round(days)} days`
  const hours = blocks / 3_600
  if (hours >= 2) return `${Math.round(hours)} hours`
  return `${Math.max(1, Math.round(blocks / 60))} minutes`
}

export const lifetimeChoiceLabel = (): string => 'Lifetime'

export const termChoiceGroupLabel = (): string => 'Term'

/** The price under each choice. */
export const choicePriceLine = (nim: string): string => `${nim} NIM`

/**
 * §10.1's table in one sentence, behind the "?" beside the choice. The rows
 * are `/params.fees`, so a governance change reprices the hint by itself;
 * the reserved lengths below `MIN_NAME_LEN` are one clause, not rows.
 */
export function priceHint(fees: readonly { readonly upTo: number; readonly yearly: bigint }[]): string {
  const open = fees.filter((row) => row.upTo >= CONSTANTS.MIN_NAME_LEN)
  const parts = open.map((row, index) => {
    const from = index === 0 ? CONSTANTS.MIN_NAME_LEN : (open[index - 1]?.upTo ?? 0) + 1
    const span = row.upTo >= CONSTANTS.MAX_NAME_LEN ? `${from}+` : from === row.upTo ? `${from}` : `${from}–${row.upTo}`
    return `${lunaToNim(row.yearly)} NIM for ${span}`
  })
  return (
    `Price follows length — a year is ${parts.join(', ')} characters; shorter names are reserved. ` +
    `A lifetime is ${CONSTANTS.LIFETIME_TERMS} terms for the price of ${CONSTANTS.LIFETIME_MULTIPLIER}.`
  )
}

/**
 * §10.7 on the review: who benefits, and that the price is unchanged. The
 * share comes out of the treasury's fee, so "you pay the same" is the fact
 * a payer needs before the wallet opens.
 */
export const referredByLine = (ref: string, percent: string): string =>
  `Referred by ${ref}. Its owner earns ${percent} of the fee; you pay the same.`

export const giftRenewalLabel = (): string => 'Gift a renewal'

/** The review line that makes the gift explicit before the wallet opens. */
export const giftRenewalLine = (owner: string): string =>
  `You don’t own this name — it stays ${owner}’s, and the term extends for them.`

export const sendSubmittingLine = (): string => 'Waiting for the wallet…'

/**
 * What the confirm loop is actually waiting for, rather than a bare
 * "confirming…": the indexer scans by batch, so the effect becomes visible at
 * the API when the batch's macro block closes — measured in exact 60-block
 * steps (2026-08-21, `send.ts`'s `settling`).
 */
export const sendConfirmingLine = (): string => 'Sent — waiting for the macro block that confirms it (~1 min).'

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

export const backToNamesLabel = (): string => 'My Names'

// ── Pay (docs/app-ux.md §4) ────────────────────────────────────────────────

export const payToLabel = (): string => 'Paying'

export const payFromLabel = (): string => 'From'

export const payAmountLabel = (): string => 'Amount in NIM'

export const payButtonLabel = (nim: string | null): string => (nim === null ? 'Pay' : `Pay ${nim} NIM`)

/**
 * The reference a payment carries (`lib/payRequest.ts`). Nimiq's own wallets
 * call this field the message, so this does too — it is the word the payer
 * will see again in the wallet that receives it.
 */
export const payMessageLabel = (): string => 'Message'

export const payMessagePlaceholder = (): string => 'What it’s for'

export const payMessageHint = (): string =>
  `A note for whoever receives this — an invoice or an order number, so they can tell which payment is which. It travels with the payment and is written on the chain: public, permanent, and readable by anyone, against both addresses. There is room for ${CONSTANTS.MAX_DATA_BYTES} bytes, which is ${CONSTANTS.MAX_DATA_BYTES} ordinary letters and fewer when it carries accents or emoji.`

export const payMessageBudgetLine = (used: number, budget: number): string => `${used}/${budget} bytes`

/** The message came with the link, so it is the payee's wording until the payer takes it over. */
export const payMessageFromLinkLine = (): string => 'Came with the payment link.'

export const payMessageEditLabel = (): string => 'Edit'

export const PAY_MESSAGE_FAULT_TEXT: Record<PayMessageFault, string> = {
  OVER_BUDGET: `Too long — a message travels in ${CONSTANTS.MAX_DATA_BYTES} bytes.`,
  RESERVED_PREFIX: 'A message can’t start with NNS1 — that is how a name message is written.',
}

/** An ERC-20 transfer has two arguments and nowhere to put a note (`lib/evm.ts`). */
export const payUsdtNoMessageLine = (): string => 'A USDT payment carries no message. Pay in NIM to send one.'

// ── The USDT · Polygon mode (§6 E consumes the record it wrote) ────────────

export const payModeNimLabel = (): string => 'NIM'

export const payModeUsdtLabel = (): string => 'USDT'
/** The accessible name of the USDT tab: the chain matters to a screen reader that cannot see the Polygon mark. */
export const payModeUsdtAria = (): string => 'USDT on Polygon'

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

// ── The era notice (a compressed-tempo era, docs/runbooks/testing.md §1) ────

/**
 * Whether the constants this bundle was built with are a tempo era's. The
 * one fact that separates an era from mainnet in what a person can see is
 * the term: §3 says ~1 y, and every era cuts it to days or hours so a whole
 * lifecycle fits a session. Derived, not configured — a deploy flag that
 * someone has to remember to set is exactly the notice that goes missing
 * on the day it matters (Kike, 2026-09-11: testers must not think they
 * are buying final names at a test price).
 */
export const isCompressedEra = (blocks: number = CONSTANTS.TERM_LENGTH): boolean => blocks / 86_400 < 364

/** A span of blocks as the rough period a person plans in: years, days, hours or minutes. */
function periodApprox(blocks: number): string {
  const days = blocks / 86_400
  if (days >= 364) {
    const years = Math.round(days / 365)
    return `${years} ${years === 1 ? 'year' : 'years'}`
  }
  if (days >= 2) return `${Math.round(days)} days`
  const hours = blocks / 3_600
  if (hours >= 2) return `${Math.round(hours)} hours`
  const minutes = Math.max(1, Math.round(blocks / 60))
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

export const eraTag = (): string => 'Beta'

/** The strip's one line: the two clocks a tester will be quoted, and what the names are for. */
export const eraNoticeLine = (blocks: number = CONSTANTS.TERM_LENGTH): string =>
  `Terms are ${periodApprox(blocks)}, a lifetime about ${periodApprox(blocks * CONSTANTS.LIFETIME_TERMS)}. Names and prices here are for testing.`

/** Behind the strip's "?": why the clocks are short and what happens to a name at launch. */
export const eraNoticeHint = (blocks: number = CONSTANTS.TERM_LENGTH): string =>
  `This is a test era. Every clock runs short so a name's whole life fits a few days: a term is ${periodApprox(blocks)} instead of a year, ` +
  `a lifetime about ${periodApprox(blocks * CONSTANTS.LIFETIME_TERMS)} instead of ${CONSTANTS.LIFETIME_TERMS} years, and prices are set for testing. ` +
  `Nothing registered here carries over — the registry starts again at launch.`

// ── The landing page (a browser's front door; Pay opens on Buy) ─────────────

/**
 * The landing's first perk. `TERM_LENGTH` rendered as a period, never typed:
 * mainnet's 31,536,000 blocks is "One-year terms", a tempo era's 604,800 is
 * "7-day terms" (tasks/17). Blocks ≈ seconds.
 */
export function termPerk(blocks: number = CONSTANTS.TERM_LENGTH): string {
  const days = blocks / 86_400
  if (days >= 364) return 'One-year terms'
  if (days >= 2) return `${Math.round(days)}-day terms`
  const hours = blocks / 3_600
  if (hours >= 2) return `${Math.round(hours)}-hour terms`
  return `${Math.max(1, Math.round(blocks / 60))}-minute terms`
}

/**
 * Marketing copy, kept here for the same reason as the rest: a component
 * that invents a sentence is a component that drifts from the states doc.
 * Short on purpose — the app's own screens explain, behind a "?", what a
 * word means; the landing page only has to say which job each tab does.
 */
export const LANDING = {
  hero: {
    title: 'Your name on',
    titleAccent: 'Nimiq',
    sub: 'One name instead of an address.',
    placeholder: 'Search for a name',
    go: 'Search',
    trust: ['On-chain', 'Self-custody', 'No smart contracts'],
  },
  marquee: { linked: 'Linked addresses' },
  features: {
    title: 'One name.',
    titleAccent: 'Everything',
    titleTail: 'you need.',
    cards: [
      { title: 'Search & register', body: 'Find a free name and register it.' },
      { title: 'Manage records', body: 'Point it at your address, link an EVM address, delegate subdomains.' },
      { title: 'Market', body: 'Buy and sell names, or bid in an auction.' },
      { title: 'Pay by name', body: 'Send NIM to a name.' },
      { title: 'Messages', body: 'Write to a name’s owner, on-chain.' },
    ],
  },
  steps: {
    title: 'How it works',
    items: [
      { title: 'Search & register', body: 'Pick a free name and register it on-chain.' },
      { title: 'Link addresses', body: 'Set your Nimiq address; add an EVM address for USDC and USDT.' },
      { title: 'Get paid', body: 'People send to the name. It resolves to you.' },
    ],
  },
  chains: {
    badge: 'One name, every chain',
    title: 'One name.',
    titleAccent: 'Every chain',
    titleTail: '.',
    items: [
      { title: 'You own it', body: 'Held by your key on the Nimiq chain. No contract, no custodian.' },
      { title: 'EVM payments', body: 'One linked 0x address works on every EVM chain. USDT over Polygon in Nimiq Pay today.' },
      { title: 'Subdomains', body: 'Delegate pay.yourname and the rest to a host you run.' },
    ],
  },
  burn: {
    badge: 'Fee burn',
    title: 'Fees burn',
    titleAccent: 'NIM',
    sub: `${Number(CONSTANTS.BURN_SHARE_BP) / 100}% of every fee is burned. The figures come from the public log.`,
    revenue: { label: 'Fees collected', sub: 'Paid to the treasury' },
    burned: { label: burnBurnedLabel(), sub: 'Removed from supply' },
    owed: { label: burnOwedLabel(), sub: 'Committed, not yet burned' },
  },
  cta: {
    badge: 'Names on Nimiq',
    title: 'Claim your',
    titleAccent: 'name',
    go: 'Find your name',
    perks: [termPerk(), 'Every EVM chain', 'Self-custody'],
  },
  footer: {
    tagline: 'Names on Nimiq.',
    columns: [
      { title: 'Ecosystem', links: [['Nimiq Wallet', 'https://wallet.nimiq.com'], ['Cryptocity', 'https://cryptocity.com'], ['Oasis', 'https://oasis.nimiq.com']] },
      // The first two are this app's own documentation (`#/docs/<slug>`,
      // screens/Docs.tsx). A hash link stays inside the app; Home.tsx opens
      // only the absolute ones in a new tab.
      { title: 'Resources', links: [['Documentation', '#/docs/intro'], ['Developer docs', '#/docs/developers'], ['GitHub', 'https://github.com/selfcrypto/nns'], ['Nimiq', 'https://nimiq.com']] },
      { title: 'Community', links: [['X', 'https://x.com/nimiq'], ['Discord', 'https://discord.gg/nimiq'], ['Telegram', 'https://t.me/Nimiq']] },
    ],
    copyright: (year: number): string => `© ${year} nns · MIT`,
  },
} as const

// ── The redesign's chrome (2026-09-09, Bakar's PR #2) ───────────────────────
//
// Headlines, pills, tiles and the trust bars the redesign put on every
// screen, moved here from the components. The copy is Bakar's, edited by
// Kike. The claims are true as design — where a name points is read from
// chain data and the client verifies the proof, so "decentralized" and
// "100% on-chain" are facts, not marketing — and a claim is reworded only
// where it names a mechanism the code does not have: Market's "escrow" sat
// under the note saying the operator holds the money.

export type AppScreen = 'buy' | 'names' | 'pay' | 'inbox' | 'market'

export const SCREEN_TITLE: Record<AppScreen, string> = {
  buy: 'Find your name',
  names: 'My Names',
  pay: 'Pay a Name',
  inbox: 'Inbox',
  market: 'Marketplace',
}

export const SCREEN_SUB: Record<Exclude<AppScreen, 'buy'>, string> = {
  names: 'Manage your on-chain identities, records, and marketplace listings',
  pay: 'Send NIM or Polygon USDT directly to any verified NNS address.',
  inbox: 'On-chain, wallet-to-wallet decentralized messaging on Nimiq.',
  market: 'Acquire registered NNS names or place bids on live auctions.',
}

/** The claims a trust bar can carry. Every one is what the code does. */
export const TRUST_CLAIM = {
  onChain: '100% On-Chain',
  selfCustody: 'Self-Custody',
  zeroContracts: 'Zero Contracts',
  zeroIntermediaries: 'Zero Intermediaries',
  merkleVerified: 'Merkle Verified',
  walletSigned: 'Wallet-Signed',
  decentralizedChat: 'Decentralized Chat',
  onChainSettlement: 'On-Chain Settlement',
  publicAuditLog: 'Public Audit Log',
  antiSniping: 'Anti-Sniping Extension',
} as const
export type TrustClaim = keyof typeof TRUST_CLAIM

/** Three claims per screen, under the panel. */
export const TRUST_CLAIMS: Record<AppScreen, readonly [TrustClaim, TrustClaim, TrustClaim]> = {
  buy: ['onChain', 'selfCustody', 'zeroContracts'],
  names: ['onChain', 'selfCustody', 'zeroIntermediaries'],
  pay: ['onChain', 'merkleVerified', 'selfCustody'],
  inbox: ['onChain', 'walletSigned', 'decentralizedChat'],
  market: ['onChainSettlement', 'publicAuditLog', 'antiSniping'],
}

/** Buy's idle chips: names to try. */
export const BUY_SUGGESTIONS: readonly string[] = ['alice', 'david', 'sarah', 'james']
export const tryLabel = (): string => 'Try:'

/**
 * The pill beside a card's title. An available name's pill is
 * `availableLine()`. A delegated answer is a `subdomain`, never `registered`:
 * NNS holds no record of a label, only of the parent that hosts it.
 */
export const STATUS_TAG = {
  owned: 'You own this',
  registered: 'Registered',
  subdomain: 'Subdomain',
  reserved: 'Reserved',
  taken: 'Taken',
  grace: 'In Grace',
  notRegistered: 'Not Registered',
  subdomainError: 'Subdomain Error',
  parent: 'Parent Name',
  alarm: 'Security Alarm',
  unreachable: 'Unreachable',
  propagating: 'Propagating',
} as const

/** The title of the card that stands in for a registry that did not answer. */
export const registryHeading = (): string => 'Registry'

// The owner's eight as tiles, in three groups (My names).
export const OWNER_GROUP_TITLE = {
  records: 'Routing & Records',
  ownership: 'Ownership & Renewal',
  market: 'Marketplace',
  payments: 'Payment Links',
  referrals: 'Referrals',
} as const

/** The owner's share tile (§10.7): copies `?ref=<name>`; not a transaction. */
export const SHARE_TILE = { title: 'Share Link', hint: 'Earn on registrations you refer' } as const
export const shareCopiedLine = (): string => 'Link copied'
export const shareCopyFailedLine = (link: string): string => `Copy this link: ${link}`
/** A name in grace cannot refer: §10.7 reads the referrer's status at the registration. */
export const shareInGraceLine = (): string => 'Renew first — a name in grace can’t refer.'
export const referralsCountLine = (count: number, nim: string): string =>
  count === 0 ? 'No registrations referred yet' : `${count} referred · ≈${nim} NIM at today’s prices`
/** The owner's payment link (`lib/payRequest.ts`): builds `#/pay/<name>`; not a transaction. */
export const REQUEST_TILE = { title: 'Request Payment', hint: 'A link that opens Pay, filled in' } as const
export const requestSheetTitle = (): string => 'Request a payment'
/** The sheet's subtitle sits on one line (`.modal-subtitle`), so it says the one thing. */
export const requestSheetIntro = (name: string): string => `A link to ${name}’s Pay screen`
export const requestAmountLabel = (asset: 'nim' | 'usdt'): string =>
  asset === 'usdt' ? 'Amount in USDT' : 'Amount in NIM'
export const requestAssetLabel = (): string => 'Paid in'
export const requestLinkLabel = (): string => 'Your link'
/**
 * Why the USDT tab is greyed. Shown rather than hiding the option: a hidden
 * choice says nothing, and the thing it needs is one owner action away —
 * `OWNER_ACTION_TILE.setEvm`, named here so the line points somewhere.
 */
export const requestNoEvmLine = (): string =>
  'USDT needs an address linked to this name — the EVM Resolution action.'
export const copyLinkLabel = (): string => 'Copy link'
/** A name in grace does not resolve (§7.3), so a link to it has nothing to pay. */
export const requestInGraceLine = (): string => 'Renew first — a name in grace can’t be paid.'

export const shareHint = (percent: string): string =>
  `Anyone who registers through your link pays the same price, and this name’s address receives ${percent} of the fee, paid by the registry after each registration.`


/** A tile's title, and the line under it while the record has nothing to show. */
/** Seven of the eight; the cancel tile's pair is `cancelTitle`/`cancelHint`,
 *  which are the cancellable set's, not a constant. */
export const OWNER_TILE: Record<
  'setTarget' | 'setEvm' | 'delegate' | 'renew' | 'transfer' | 'offer' | 'auction',
  { readonly title: string; readonly hint: string }
> = {
  setTarget: { title: 'Target Address', hint: 'Point to a Nimiq address' },
  setEvm: { title: 'EVM Resolution', hint: 'Link a USDC / USDT address' },
  delegate: { title: 'Subdomain Host', hint: 'Configure a custom host' },
  renew: { title: 'Renew Registration', hint: 'Extend the registration' },
  transfer: { title: 'Transfer Ownership', hint: 'Send to a new Nimiq owner' },
  offer: { title: 'Sell (Fixed Price)', hint: 'List for direct buy-now' },
  auction: { title: 'Start Auction', hint: 'Timed public bidding' },
}
export const offerActiveLine = (nim: string): string => `Active: ${nim} NIM`
export const auctionStandingLine = (nim: string): string => `Standing bid: ${nim} NIM`
export const auctionStartingLine = (nim: string): string => `Starting price: ${nim} NIM`
export const connectWalletHint = (): string => 'Connect wallet'

/**
 * A `K` is named by what it will actually clear (`states.cancellableNow`) —
 * the tile, the sheet's header and its submit button all use this one title.
 *
 * It read **"Cancel Listing / Cancel active auction"** for a pending transfer,
 * which is two false statements: there is no listing, and an auction is the one
 * thing a `K` can never touch (§6 `A` — bids are commitments). The empty set is
 * a real case, not a fallback — an open auction voided the transfer and the
 * offer and leaves the tile on screen, disabled, showing its gate reason in
 * place of the hint — so it must not name a listing either.
 */
export const cancelTitle = (set: Cancellable): string =>
  set.transfer && set.offer ? 'Cancel Pending' : set.transfer ? 'Cancel Transfer' : set.offer ? 'Cancel Listing' : 'Cancel Pending'

/** The line under that title. Rendered only where the gate is open, so the
 *  empty set's is the unreachable one. */
export const cancelHint = (
  set: Cancellable,
  subject: { readonly to: string | null; readonly priceNim: string | null },
): string => {
  if (set.transfer && set.offer) return 'Transfer and listing'
  if (set.transfer) return subject.to === null ? 'Stop the pending transfer' : `To ${subject.to}`
  if (set.offer) return subject.priceNim === null ? 'Withdraw the listing' : `Withdraw the ${subject.priceNim} NIM offer`
  return 'Nothing to cancel'
}

/**
 * A `K` withdraws an offer only from `openedHeight + OFFER_IRREVOCABLE` (§6
 * `O`), so one sent inside that window vetoes the transfer and leaves the
 * listing standing. Said as time remaining, not as a date: the window is hours,
 * and the message lands later than this line is written.
 */
export const offerStaysLine = (nim: string, blocksLeft: number): string =>
  `The ${nim} NIM listing stays — it can’t be withdrawn for another ${blocksApprox(blocksLeft)}.`

// Buy's card: a name for sale or under auction hands off to Market.
export const listedForSaleLine = (nim: string): string => `Listed at the marketplace for ${nim} NIM. `
export const listedForBiddingLine = (nim: string): string => `Listed at the marketplace for bidding (${nim} NIM). `
export const checkNowLabel = (): string => 'Check now.'
export const detailsLabel = (): string => 'Details'
export const connectToLabel = (action: string): string => `Connect to ${action}`

// Sheets and buttons shared by every flow.
export const closeLabel = (): string => 'Close'
export const cancelLabel = (): string => 'Cancel'

/**
 * The sheet's header and its submit button — one label, so the thing you tapped
 * and the thing you are about to sign are named identically. A `K` takes its
 * name from the cancellable set; every other action has a fixed one.
 */
export const sheetActionLabel = (action: AppAction, set: Cancellable): string =>
  action === 'cancel' ? cancelTitle(set) : ACTION_LABEL[action]

/**
 * The sheet's dismiss button. "Cancel" means "never mind" everywhere — except
 * beside a submit button that also says Cancel and means the opposite, which is
 * what the `K` sheet shipped as: *[Cancel what's pending] [Cancel]*.
 */
export const sheetDismissLabel = (action: AppAction): string =>
  action === 'cancel' ? closeLabel() : cancelLabel()
export const clearLabel = (): string => 'Clear'
export const signsWithLabel = (): string => 'Signs with'
export const submittingLabel = (): string => 'Submitting…'
export const confirmingLabel = (): string => 'Confirming…'
export const toLabel = (): string => 'To:'

// Market.
export const buyNowLabel = (): string => 'Buy Now'
export const placeBidLabel = (): string => 'Place Bid'
export const liveAuctionLabel = (): string => 'Live Auction'
export const fixedPriceLabel = (): string => 'Fixed Price'
export const startingPriceLabel = (): string => 'Starting Price'
export const standingBidLabel = (): string => 'Standing Bid'
export const soldByLabel = (): string => 'Sold by'
export const listedByLabel = (): string => 'Listed by'
export const buySheetTitle = (name: string): string => `Buy ${name}`
export const bidSheetTitle = (name: string): string => `Bid on ${name}`
export const connectToBuyLine = (name: string): string => `Connect your wallet to buy ${name}.`
export const connectToBidLine = (name: string): string => `Connect your wallet to place a bid on ${name}.`
export const listingLoadFailedLine = (name: string): string => `Could not load details for ${name} — try again.`
export const marketFilterPlaceholder = (): string => 'Filter listings by name…'
export const marketFilterAria = (): string => 'Filter listings by name'
export const MARKET_FILTER: Record<'all' | 'offers' | 'auctions', string> = { all: 'All', offers: 'Buy Now', auctions: 'Auctions' }
export const marketNoMatchTitle = (): string => 'No matching listings'
/** `filter` is the active pill's label, or null under "All". */
export const marketNoMatchLine = (query: string, filter: string | null): string =>
  filter === null ? `No names matched “${query}”.` : `No names matched “${query}” under ${filter}.`

// Pay.
export const balanceLabel = (): string => 'Balance:'
export const maxLabel = (nim: string): string => `MAX (${nim} NIM)`
export const resolveLabel = (): string => 'Resolve'
export const payNameAria = (): string => 'Name to pay'
export const payIdleTitle = (): string => 'Pay any NNS name'
export const payNimEmptyBody = (): string => 'Type a registered name to resolve its on-chain Nimiq address and send NIM.'

// Inbox.
export const backToInboxLabel = (): string => 'Inbox'
export const backToInboxAria = (): string => 'Back to inbox'
export const copyAddressLabel = (): string => 'Copy full address'
export const copiedLabel = (): string => 'Copied'
export const subjectAboutLabel = (): string => 'about'
export const yesterdayLabel = (): string => 'Yesterday'
