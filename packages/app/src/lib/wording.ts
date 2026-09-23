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

import type { QuorumReport, WarningCode } from '@nimiqnames/resolver'
import type { AppAction, Cancellable, GateReason } from './states'
import type { QueryFault } from './search'
import type { PayMessageFault } from './payRequest'
import { CONSTANTS, type LabelInvalidReason, type NameInvalidReason } from '@nimiqnames/core'
import { blocksApprox, formatApproxIn, lunaToNim } from './format'

// ── The site's own name ─────────────────────────────────────────────────────

/**
 * What the product is called to a reader: **Nimiq Names**. `NNS` is the
 * protocol — the thing the messages, the spec and the packages are named
 * for — and it stays in the documentation and the social card, not in the
 * chrome (Rico, 2026-09-13). The masthead and the footer both read this.
 */
export const SITE_NAME = 'Nimiq Names'

// ── The masthead's nav ──────────────────────────────────────────────────────

/**
 * The repository, named once. The nav, the protocol document's URL and the
 * footer's Resources column all derive from it, so the three cannot drift.
 */
const REPO = 'https://github.com/selfcrypto/nns'

/**
 * The project's Telegram group, named once: the masthead's Contact door and
 * the landing footer's Community column are the same link, and two copies is
 * two links that drift.
 */
const TELEGRAM = 'https://t.me/nimiqnames'

/** The project's X account, checked 2026-09-18: "Nimiq Names", website nimiqnames.com. */
const X = 'https://x.com/nimiqnames'

/**
 * The four doors in the masthead — `[label, href]` pairs, the same shape and
 * for the same reason as `LANDING.footer.columns`: a route is not normally a
 * string this file holds, but here the link *is* the content.
 *
 * The order is increasing depth and then the action — read about it, read the
 * rules, read the code, go use it — which also puts Dashboard beside the
 * wallet corner on a wide screen, where an action belongs.
 *
 * **Protocol** rather than "spec": it is the word that means something to a
 * reader who is not already inside the project. It points at GitHub because
 * the document has no nimiqnames.com URL — nginx serves the bundle and
 * `/pay/<name>` and 404s the rest — and GitHub renders it. **Dashboard** is
 * `#/buy` rather than `#/names`: it is the tab bar's first entry and the one
 * screen worth arriving at with no wallet and no name, so it brings the whole
 * tab bar back rather than opening one empty room.
 */
export const NAV: readonly (readonly [string, string])[] = [
  ['Docs', '#/docs/intro'],
  ['Protocol', `${REPO}/blob/main/docs/nns-spec-v1.md`],
  ['GitHub', REPO],
  ['Dashboard', '#/buy'],
] as const

/**
 * The fifth door, and the only one that opens onto people rather than
 * documents, so it is a group and not a link: there is no contact *page* to
 * point at, and three channels behind one word is what the masthead has room
 * for (Rico, 2026-09-16).
 *
 * `null` is a channel that does not exist yet. It renders as a row that is
 * plainly not pressable, with the reason beside it, rather than as `#` — the
 * routes are the hash here (`lib/route.ts`), so `href="#"` would not be an
 * inert link, it would throw the reader out of whatever screen they were on.
 * A hidden row would say nothing at all, which is the same mistake the USDT
 * tab was making before it was greyed instead.
 *
 * The Telegram group is **this project's**, `t.me/nimiqnames`, not Nimiq's —
 * `LANDING.footer`'s Community column points at Nimiq's channels and one of
 * them moved here for the same reason (2026-09-16).
 */
export const CONTACT_TITLE = 'Contact'
export const CONTACT: readonly (readonly [string, string | null])[] = [
  ['Telegram', TELEGRAM],
  ['@RicoMaverick', 'https://t.me/ricomaverick'],
  ['X', X],
] as const
/** Beside a channel that has no address yet. Lowercase: it is a note, not a badge. */
export const contactSoonLabel = (): string => 'soon'

/** The phone button that holds `NAV`, for screen readers — it draws as a glyph. */
export const menuLabel = (): string => 'Menu'

/**
 * The night-mode switch, which also draws as a glyph. The label is the
 * action, not the state, because the icon beside it is already the action —
 * a moon on a lit page. A button whose picture says "go dark" and whose
 * label says "light" is one the two halves disagree about.
 */
export const themeToggleLabel = (dark: boolean): string =>
  dark ? 'Switch to day mode' : 'Switch to night mode'

// ── Verification lines ──────────────────────────────────────────────────────

/**
 * "Verified by 1 resolver" · "Verified by 2 resolvers" — the count alone, with
 * the parties listed under it by `resolverIdentityLine`.
 *
 * The operator used to be appended at N = 1 and nobody was named above it,
 * which is backwards: at N = 2 the line said two parties agreed and left the
 * user unable to name either (Rico, 2026-08-28, on adding a second resolver).
 * The list answers it at every N.
 */
export function verifiedByLine(quorum: QuorumReport): string {
  return `Verified by ${quorum.agreed} ${quorum.agreed === 1 ? 'resolver' : 'resolvers'}`
}

/**
 * The URL as a user can go and check it: absolute. The configured value may
 * be a same-origin path (`/api`, `config.ts`), which is right for `fetch` and
 * wrong on a card — "NIMIQNAMES.COM — /api" reads as a path that is not the
 * API (Rico, 2026-09-10), when `https://nimiqnames.com/api` is exactly where
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

/**
 * One agreeing party, as one line (Rico, 2026-09-15: *"I see both lines for
 * each resolver redundant and it say the same"*).
 *
 * The endpoint is the line, because it is the half a user can go and check
 * and the one a same-origin config would otherwise hide (the 2026-09-10
 * absolute-URL decision). The configured **name is kept only when the URL
 * does not already carry it** — `nimiqnames.com` above
 * `https://api.nimiqnames.com` was the same fact twice, while a party called
 * *Example Labs* answering at `api.example.com` is two facts and gets both.
 */
export function resolverParty(
  resolver: { readonly name: string; readonly url: string },
  base?: string,
): { readonly primary: string; readonly secondary: string | null } {
  const url = resolverUrlShown(resolver.url, base)
  const named = resolver.name !== '' && url.toLowerCase().includes(resolver.name.toLowerCase())
  return named ? { primary: url, secondary: null } : { primary: resolver.name, secondary: url }
}

/**
 * What a party's round trip cost. Whole milliseconds, because the number is
 * read rather than computed with, and a resolver is never called slow in
 * words: the figure is the whole claim.
 */
export const resolverLatency = (ms: number): string => `${Math.round(ms)} ms`

/** The "?" beside a line — what a screen reader calls it. */
export const hintLabel = (): string => 'More about this'

/**
 * Behind the "?" on the verified line: what the count rests on. The count
 * and the resolver list stay on the card (states doc §5 #1); this is the
 * mechanism, one tap away.
 */
export const verifiedHint = (): string =>
  'Each resolver answered with a Merkle proof, and this app checked it against the resolver’s published checkpoint before showing the address.'

/** The interval is `CHECKPOINT_INTERVAL` rendered, never typed — it has moved once already (720 → 60, 2026-09-23). */
export const proofPendingLine = (): string =>
  `Proof pending. The name works now. Checkpoints are cut every ${blocksApprox(CONSTANTS.CHECKPOINT_INTERVAL)}.`

/**
 * The badge on a delegated answer: **the host that answered, not the parent
 * name** (Rico, 2026-09-16: *"Imagine reading 'Resolved by binance' being
 * that name registered by 3rd party person"*).
 *
 * A name is not its brand. `binance` is registrable by anybody who gets there
 * first, so "Resolved by binance" reads as an endorsement by a company that
 * may have nothing to do with it, on the one card where the address carries
 * no proof. The host is the party that actually answered, it is a domain
 * whose owner the reader can judge for themselves, and §8.6's request goes to
 * it by name. `delegated.nimiqnames.com` says what happened; `nimiq` says who
 * to trust, which is the claim this tier exists to withhold.
 *
 * The parent is still named, one tap away, by `delegatedExplainer`: it is
 * what delegated, and the delegation is the proven half.
 *
 * `host` cannot be absent on a `DELEGATED` result (`resolve.ts` sets it with
 * the answer), so the fallback is for the type and not for a case: it names
 * the parent's host rather than the parent, which keeps the distinction even
 * where the name is all there is.
 */
export const delegatedLine = (parent: string, host: string | null): string =>
  host === null || host === '' ? `Resolved by ${parent}’s host` : `Resolved by ${host}`

/**
 * What a subdomain card's `?` says (Rico, 2026-09-15: *"sounds scary when it
 * shouldn't"*). The old line led with what is missing, and read as a warning
 * about a name whose owner had done nothing wrong. The delegation is a `D`
 * record in the leaf, covered by the same proof as the parent, so *it* is
 * verified on chain and saying so is not a bold claim. What is not proven is
 * the address the host answered with, and the second sentence attributes it
 * without dressing it as a risk. §8.5 #6's distinction is carried by the
 * *Subdomain* tag and the "Resolved by" badge, which is where the spec puts
 * it (and the badge names the host, `delegatedLine`), and §8.5 #5 asks for alarming language only where something is wrong.
 */
export const delegatedExplainer = (parent: string, host: string | null): string =>
  host === null
    ? `${parent} has delegated its subdomains to a host of its own, and that delegation is verified on chain. The address above is the one that host answered with.`
    : `${parent} has delegated its subdomains to ${host}, and that delegation is verified on chain. The address above is the one that host answered with.`

export const targetChangedLine = (): string =>
  'Repointed since the last checkpoint. This address is newer than its proof.'

// ── Warning tones (states doc §2) ───────────────────────────────────────────

export type Tone = 'depth' | 'info' | 'couldnt-check' | 'alarm'

export const WARNING_TONE: Record<WarningCode, Tone> = {
  QUORUM_BELOW_SPEC: 'info',
  // A misconfiguration of this deployment, not a finding about a name: the
  // count the "Verified by N" line shows is already the deduplicated one, so
  // the user is not being told something false. It is the operator who needs
  // to know, and `info` is where an operator looks.
  DUPLICATE_RESOLVER: 'info',
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
  DUPLICATE_RESOLVER: 'One resolver was listed twice and counted once.',
  PROOF_PENDING: proofPendingLine(),
  TARGET_CHANGED_SINCE_CHECKPOINT: targetChangedLine(),
  DELEGATE_HOST_UNPROVEN: 'The host came from the live record, not a proven one.',
  DELEGATED_ANSWER: 'This address is the host’s word, with no proof behind it.',
  ROOT_HEIGHTS_DIFFER: 'Couldn’t compare resolver checkpoints this time.',
  ANCHOR_NOT_CHECKED: 'Second-chain check not run.',
  ANCHOR_UNAVAILABLE: 'Couldn’t check the second-chain anchor.',
  ANCHOR_QUORUM_NOT_MET: 'Anchor pending. Publishers post each checkpoint within hours.',
  ANCHOR_STALE: 'Couldn’t confirm a recent anchor.',
}

// ── Halting failures (alarm tier) and availability failures ────────────────

export const alarmHeadline = (): string => 'Stop. Resolvers disagree'

export const alarmBody = (code: string): string => {
  switch (code) {
    case 'PROOF_INVALID':
      return 'A resolver served a proof that does not hold. Do not pay any address it showed.'
    case 'QUORUM_DISAGREEMENT':
    case 'QUORUM_ROOT_MISMATCH':
      return 'The resolvers gave different answers. No address is shown, because there is no way to pick one.'
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
  'Couldn’t reach enough resolvers. Try again.'

// ── Propagation (states doc §2, `QUORUM_LAGGING`) ───────────────────────────

/**
 * The resolvers answered as of different heights and differ: a change from
 * the newest blocks has reached one and not yet the other. Neutral on
 * purpose — this is the expected state for the seconds after every
 * registration, and the alarm vocabulary is not spent on it (Rico,
 * 2026-09-10, on the first live registration of the demo era).
 */
export const propagatingLine = (): string =>
  'A recent change is still reaching every resolver. It clears at the next macro block (<1 min).'

/** Under the line above: whether the screen is asking again on its own. */
export const propagatingRetryLine = (retrying: boolean): string =>
  retrying ? 'Checking again…' : 'Still catching up. Search again in a moment.'

// ── Delegates (never blame the subdomain) ───────────────────────────────────

export const delegateFailedLine = (parent: string): string =>
  `${parent}’s host did not answer. Only its owner can say whether the subdomain exists.`

export const parentNotDelegatingLine = (parent: string): string =>
  `${parent} doesn’t delegate subdomains.`

/**
 * Why a delegated card carries no name actions. States what NNS does *not*
 * hold — never whether the subdomain exists, which is the host's word alone
 * (§5 #4). What the card does still offer is the address: pay it, or ask the
 * parent's owner.
 */
export const subdomainNotRegistrableLine = (parent: string): string =>
  `Subdomains aren’t registered on NNS. ${parent}’s owner issues them.`

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
  `Goes to the address above, which ${parent}’s host gave. It may not be ${parent}’s owner.`

// ── Name states (states doc §1) ─────────────────────────────────────────────

export const availableLine = (): string => 'Available'

export const reservedLine = (): string =>
  'Reserved by the registry. Not open for registration.'

export const graceLine = (untilDate: string): string =>
  `Expired and not available. The owner can renew until ${untilDate}.`

/** `graceLine`'s date slot when no height is at hand to compute one. */
export const graceEndsUnknownPhrase = (): string => 'its grace period ends'

/** Detail-card expiry (states doc §1 REGISTERED: "expiry as ≈ date"). */
export const expiresLine = (whenDate: string): string => `Expires ${whenDate}.`

/**
 * The status tag, carrying the date the word depends on (Rico, 2026-09-15:
 * *"Registered until Aug 11, 2028 would look much better and it saves a
 * line"*). "Registered" and a separate *Expires* line said one thing in two
 * places; the tag is where a reader looks for the state, and the state is
 * "registered **until**". Inside the §10.4 window the tag becomes
 * `renewDueLine` instead, so there is still exactly one of these on a card.
 */
export const registeredUntilLine = (whenDate: string): string => `Registered until ${whenDate}`

export const ownedUntilLine = (whenDate: string): string => `Yours until ${whenDate}`

/** List-row form of the same fact. */
export const expiryUntilLine = (whenDate: string): string => `until ${whenDate}`

/** An availability miss that is neither reserved nor free: someone beat the lookup. */
export const justRegisteredLine = (): string =>
  'Just registered by someone else. Search again to see it.'

export const parentNotRegisteredLine = (parent: string): string =>
  `${parent} isn’t registered, so nothing can answer for its subdomains.`

export const pendingTransferLine = (newOwner: string, when: string): string =>
  `Transferring to ${newOwner} ${when}.`

export const forSaleLine = (priceNim: string): string => `For sale at ${priceNim} NIM`

// ── Auctions (§6 `A`, r28) ──────────────────────────────────────────────────

export const auctionLine = (startingPriceNim: string, endDate: string): string =>
  `Up for auction. Starting price ${startingPriceNim} NIM, ends ${endDate}.`

export const standingBidLine = (bidNim: string, bidder: string): string => `Highest bid ${bidNim} NIM from ${bidder}.`

export const noBidsLine = (): string => 'No bids yet.'

/** The API's `minimumBid` — `core.requiredBid`; a `B` below it refunds, it is not accepted. */
export const minimumBidLine = (nim: string): string => `Next bid: at least ${nim} NIM.`

/** The bid field's own placeholder. `null` while the minimum has not loaded. */
export const bidAmountPlaceholder = (minNim: string | null): string =>
  minNim === null ? 'Bid in NIM' : `Bid in NIM (at least ${minNim})`

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
  `The auction would end after the name expires (${expiryDate}). Renew first, or set an earlier end.`

/**
 * The bid reading of `WRONG_PRICE`, and of being outbid: neither is a
 * forfeit. Both are refunds, and both come from the operator (§8.5 #10).
 */
export const bidRefundLine = (): string =>
  'A bid below the minimum is refunded, not accepted. So is yours, the moment a higher bid lands.'

/**
 * §8.5 #10 for a bid: money is held for the whole window, not only in flight.
 * The line states the custody; `bidCustodialHint` carries when the money comes
 * back — see `custodialWarning` for why the two are split.
 */
export const bidCustodialWarning = (): string =>
  'The marketplace operator holds your bid until the auction ends.'

export const bidCustodialHint = (): string =>
  `It comes back the moment a higher bid lands, and again if the auction is cancelled. ${SETTLEMENT_ASSURANCE}`

export const feeChangeLine = (whenDate: string): string =>
  `Fees change ${whenDate}.`

export const renewDueLine = (whenDate: string): string => `Renew before ${whenDate}`

/** List-row form of the grace state: renewable until the grace **end** date. */
export const graceBadge = (untilDate: string): string => `In grace, renew by ${untilDate}`

// ── Gate reasons (states doc §4; shown on disabled actions) ─────────────────

export const GATE_REASON_TEXT: Record<GateReason, string> = {
  taken: 'This name is registered.',
  reserved: 'Reserved names can’t be registered.',
  'in-grace': 'In grace. Only renewal works until it ends.',
  'no-record': 'This name isn’t registered.',
  'no-viewer': 'Connect a wallet to act on names.',
  'not-owner': 'Only the owner can do this.',
  'nothing-to-cancel': 'Nothing is pending on this name.',
  // One pending thing per name (§7.3, r30): three tiles close on each of these.
  'offer-open': 'This name is already for sale. Cancel that first.',
  'transfer-pending': 'A transfer is pending. Cancel that first.',
  'no-offer': 'This name is not for sale.',
  // One short line, because it appears on up to four rows at once — the
  // auction's own facts are in the overlay above them.
  'auction-open': 'Locked while the auction runs.',
  'no-auction': 'This name is not up for auction.',
  'state-unknown': 'Couldn’t read this name’s record. Try again.',
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
  TOO_LONG: `Too long. ${CONSTANTS.MAX_NAME_LEN} characters at most.`,
  BAD_CHARACTER: 'Only a–z, 0–9 and hyphens.',
  NO_LETTER: 'A name needs at least one letter.',
  LEADING_HYPHEN: 'Can’t start with a hyphen.',
  TRAILING_HYPHEN: 'Can’t end with a hyphen.',
  DOUBLE_HYPHEN: 'No two hyphens in a row.',
  INTERIOR_DIGIT: 'Digits go at the start or the end, never in the middle.',
  // §4.2's r6 boundary clause, which this used to describe as "digits can only
  // lead or trail, not both" — a rule that does not exist: `2nimiq2`,
  // `9nimiq9` and `23nimiq45` are all valid. What is barred is `0` and `1` at
  // either end, closing `nimiq0`/`nimiqo` and `1rico`/`lrico`.
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
  TOO_LONG: `The part before the dot is too long. ${CONSTANTS.MAX_LABEL_LEN} characters at most.`,
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
      return 'One dot at most. Write name, or label.name.'
    case 'dot-shape':
      return 'Write a subdomain as label.name (for example pay.shopper).'
    case 'label':
      return LABEL_REASON_TEXT[fault.reason]
    case 'name':
      return NAME_REASON_TEXT[fault.reason] ?? 'Not a valid name.'
    case 'unspecified':
      return 'Not a valid name.'
  }
}

// ── Buy (§8.5 #10) ────────────────────────────────────────────────────────

/**
 * §8.5 #10 wants two things: **show** that settlement is custodial, and
 * **require explicit confirmation**. Both are still on the card — this line,
 * and `buyAcknowledgeLabel`'s checkbox, which gates the send button. What
 * moved behind the hint is the *when*: a lost race, a cancelled offer, the
 * auditability aside. That is the why, and the 2026-09-04 hint decision is
 * explicit that the why may go one gesture away while the warning stays.
 *
 * It was one 62-word sentence fusing all four facts (Rico, 2026-09-14: *"is
 * awful, bad worded and long"*). A warning nobody finishes reading is not a
 * warning, which is the failure this split is fixing — not a relaxation of
 * the rule.
 */
/**
 * The two sentences §8.5 #10 wants beside every custodial disclosure, written
 * once. All three hints carried their own copy, which is how a shared fact
 * becomes three facts that drift (2026-09-15).
 */
export const SETTLEMENT_ASSURANCE =
  'The public log shows what is owed and what has been paid, so a shortfall can’t be hidden. It is still a promise, not a protocol rule.'

export const custodialWarning = (): string =>
  'The marketplace operator holds your payment until settlement.'

export const custodialHint = (): string =>
  `The name is yours as soon as your payment is final. That part is protocol. The money is not: if this purchase loses a race or hits a cancelled sale, the operator refunds you. ${SETTLEMENT_ASSURANCE}`

/**
 * The Market screen's own disclosure. The list holds offers **and** auctions,
 * so it says the neutral fact once rather than the buy variant, which is what
 * it had been showing over a list half of which takes bids.
 */
export const marketCustodialLine = (): string =>
  'The marketplace operator holds payments and bids until settlement.'

export const marketCustodialHint = (): string =>
  `A name transfers on the chain the moment the payment is final. The money settles separately, through the operator: a purchase that loses a race or hits a cancelled sale is refunded, and so is a bid the moment it is outbid. ${SETTLEMENT_ASSURANCE}`

/** app-ux §5: the sheet shows only the marketplace address, so the app says who is selling. */
export const soldByLine = (seller: string): string => `Sold by ${seller}.`

/**
 * What a seller actually receives. The line it replaced was "The marketplace
 * takes its commission from the sale, not from listing" — which contrasts the
 * sale against a charge that does not exist (`LISTING_FEE` is 0, settled at
 * zero by §12 item 3), so it read as a warning about a fee nobody pays. Rico,
 * 2026-09-14: *"doesn't make sense since the user doesn't pay anything. That
 * amount is just the initial price he asks for, so no coins to take a fee
 * from."*
 *
 * The amount comes from `core.commissionOn` against the **served**
 * `commissionBp`, never `CONSTANTS.COMMISSION_RATE`: a `P` moves the rate
 * (§10.6), and a restated constant would put a number on screen that the
 * settlement will not honour.
 */
export const sellerProceedsLine = (netNim: string, percent: string): string =>
  `You get ${netNim} NIM if it sells, after the ${percent} marketplace commission.`

/** The auction form: the starting price is a floor, so the proceeds are a minimum. */
export const auctionProceedsLine = (minNetNim: string, percent: string): string =>
  `You get at least ${minNetNim} NIM, after the ${percent} commission on the winning bid.`

// ── Send flows (docs/app-ux.md §4 — one state machine, one vocabulary) ─────

/**
 * Current-state lines, shown at the top of an action sheet so the owner sees
 * what they are about to change before typing anything (Rico, 2026-08-23).
 * The expiry date is the block-clock approximation — ~1 block/s — and keeps
 * the `≈` the states doc requires.
 */
export const currentTargetLine = (target: string): string => `Currently points to ${target}.`

export const currentEvmLine = (evm: string): string => `Currently linked to ${evm}.`

export const noEvmLine = (): string => 'No address linked yet.'

export const currentHostLine = (host: string): string => `${host} currently answers for subdomains.`

export const noHostLine = (): string => 'No subdomain host set.'

/**
 * The `D` review, both directions (Rico, 2026-09-14: *"Subdomains under
 * ricomaverick stop resolving" … doesn't make sense, since they're resolved
 * too, but by the delegated host*). The old clear line said resolution stops,
 * which reads as NNS taking away something it was doing — and NNS never
 * resolved a subdomain at all. §8.6 gives a label no record and no owner: the
 * host is the whole mechanism, so clearing it is not a downgrade to on-chain
 * resolution, it is the end of the only resolution there was.
 *
 * One sentence each, and the rest behind the bubble (Rico, 2026-09-15: *"the
 * second sentence can be removed since it says nothing new … have short and
 * clear feedback and when more is needed use a (i) bubble"*). What the two
 * second sentences carried — that the host's answers are its own word, and
 * that nothing resolves a subdomain without one — is the *why* beside a fact
 * the reader already has, which is what a hint is for.
 */
export const delegateSetLines = (host: string, name: string): readonly string[] => [
  `${host} will answer for everything under ${name}.`,
]

export const delegateSetHint = (host: string): string =>
  `The delegation is on chain, so anyone can verify you set it. The addresses under it come from ${host} itself.`

export const delegateClearedLines = (name: string): readonly string[] => [
  `No host will answer for subdomains under ${name}.`,
]

export const delegateClearedHint = (): string =>
  'Subdomains resolve only through the host. The name itself resolves as before.'

/**
 * Clearing is a checkbox, the way `S`'s "Point back at my address" and `E`'s
 * "Remove the linked address" already were (Rico, 2026-09-15, pointing at the
 * `S` sheet: *"show to where is delegated at the moment and a checkbox"*). An
 * empty field meant a clear before that, which is indistinguishable from a
 * sheet nobody has typed in yet.
 */
export const clearHostCheckLabel = (): string => 'Remove the current host'

export const clearHostLabel = (): string => 'Clear subdomain host'

/** The field, which must never echo the current host: a placeholder that
 *  repeats it reads as a filled box (Rico, 2026-09-15). */
export const hostPlaceholder = (hasHost: boolean): string =>
  hasHost ? 'New host, e.g. nns.example.com' : 'Host, e.g. nns.example.com'

/**
 * The rest of every review, one bubble per sheet (Rico, 2026-09-15: *"a
 * fucking shit ton of text here too to say the same over and over"*, on an `E`
 * review whose three lines were the address, the chains it covers and a
 * reminder to check it). The review keeps what changes if you press the
 * button: the amount, the address, the date, what gets voided. The rule
 * behind it, which is the same on every send, is here.
 */
export const renewHint = (): string =>
  'The term extends from the current expiry, not from today, so renewing early costs nothing extra.'

export const targetHint = (): string =>
  'The wallet’s own screen shows this address as the recipient of the message, so it can be checked there too.'

export const evmHint = (): string =>
  'One address covers every EVM chain. The registry records what you declare, so check this one is yours.'

/**
 * One line, and the duration comes from `CONSTANTS.XFER_TIMELOCK` through
 * `blocksApprox`. It read *"Ownership moves to NQ88 … after ~12 h. Until then
 * the name stays under your control, and Cancel can stop it."* — a hardcoded
 * delay that no tempo era has, above a field already showing that address, and
 * a second sentence the bubble beside it already carries.
 */
export const transferMovesLine = (delay: string): string =>
  `Ownership moves to the address above in ${delay}, unless you Cancel Transfer first.`

export const transferHint = (): string =>
  'You can cancel it or change the recipient any time before it lands. The delay guards a mistyped address, not a stolen key.'
export const transferReplacesLine = (oldTo: string, delay: string): string =>
  `Replaces the pending transfer to ${oldTo}. The new one lands in ${delay}.`
export const offerRepricesLine = (name: string, oldNim: string, newNim: string): string =>
  `Changes the price of ${name} from ${oldNim} NIM to ${newNim} NIM.`

export const offerHint = (): string =>
  `You can change the price or take it off sale any time, and it expires by itself in ${blocksApprox(CONSTANTS.OFFER_MAX_LIFETIME)}.`

export const auctionHint = (extension: string): string =>
  `Nothing can be withdrawn once open, and a bid in the last ${extension} extends the end by ${extension}. The highest bid wins and the name transfers at the close.`

export const bidHint = (extension: string): string =>
  `A bid in the last ${extension} extends the auction by ${extension}. ${bidRefundLine()}`

export const currentExpiryLine = (approx: string): string => `Currently expires ${approx}.`

/** The silent pre-fill: the host wallet already exposed the address. */
export const suggestedEvmLabel = (evm: string): string => `Use this wallet’s address: ${evm}`

/**
 * The gesture-driven path: raises the wallet's own connect sheet
 * (`eth_requestAccounts`), the same flow every EVM dApp gets in Pay's
 * browser. The ellipsis is the "a dialog follows" convention.
 */
export const connectEvmLabel = (): string => 'Use my wallet’s USDC / USDT address…'

export const connectEvmFailedLine = (): string => 'The wallet offered no address. Paste one instead.'

export const ACTION_LABEL: Record<AppAction, string> = {
  register: 'Register',
  setTarget: 'Change where it points',
  setEvm: 'Link USDC / USDT address',
  transfer: 'Transfer ownership',
  delegate: 'Set subdomain host',
  cancel: 'Cancel Pending',
  renew: 'Renew',
  offer: 'Put up for sale',  /* the action; every status word is "sale" */
  buy: 'Buy',
  auction: 'Put up for auction',
  bid: 'Bid',
}

/**
 * `N` on Buy, for a name the viewer does not hold (Rico, 2026-09-09: "Lets
 * allow it as gift"). Anyone may renew (§6 `N`); the label says what the
 * payer gets — nothing — so the button cannot read as a way to acquire.
 */
/**
 * The registration review's first line. The term is `TERM_LENGTH` rendered,
 * never typed, and rendered by `termChoiceLabel` so it is spelled the way the
 * choice directly above it spells it. No article and no "term" after it:
 * `termChoiceLabel` is already a period, and "a 7 days term" is what the
 * alternative reads as in a compressed era.
 */
export const registerPaysLine = (nim: string, term: string): string =>
  `Pays ${nim} NIM to the registry for ${term}.`

/**
 * The lifetime registration's first line (§10.4): the date a
 * hundred terms actually reach, never the word "lifetime" as a promise —
 * that word is the choice's label and nothing else.
 */
export const registerLifetimePaysLine = (nim: string, untilDate: string): string =>
  `Pays ${nim} NIM to the registry. Yours until ${untilDate}.`

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
 * The price table (components/PriceTable.tsx), on the landing page and on
 * Buy before a query: §10.1 as rows, off `/params.fees` like the hint below.
 * A reader asked for the table, not the sentence (Rico, 2026-09-22).
 */
export const PRICE_TABLE = {
  length: 'Length',
  year: 'A year',
  lifetime: 'Lifetime',
  reserved: `Names of ${CONSTANTS.MIN_NAME_LEN - 1} characters or fewer are reserved.`,
  more: 'Prices, terms and expiry',
} as const
/** The collapsed row's one number: the cheapest band, off the live table. */
export const fromPriceLine = (nim: string): string => `From ${nim} NIM a year`
/** A band's span of lengths: "5", "7–11", or "12+" for the last one. */
export const lengthBandLabel = (from: number, to: number | null): string =>
  to === null ? `${from}+` : from === to ? `${from}` : `${from}–${to}`
export const nimAmountLine = (nim: string): string => `${nim} NIM`
/**
 * Under an available name's two prices (`PriceRow`): the wallet's balance
 * on the right, and on the left either the plain label or, when it does not
 * cover a year, the one thing the reader needs to know.
 */
export const walletBalanceLabel = (): string => 'Wallet balance'
export const notEnoughForYearLine = (): string => 'Not enough for a year'
/** At the top of the address panel for a lone address: what it holds, at a glance. */
export const walletHoldsLine = (nim: string): string => `Your wallet holds ${nim} NIM`

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
    `Price follows length: a year is ${parts.join(', ')} characters. Shorter names are reserved. ` +
    `A lifetime is ${CONSTANTS.LIFETIME_TERMS} terms for the price of ${CONSTANTS.LIFETIME_MULTIPLIER}.`
  )
}

/**
 * §10.7 on the review: what the payer gets back. The price on the screen is
 * the price either way, and the rebate arrives **after**, as a second
 * transaction — the part a payer must not be left to guess at when the wallet
 * asks for the full amount.
 *
 * **The referrer's own share is not on this screen** (Rico, 2026-09-12: "no
 * point into showing an user that is going to pay the same how much is going
 * to receive the referrer"). It changes nothing the buyer decides, and a
 * number a reader cannot act on reads as a cost they are carrying. It stays
 * where it is somebody's own business: the owner's Share tile, and the
 * published table on the docs page.
 *
 * `rebate` is `null` where no row in effect pays one, and then the line is
 * the one this said before the rebate existed.
 */
export const referredByLine = (ref: string, rebate: string | null = null, netOfBurn = false): string =>
  rebate === null
    ? `Referred by ${ref}. ${PRICE_UNCHANGED}.`
    : `Referred by ${ref}. ${rebate}${netOfBurn ? ` ${BURN_ASIDE}` : ''} comes back to you once it confirms.`

/**
 * The rates Rico publishes are the ones he decided — 5% and 5% — and the
 * table holds what the payer sends, which is a fifth less, because §10.2
 * burns a share of everything the treasury takes in and a payout must not be
 * burned on twice (decisions.md, "A referral payout is net of the burn").
 * Showing the net figure alone answered a question nobody asked and made the
 * published programme look smaller than it is; showing the headline alone
 * would overstate what lands. So the number is the headline and the burn is
 * named beside it, in the fewest words that are still true.
 */
export const BURN_WORD = 'minus the registry’s burn'
const BURN_ASIDE = `(${BURN_WORD})`

/**
 * §10.7 made visible before the review: a stored ref is about to travel with a
 * registration, and a field the user cannot see is one they cannot correct.
 * The strip is where it is shown, on the landing page and on Buy, and the
 * remove control beside it is the correction.
 */
/**
 * One sentence for "a referral costs you nothing", because it was three:
 * *"You pay the same."*, *"Your price is unchanged"* and *"The price is the
 * same either way."* — the same fact, stated three ways within one flow
 * (2026-09-15).
 */
export const PRICE_UNCHANGED = 'Your price is unchanged'

export const REFERRER_STRIP = {
  label: 'Referred by',
  note: PRICE_UNCHANGED,
  remove: 'Remove',
  removeLabel: 'Remove this referrer',
} as const
/**
 * The buyer's half of §10.7, on the strip. The rebate is the reason a link is
 * worth following at all, so it is the sentence that gets the numbers — and
 * it says *back*, because the wallet will still ask for the whole fee.
 *
 * It is the **only** rate the strip shows: what the referrer earns is not the
 * reader's business and not theirs to decide (`referredByLine`).
 */
export const buyerRebateLine = (percent: string, netOfBurn = false): string =>
  `You get ${percent}${netOfBurn ? ` ${BURN_ASIDE}` : ''} of the fee back after you register.`
/**
 * A pasted share link whose ref was **not** taken, because one is already
 * held: first wins (§10.7's client half). The strip answers the ordinary
 * case by appearing, so this line exists only for the one it cannot — a box
 * that emptied and a strip that did not change.
 */
export const referrerKeptLine = (ref: string): string => `You were already referred by ${ref}, so that link was not used.`
/**
 * The self-referral case (settlement's `selfBp`): the buyer already controls
 * the referring name, so a share would move the treasury's money from the
 * payer back to the payer. Nothing is refused — the ref is simply dropped,
 * and this says so rather than promising a share that will not be paid.
 */
export const referredBySelfLine = (ref: string): string =>
  `${ref} is your own name, so no referral share is paid.`

export const giftRenewalLabel = (): string => 'Gift a renewal'

/** The review line that makes the gift explicit before the wallet opens. */
export const giftRenewalLine = (owner: string): string =>
  `You don’t own this name. The term extends for ${owner}.`

/* ── Refusals from the action builder (`lib/actions.ts`) ──────────────────
 *
 * These lived as literals beside the code that threw them, which put fifteen
 * user-visible sentences outside the catalog and outside the em-dash sweep —
 * and let two of them drift from the gate reason for the same condition
 * ("No open offer on this name" against "This name is not for sale").
 * They end in a full stop, like every other sentence the app shows.
 */

export const noThousandsSeparatorLine = (what: string): string =>
  `${what} is typed without thousands separators, like 12345 rather than 12,345.`

export const notANimAmountLine = (what: string): string => `${what} must be a NIM amount, like 450 or 1.5.`

export const notADurationLine = (): string => 'Duration must be a number of days, like 3 or 1.5.'

export const auctionTooShortLine = (minimum: string): string => `An auction runs at least ${minimum}.`

export const auctionTooLongLine = (maximum: string): string => `An auction runs at most ${maximum}.`

export const notAnAddressForLine = (what: string): string => `${what} is not a Nimiq address.`

export const feesUnavailableLine = (): string => 'The current fees could not be loaded. Try again.'

export const alreadyOwnerLine = (): string => 'That is already the owning address.'

export const noHostTypedLine = (): string => `Type a host, or tick ${clearHostCheckLabel()}.`

export const nothingToClearLine = (): string => 'No subdomain host is set, so there is nothing to clear.'

export const alreadyYoursLine = (): string => 'This name is already yours.'

export const ownAuctionLine = (): string => 'This is your own auction.'

export const bidBelowMinimumLine = (nim: string): string => `Bid must be at least ${nim} NIM.`

export const notAUsdtAmountLine = (): string => 'Amount must be a USDT amount, like 25 or 9.50.'

/* ── Labels that were living in their components ──────────────────────────
 *
 * The catalog is only worth reading if it is complete, and these were not in
 * it: the tab bar in `App.tsx`, the composer's two labels, the three sheet
 * placeholders, and Pay's amount labels, which were a **second copy** of
 * `payAmountLabel` and `usdtAmountLabel` written out again in the screen
 * (2026-09-15).
 */

export const TAB_LABEL = {
  home: 'Home',
  // "Buy/Search" rather than "Buy": the tab is still named for the job, but the
  // job people arrive with is looking a name up, and a tab called Buy reads as
  // a shop you have to enter before you may ask a question.
  buy: 'Buy/Search',
  pay: 'Pay',
  names: 'My Names',
  inbox: 'Inbox',
  market: 'Market',
  docs: 'Docs',
} as const

export const showEveryAddressLabel = (): string => 'Show every address'

export const composerToLabel = (): string => 'To the owner of '

export const composerPlaceholder = (): string => 'A short message…'

export const pricePlaceholder = (): string => 'Price in NIM'

export const startingPricePlaceholder = (): string => 'Starting price in NIM'

/**
 * The bounds are `AUCTION_MIN_DURATION` and `AUCTION_MAX_DURATION`, not the
 * numbers 1 and 7: a day and a week on mainnet, an hour and whatever a tempo
 * era says, and the placeholder read "(at least 1)" in both (2026-09-15, the
 * same defect as the transfer delay).
 */
export const durationPlaceholder = (minimum: string, maximum: string): string =>
  `Duration in days, ${minimum} to ${maximum}`

/* ── A field that takes an address or a name (`lib/addressField.ts`) ── */

export const addressOrNamePlaceholder = (): string => 'Address or name'

/** `S` on your own address: the checkbox above the field already does it, and `core`'s own refusal is a sentence about transactions. */
export const ownAddressTargetLine = (): string => 'That is your own address. Tick Point back at my address instead.'

export const lookingUpLine = (query: string): string => `Looking up ${query}…`

/** After the field fills itself in: which name the address came from, and from whom. */
export const filledFromNameLine = (query: string): string => `${query} points to this address.`

/**
 * The same, for a subdomain. The address is the host's answer rather than the
 * chain's (§8.6), and a field that is about to write it into a record says so
 * once, plainly. Not a warning: §8.5 #5 keeps alarm language for what is
 * wrong, and nothing here is.
 */
export const filledFromDelegateLine = (query: string): string => `${query} is answered by its host, which gave this address.`

export const lookupNoAddressLine = (query: string): string => `${query} isn’t registered, so it has no address.`

export const lookupInGraceLine = (query: string): string => `${query} is in grace and doesn’t resolve.`

export const lookupFailedLine = (query: string): string => `${query} doesn’t resolve to an address.`

export const lookupUnavailableLine = (query: string): string => `Couldn’t check ${query} just now.`

export const notAnAddressLine = (): string => 'That is not a Nimiq address.'

export const sendSubmittingLine = (): string => 'Waiting for the wallet…'

/**
 * What the confirm loop is actually waiting for, rather than a bare
 * "confirming…": the indexer scans by batch, so the effect becomes visible at
 * the API when the batch's macro block closes, in exact 60-block steps
 * (2026-08-21, `send.ts`'s `settling`).
 *
 * **One clock, named once** (Rico, 2026-09-15: *"the waiting message isn't
 * the same for every card using it"*). Every screen that waits says this, and
 * `sendSettlingLine` gives the same estimate in its own words: two different
 * numbers for one batch is the app disagreeing with itself.
 */
export const sendConfirmingLine = (): string => 'Sent. Waiting for the next macro block to confirm it (<1 min).'

export const sendConfirmedLine = (): string => 'Done.'

export const sendDeclinedLine = (): string => 'Nothing was sent.'

/** Never "sent ✓": the network did not show the effect, and that is all anyone can say. */
/**
 * The strongest negative the app is entitled to, and weaker than it used to
 * be. It claimed "the network did not include this transaction" on evidence
 * that only concerned our own indexer's visibility — and said it about a
 * registration that was already registered (Rico, 2026-08-21). The send
 * machine now asks the chain before reaching this line at all, so by the time
 * it shows, the transaction was not found in a block either. Even then it is
 * "hasn't appeared", never "was refused": a transaction can still be in
 * flight, and a retry re-signs a different one and pays a second fee.
 */
export const sendUnconfirmedLine = (): string =>
  'Not confirmed: it hasn’t appeared on chain. Check the name before sending again.'

/**
 * On chain and executed, with the effect not yet visible at the API. The
 * common ending for a registry effect rather than an exceptional one: the
 * indexer scans by batch, so the API can be up to a full batch behind the
 * chain. Says nothing went wrong, because nothing did.
 */
export const sendSettlingLine = (): string =>
  'Confirmed on chain. The registry catches up at the next macro block (<1 min).'

/**
 * In a block, and it did not execute. The one case where the transaction is
 * definitely spent and definitely ineffective, so it must not read like
 * either of the "check again" outcomes.
 */
export const sendRejectedLine = (): string =>
  'On chain, but it did not execute. Nothing changed and the fee is spent.'

/**
 * The checker was down, not the send — a broken checker never reads as a
 * negative result. No failure claim, no retry prompt: a retry re-signs a
 * different transaction and can pay a second fee.
 */
export const sendUncheckedLine = (): string =>
  'Sent, but the service didn’t answer, so this is unconfirmed. Check again later.'

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
 * (Rico, 2026-08-22) — a caveat nobody asked for, attached to a button whose
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
  `A note for whoever receives this, like an invoice or an order number. It is written on the chain against both addresses: public, permanent, readable by anyone. Room for ${CONSTANTS.MAX_DATA_BYTES} bytes, which is that many plain letters and fewer with accents or emoji.`

export const payMessageBudgetLine = (used: number, budget: number): string => `${used}/${budget} bytes`

/** The message came with the link, so it is the payee's wording until the payer takes it over. */
export const payMessageFromLinkLine = (): string => 'Came with the payment link.'

export const payMessageEditLabel = (): string => 'Edit'

/**
 * One refusal for one limit, on both surfaces that can hit it. Pay read the
 * budget from `MAX_DATA_BYTES` and the chat composer typed *"a 64-byte
 * transaction"*, so the same rule met the user as two sentences with two
 * spellings of the same number (2026-09-15).
 */
export const overBudgetLine = (): string => `Too long. A message travels in ${CONSTANTS.MAX_DATA_BYTES} bytes.`

export const PAY_MESSAGE_FAULT_TEXT: Record<PayMessageFault, string> = {
  OVER_BUDGET: overBudgetLine(),
  RESERVED_PREFIX: 'A message can’t start with NNS1. That prefix is reserved for name messages.',
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

export const usdtWrongChainLine = (): string => 'The wallet wouldn’t switch to Polygon. Nothing was sent.'

/**
 * Not enough USDT for the amount typed. One line for both moments it can
 * arrive: before a send, when the displayed balance already answers, and
 * after one, when the wallet refused and the measured balance explains why —
 * so it states the shortfall and stays silent about sending.
 */
export const usdtShortBalanceLine = (held: string, asked: string): string =>
  `The wallet holds ${held} USDT, not enough to send ${asked}.`

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
  'The wallet has no POL for Polygon’s network fee. Nothing was sent.'

/**
 * The wallet returned a hash — which is not confirmation, and no endpoint of
 * ours watches Polygon, so the honest report names the wallet as the actor
 * and hands over the one thing that can be tracked.
 */
export const usdtAcceptedLine = (): string => 'The wallet accepted it. Track it on Polygonscan:'

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
  'This is your own address. Nimiq drops a payment to yourself, so nothing would arrive.'

export const buyAcknowledgeLabel = (): string =>
  'I understand a refund would come from the marketplace operator'

/**
 * An account that cannot cover the value signs a transaction the network will
 * never include, and the confirm loop then reports the drop as ambiguously as
 * it can (a friend's 200 NIM registration from an empty wallet, 2026-09-14).
 * The balance is knowable before the wallet opens, so it is said here, with
 * both numbers: "insufficient funds" makes the user go and look up two
 * figures the app already has.
 *
 * Two numbers and nothing else. It used to add "Top it up first, sending now
 * would pay nothing and register nothing" — describing a send the sheet had
 * already blocked (`ready` requires `shortfall === null`), which is what made
 * a reader ask why it would let the transaction through (Rico, 2026-09-14).
 * A line under a disabled button does not need to argue against pressing it.
 */
export const insufficientBalanceLine = (needNim: string, haveNim: string): string =>
  `Needs ${needNim} NIM. Your wallet holds ${haveNim} NIM.`

// ── Pinning (§8.5; states doc §2 — mismatch is the alarm tier) ─────────────

export const pinFirstUseLine = (): string => 'First time you’ve used this name on this device.'

export const pinMismatchTitle = (): string => 'Stop. This name changed address'

export const pinMismatchBody = (query: string, sinceDate: string): string =>
  `When you last used ${query} on this device (${sinceDate}), it pointed to a different address. The owner may have repointed it, or someone may be redirecting payments. Do not pay until you know which.`

export const pinPreviousLabel = (): string => 'Address you used before'

export const pinCurrentLabel = (): string => 'Address it points to now'

export const pinOverrideLabel = (): string => 'Use the new address anyway'

export const pinOverrideConfirmLabel = (): string => 'Yes, replace what this device remembers'

// ── NC chat (docs/app-chat.md §5 — wording is part of the threat model) ────

export const messageOwnerLabel = (): string => 'Message the owner'

export const chatPublicNotice = (): string =>
  'Messages are public, permanent, and attached to your address. Anyone can read them on chain, forever.'

export const chatOwnNameLine = (): string =>
  'This name is yours. A message to yourself can’t be sent.'

export const chatBudgetLine = payMessageBudgetLine

export const CHAT_ENCODE_TEXT: Record<'EMPTY_MESSAGE' | 'CONTROL_CHARS' | 'OVER_BUDGET', string> = {
  EMPTY_MESSAGE: 'Write something first.',
  CONTROL_CHARS: 'Plain text only. No control characters.',
  OVER_BUDGET: overBudgetLine(),
}

export const inboxWindowLine = (sinceDate: string): string => `Messages since ${sinceDate}.`

/**
 * The accessible name of the per-message explorer link (Rico, 2026-09-15: *"to
 * give more confidence to the service"*). It draws as `ExternalIcon` alone —
 * a bubble is the wrong place for a sentence — so this carries the whole
 * meaning for a screen reader and for the tooltip.
 */
export const viewOnExplorerLabel = (): string => 'Check this message on a block explorer'

/*
 * `notYourNameLine` was here: *"Not one of your names. The name in a message
 * is only the sender's claim."* It is gone with the subject field it policed
 * (2026-09-15). It was shown in the alarm palette on a message that attacked
 * nobody, and two lines under a hint saying names on this screen come from the
 * registry — two true statements about two different names, reading as a
 * contradiction because nothing distinguished them. Rico: *"both estatements
 * say the opposite"*, and then *"the red message must be removed because it
 * won't make sense at all"*.
 */

export const hiddenSendersLabel = (count: number): string => `Hidden (${count})`

export const hideSenderAction = (): string => 'Hide sender'

export const unhideSenderAction = (): string => 'Unhide'

export const inboxNoWalletLine = (): string =>
  'Connect a wallet to read the messages sent to its address.'

export const inboxNotConfiguredLine = (): string =>
  'No RPC endpoint configured. Set VITE_NNS_RPC to the operator-run relay URL.'

/** Attributed to the inbox service, never to resolvers — and nothing is lost. */
export const inboxDownLine = (): string =>
  'The inbox service didn’t answer. Messages are on chain and will appear when it returns.'

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
  'Register a name in Buy. It points at your address from the moment it lands.'

/** The button under that line — the sentence names Buy, this goes there. */
export const myNamesEmptyAction = (): string => 'Find a name'

export const offersEmptyTitle = (): string => 'Nothing on the marketplace'

export const offersEmptyBody = (): string => 'Names for sale and open auctions show here.'

export const inboxNoWalletTitle = (): string => 'No wallet connected'

export const inboxNotConfiguredTitle = (): string => 'Inbox not set up'

export const inboxEmptyTitle = (): string => 'No messages'

// ── The burn record (§10.2 — burned, owed, and the gap between them) ────────

export const burnTitle = (): string => 'Fee burn'

export const burnBurnedLabel = (): string => 'Burned so far'

export const burnOwedLabel = (): string => 'Owed so far'

export const burnShortfallLine = (nim: string): string => `Behind by ${nim} NIM, owed but not yet burned.`

export const burnSurplusLine = (nim: string): string => `Ahead by ${nim} NIM, more burned than owed.`

export const burnEvenLine = (): string => 'Burned exactly what is owed.'

/**
 * Both halves or nothing: burned alone says nothing about whether the
 * commitment is being kept, which is why §10.2 calls the record auditable
 * rather than promised. The share is computed, not written out — a `P`
 * cannot move it, but a spec revision can.
 */
export const burnExplainer = (): string =>
  `${Number(CONSTANTS.BURN_SHARE_BP) / 100}% of registry revenue is committed to be burned. The figures come from the public log, so anyone can check.`

// ── The era notice (a compressed-tempo era) ────

/**
 * Whether the constants this bundle was built with are a tempo era's. The
 * one fact that separates an era from mainnet in what a person can see is
 * the term: §3 says ~1 y, and every era cuts it to days or hours so a whole
 * lifecycle fits a session. Derived, not configured — a deploy flag that
 * someone has to remember to set is exactly the notice that goes missing
 * on the day it matters (Rico, 2026-09-11: testers must not think they
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

/**
 * The strip's one line. It carried both clocks until 2026-09-13, when the
 * strip moved into the masthead and became chrome a phone keeps on screen:
 * a sentence that wrapped to three rows there cost a fifth of the viewport
 * on every screen. The clocks are a tap away in the hint, which quoted them
 * already — what has to be read without tapping is that none of this is real.
 */
export const eraNoticeLine = (): string => 'Names and prices here are for testing.'

/** Behind the strip's "?": why the clocks are short and what happens to a name at launch. */
export const eraNoticeHint = (blocks: number = CONSTANTS.TERM_LENGTH): string =>
  `This is a test era. Every clock runs short so a name's whole life fits a few days: a term is ${periodApprox(blocks)} instead of a year, ` +
  `a lifetime about ${periodApprox(blocks * CONSTANTS.LIFETIME_TERMS)} instead of ${CONSTANTS.LIFETIME_TERMS} years, and prices are set for testing. ` +
  `Nothing registered here carries over. The registry starts again at launch.`

// ── Before LAUNCH_HEIGHT ─────────────────────────────────────────────────────

/** Blocks still to go before the registry opens; 0 once the head has reached `LAUNCH_HEIGHT`. */
export const blocksToLaunch = (head: number, launch: number = CONSTANTS.LAUNCH_HEIGHT): number =>
  Math.max(0, launch - head)

export const launchTag = (): string => 'Launching'

/**
 * The pre-launch strip's one line. The moment is derived — `LAUNCH_HEIGHT`
 * against the head, at a block a second — and rendered in the reader's own
 * zone, so nobody has to convert a typed "14:00 CET".
 */
export function launchNoticeLine(blocksToGo: number, nowMs: number): string {
  const at = new Date(nowMs + blocksToGo * 1_000)
  const day = at.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
  return `The registry opens ${day}, around ${time}.`
}

/** Behind the strip's "?": why nothing can be registered yet, and why not to try. */
export const launchNoticeHint = (launch: number = CONSTANTS.LAUNCH_HEIGHT): string =>
  `Nimiq Names starts at block ${launch.toLocaleString('en-US')}. Nothing sent before that block is read, ` +
  `so a registration sent early registers nothing. The time shown is an estimate from the chain's height; this notice disappears when the block arrives.`

// ── The landing page (a browser's front door; Pay opens on Buy) ─────────────

/**
 * The landing's first perk. `TERM_LENGTH` rendered as a period, never typed:
 * mainnet's 31,536,000 blocks is "One-year terms", a tempo era's 604,800 is
 * "7-day terms". Blocks ≈ seconds.
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
    // The search field is the door for someone who has a name in mind. These
    // two are the other doors: an owner who wants to configure a name they
    // already hold, and a reader who wants to know what this is before
    // touching it. Nimiq Pay opens on this page, so they are the app's only
    // entry points there that are not a search box (App.tsx).
    openApp: 'My names',
    learn: 'How it works',
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
      { title: 'Messages', body: 'Write to a name’s owner, on chain.' },
    ],
  },
  steps: {
    title: 'How it works',
    items: [
      { title: 'Search & register', body: 'Pick a free name and register it on chain.' },
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
  // One collapsed row (components/PriceTable.tsx, `PriceDisclosure`): the
  // table was a whole section and too much page for a fact a reader wants
  // once (Rico, 2026-09-22).
  prices: { title: 'Prices' },
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
      { title: 'Resources', links: [['Documentation', '#/docs/intro'], ['Developer docs', '#/docs/developers'], ['GitHub', REPO], ['Nimiq', 'https://nimiq.com']] },
      // Telegram is **this project's** group (`CONTACT`, and the masthead's
      // Contact door reads the same list), the other two are Nimiq's. Asked
      // for directly (Rico, 2026-09-16): the reader who wants to reach the
      // people running the registry should not land in the wallet's channel.
      { title: 'Community', links: [['X', 'https://x.com/nimiq'], ['Discord', 'https://discord.gg/nimiq'], ['Telegram', TELEGRAM]] },
    ],
    copyright: (year: number): string => `© ${year} ${SITE_NAME} · MIT`,
  },
} as const

// ── The redesign's chrome (2026-09-09, Bakar's PR #2) ───────────────────────
//
// Headlines, pills, tiles and the trust bars the redesign put on every
// screen, moved here from the components. The copy is Bakar's, edited by
// Rico. The claims are true as design — where a name points is read from
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
  names: 'Manage your on-chain identities, records and sales.',
  pay: 'Send NIM or Polygon USDT to a name, and see where it resolves first.',
  inbox: 'On-chain, wallet-to-wallet messaging. Write to whoever owns a name.',
  market: 'Buy a registered name outright, or bid in a live auction.',
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

/**
 * The rate configured for **this** name, beside the Referrals title (Rico,
 * 2026-09-12: "should be nice to reflect on the panel name, what is the % is
 * configured for you (5% by default but for example binance may see a 20%)").
 * A partner's row is not the default, and the owner is the one person who
 * should see their own — it is the buyer's screen the share stays off.
 *
 * A sentence, not a fragment hung off a separator: it renders as a badge beside
 * the title, and a badge is a thing on its own, so it has to read as one
 * without the heading's help.
 */
export const ownerShareLine = (percent: string): string => `You get ${percent}`

/** The owner's share tile (§10.7): copies `?ref=<name>`; not a transaction. */
export const SHARE_TILE = { title: 'Share Link', hint: 'Earn on registrations you refer' } as const
export const shareCopiedLine = (): string => 'Link copied'
export const shareCopyFailedLine = (link: string): string => `Copy this link: ${link}`
/** A name in grace cannot refer: §10.7 reads the referrer's status at the registration. */
export const shareInGraceLine = (): string => 'A name in grace earns no referral share. Renew it first.'
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
 * `OWNER_TILE.setEvm`, read here so the line cannot drift from the tile.
 */
export const requestNoEvmLine = (): string =>
  `USDT needs an address linked to this name. Use the ${OWNER_TILE.setEvm.title} tile.`
export const copyLinkLabel = (): string => 'Copy link'
/**
  * A name in grace does not resolve (§7.3), so a link to it has nothing to send
  * to. It said "a name in grace can’t be paid", which reads as the name being
  * bought (Rico, 2026-09-14: *"What that 'paid' means? Don't you mean 'sold'?"*).
  * The subject is the payment, not the name.
  */
export const requestInGraceLine = (): string => 'Payments can’t reach a name in grace. Renew it first.'

export const shareHint = (percent: string, rebate: string | null = null, netOfBurn = false): string =>
  `Anyone who registers through your link pays the same price${rebate === null ? '' : ` and gets ${rebate} of it back`}. ` +
  `This name’s address receives ${percent} of the fee, paid by the registry after each registration.` +
  `${netOfBurn ? ` ${rebate === null ? 'That rate is' : 'Both rates are'} before the registry’s burn, which takes a fifth of each.` : ''}`


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
/**
 * The same tile on a name whose pending thing is the tile's own kind (§7.3:
 * the same kind replaces): the title says what pressing it now does, and the
 * hint carries the current value the sheet will prefill.
 */
export const OWNER_TILE_REPLACING = {
  transfer: 'Change Recipient',
  offer: 'Change Price',
} as const
export const transferPendingLine = (to: string, blocksLeft: number): string => `To ${to}, lands in ${blocksApprox(blocksLeft)}`
export const offerActiveLine = (nim: string): string => `Listed at ${nim} NIM`
export const auctionStandingLine = (nim: string): string => `Standing bid: ${nim} NIM`
export const auctionStartingLine = (nim: string): string => `Starting price: ${nim} NIM`
export const connectWalletHint = (): string => 'Connect wallet'

/**
 * A `K` is named by what it will actually clear (`states.cancellable`) —
 * the tile, the sheet's header and its submit button all use this one title.
 *
 * It read **"Cancel Listing / Cancel active auction"** for a pending transfer,
 * which is two false statements: there is no listing, and an auction is the one
 * thing a `K` can never touch (§6 `A` — bids are commitments). Nothing is a
 * real case, not a fallback — an open auction leaves the tile on screen,
 * disabled, showing its gate reason in place of the hint — so it must not name
 * a listing either.
 */
export const cancelTitle = (set: Cancellable): string =>
  set === 'transfer' ? 'Cancel Transfer' : set === 'sale' ? 'Cancel Sale' : 'Cancel Pending'

/** The line under that title. Rendered only where the gate is open, so the
 *  empty set's is the unreachable one. */
export const cancelHint = (
  set: Cancellable,
  subject: { readonly to: string | null; readonly priceNim: string | null; readonly leftBlocks?: number | null },
): string => {
  // How long is left to use it. A cancel window you have to guess at is the
  // one number the tile owes you (Rico, 2026-09-15), and it is short by
  // design — 10 min in a tempo era, 12 h on mainnet.
  const left = subject.leftBlocks == null ? '' : `, ${blocksApprox(subject.leftBlocks)} left`
  if (set === 'transfer') return subject.to === null ? `Stop the pending transfer${left}` : `To ${subject.to}${left}`
  if (set === 'sale') return subject.priceNim === null ? 'Take it off sale' : `Take it off sale (${subject.priceNim} NIM)`
  return 'Nothing to cancel'
}

// Buy's card: a name for sale or under auction hands off to Market.
export const listedForSaleLine = (nim: string): string => `For sale on the marketplace at ${nim} NIM. `
export const listedForBiddingLine = (nim: string): string => `Up for auction on the marketplace, from ${nim} NIM. `
export const checkNowLabel = (): string => 'Check now.'
export const detailsLabel = (): string => 'Details'

// Sheets and buttons shared by every flow.
export const closeLabel = (): string => 'Close'
export const cancelLabel = (): string => 'Cancel'

/**
 * The sheet's header and its submit button — one label, so the thing you tapped
 * and the thing you are about to sign are named identically. A `K` takes its
 * name from the cancellable set; every other action has a fixed one.
 */
export const sheetActionLabel = (action: AppAction, set: Cancellable): string =>
  action === 'cancel'
    ? cancelTitle(set)
    : action === 'transfer' && set === 'transfer'
      ? OWNER_TILE_REPLACING.transfer
      : action === 'offer' && set === 'sale'
        ? OWNER_TILE_REPLACING.offer
        : ACTION_LABEL[action]

/**
 * The sheet's dismiss button. "Cancel" means "never mind" everywhere — except
 * beside a submit button that also says Cancel and means the opposite, which is
 * what the `K` sheet shipped as: *[Cancel what's pending] [Cancel]*.
 */
export const sheetDismissLabel = (action: AppAction): string =>
  action === 'cancel' ? closeLabel() : cancelLabel()
export const clearLabel = (): string => 'Clear'
// The paste button beside a search field (`components/PasteButton.tsx`). A
// refusal names the way out — the field still takes a long-press paste.
export const pasteLabel = (): string => 'Paste'
export const pasteEmptyLine = (): string => 'Nothing on the clipboard.'
export const pasteRefusedLine = (): string => 'This app can’t read the clipboard. Paste into the field instead.'
export const signsWithLabel = (): string => 'Signs with'
export const submittingLabel = (): string => 'Submitting…'
export const confirmingLabel = (): string => 'Confirming…'
export const toLabel = (): string => 'To:'

// Market.
/**
 * A listing's **kind**, beside the name; `buyNowLabel` is the **action**, on
 * the button. The two were both "Buy Now", which printed one phrase twice on
 * every offer card while the auction card beside it read *Live Auction* /
 * *Place Bid* and did not (Rico, 2026-09-16). "For Sale" is the word the rest
 * of the app already uses for a fixed-price listing — `Cancel Sale`, *take it
 * off sale*, *This name is not for sale* — so the pill, the filter tab and
 * every sentence elsewhere now agree.
 */
export const forSaleLabel = (): string => 'For Sale'
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
export const saleLoadFailedLine = (name: string): string => `Couldn’t load details for ${name}. Try again.`
export const marketFilterPlaceholder = (): string => 'Filter by name…'
export const marketFilterAria = (): string => 'Filter names for sale'
export const MARKET_FILTER: Record<'all' | 'offers' | 'auctions', string> = { all: 'All', offers: forSaleLabel(), auctions: 'Auctions' }
export const marketNoMatchTitle = (): string => 'No matching names'
/** `filter` is the active pill's label, or null under "All". */
export const marketNoMatchLine = (query: string, filter: string | null): string =>
  filter === null ? `No names matched “${query}”.` : `No names matched “${query}” under ${filter}.`

// Pay.
export const balanceLabel = (): string => 'Balance:'
export const maxLabel = (nim: string): string => `MAX (${nim} NIM)`
export const resolveLabel = (): string => 'Resolve'
export const payNameAria = (): string => 'Name to pay'
/** Short: the paste button sits in this field, and a long one clips under it. */
export const payNamePlaceholder = (): string => 'name, or a link'
export const payIdleTitle = (): string => 'Pay any NNS name'
export const payNimEmptyBody = (): string => 'Type a name to send NIM to the address it points to.'

/**
 * Copying an address. Shared by the Inbox's thread header and the resolved
 * address on Pay and in a result, which are the two places an address is the
 * object of the screen rather than a word inside a sentence or the label on
 * a control that does something else (2026-09-16).
 *
 * "full" because both copy the whole spaced address whatever the row shows:
 * the Inbox's is ellipsized, and half an address on the clipboard is worse
 * than none. A copy the host refuses says so — the address is on screen, so
 * the recovery is to select it, and a control that silently does nothing is
 * the failure this says out loud.
 */
export const copyAddressLabel = (): string => 'Copy full address'
export const copiedLabel = (): string => 'Copied'
export const copyFailedLine = (): string => 'Select it to copy'

// Inbox.
export const backToInboxLabel = (): string => 'Inbox'
export const backToInboxAria = (): string => 'Back to inbox'
export const yesterdayLabel = (): string => 'Yesterday'

// ── Notifications (tasks/26: an address signs in once) ──────────────────────
//
// The corner panel's row, the sheet it opens, and the `#/probe-sign` page
// used once to pin what Nimiq Pay's `sign()` produces. Every explanation is
// behind a `?`; the visible lines stay short.

export const notifyLabel = (): string => 'Notifications'
export const notifySheetTitle = (): string => 'Notifications'
/** Under the title: which address the sheet is about. */
export const notifySheetIntro = (address: string): string => `For ${address}`
export const notifySignInLabel = (): string => 'Sign in with this address'
export const notifySignInHint = (): string =>
  'Your wallet signs a short text naming this address and this site. Nothing goes on chain and nothing is paid. The signature proves the address is yours, so only you can see and change these settings.'
export const notifySigningLine = (): string => 'Waiting for your wallet…'
export const notifyDeclinedLine = (): string => 'The wallet did not sign.'
export const notifyUnsupportedLine = (): string => 'This wallet cannot sign a message.'
export const notifyMismatchLine = (signer: string): string => `The wallet signed as ${signer}. Pick that address to set up its notifications.`
export const notifyFailedLine = (detail: string): string => `Could not sign in: ${detail}`
export const notifyUnreachableLine = (): string => 'The notification service is not answering.'
export const notifyLoadingLine = (): string => 'Loading…'

export const notifyContactsLabel = (): string => 'Where to reach you'
export const notifyEmailLabel = (): string => 'Email'
export const notifyEmailPlaceholder = (): string => 'you@example.com'
export const notifyEmailAddLabel = (): string => 'Add'
export const notifyEmailSentLine = (): string => 'Check your inbox and open the confirmation link.'
export const notifyEmailBadLine = (): string => 'That is not an email address.'
export const notifyEmailLimitLine = (): string => 'Too many confirmation emails. Try again later.'
export const notifyEmailSendFailedLine = (): string => 'The confirmation email could not be sent. Try again.'
export const notifyConfirmedLabel = (): string => 'Confirmed'
export const notifyPendingLabel = (): string => 'Waiting for confirmation'
export const notifyTelegramLabel = (): string => 'Telegram'
export const notifyTelegramConnectLabel = (): string => 'Connect Telegram'
export const notifyTelegramLinkedLabel = (): string => 'Linked'
export const notifyTelegramOpenLabel = (): string => 'Open Telegram'
export const notifyTelegramOpenLine = (): string => 'Press Start in Telegram and this chat will receive the notifications.'
export const notifyTelegramHint = (): string =>
  'A bot can only write to a chat you started. The link opens the bot with a code that ties the chat to this address. No username is typed or stored. Send /stop to the bot to unlink.'
export const notifyNoChannelsLine = (): string => 'No email or Telegram is set up on this service yet.'
export const notifyRemoveLabel = (): string => 'Remove'

export const notifyEventsLabel = (): string => 'Send me'
export const NOTIFY_CATEGORY_LABEL: Record<'renewal' | 'market' | 'transfer' | 'chat', string> = {
  renewal: 'Renewal reminders',
  market: 'Sales and bids',
  transfer: 'Transfers to me',
  chat: 'New messages',
}
export const NOTIFY_CATEGORY_HINT: Record<'renewal' | 'market' | 'transfer' | 'chat', string> = {
  renewal: 'When a name can be renewed, when it stops resolving, and a last call before anyone can register it.',
  market: 'A name of yours was bought, someone bid on your auction, you were outbid, or an auction you were in closed.',
  transfer: 'Someone started a transfer of a name to this address, and when it completes.',
  chat: 'Someone sent this address a message. Who wrote is named, the text is not.',
}

export const notifyDeleteLabel = (): string => 'Delete everything about this address'
export const notifyDeleteConfirmLabel = (): string => 'Yes, delete'
export const notifyDeleteHint = (): string =>
  'Removes every contact, every setting and the record of what was sent for this address. Nothing about you stays on the service.'
export const notifySignOutLabel = (): string => 'Sign out'
export const notifyDataHint = (): string =>
  'The service keeps this address, the contacts you add here and which messages it already sent. Every message carries a one-click unsubscribe.'

// The probe page (tasks/26 D0).
export const probeTitle = (): string => 'Signing probe'
export const probeIntro = (): string => 'Signs a fixed text with the wallet and checks the signature locally. Nothing is sent anywhere.'
export const probeSignLabel = (): string => 'Sign the test text'
export const probeNoWalletLine = (): string => 'Connect a wallet first.'
export const probeVerifiedLine = (convention: string, address: string): string => `Verified under the ${convention} convention. Signer: ${address}`
export const probeUnverifiedLine = (): string => 'The signature verifies under neither convention.'
export const probeCopyLabel = (): string => 'Copy result'
