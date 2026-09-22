# NNS — Nimiq Name Service

**Protocol specification, v1 draft — revision 31**

> **Working draft, circulated for review.** Nothing here is frozen — the
> wire format in §5 and §6 in particular is still open pending the encoding
> test in §12. Holes, objections, and "this will age badly against our
> roadmap" are the most useful responses this document can get.

A name registry for Nimiq with no smart contracts. Registrations are carried in
transaction data; a deterministic indexer replays them into a `name → address`
mapping; a Nimiq Pay mini app lets users send to `rico` instead of an address.

> **Review status.** Everything marked **OPEN** is undecided or unverified.
> Everything else reflects decisions already taken.

> **Revisions are per week, not per change.** Everything decided within the
> same week is folded into that week's open revision, however many separate
> changes it covers and however many days apart they fall, so a revision number
> stays something an implementation can claim to implement rather than a
> changelog id. A change that touches a section an open revision already
> touches goes into that revision's note — it does not open a new one.

> **This document states only the current rules.** Per-revision change notes
> are kept out of line and never override a section's text: where a revision
> moved bytes, the section that moved says so.

## Contents

**[1. Design principles](#1-design-principles)**

**[2. Threat model](#2-threat-model)**

- [2.1 What the guarantee actually is](#21-what-the-guarantee-actually-is)
- [2.2 Client delivery — the limit of every client-side rule](#22-client-delivery--the-limit-of-every-client-side-rule)

**[3. Constants](#3-constants)**

**[4. Name rules](#4-name-rules)**

- [4.1 Validity](#41-validity)
- [4.2 Positional digit rule](#42-positional-digit-rule)
- [4.3 Rendering (SHOULD)](#43-rendering-should)
- [4.4 Dotted queries](#44-dotted-queries)

**[5. Transaction encoding](#5-transaction-encoding)**

- [5.1 Budget and encoding](#51-budget-and-encoding)
- [5.2 Layout](#52-layout)
- [5.3 Routing](#53-routing)
- [5.4 Value](#54-value)

**[6. Message types](#6-message-types)**

- [6.1 Registration is a single transaction](#61-registration-is-a-single-transaction)
- [6.2 Front-running: accepted, and why](#62-front-running-accepted-and-why)
- Message types — referenced by letter (`§6` + the letter), never by number,
  so inserting a type never renumbers the others:
  [`G` Register](#g--register) · [`S` Set resolution target](#s--set-resolution-target) · [`X` Transfer ownership](#x--transfer-ownership) · [`D` Set delegate resolver](#d--set-delegate-resolver) · [`K` Cancel](#k--cancel) · [`N` Renew](#n--renew) · [`O` Offer](#o--offer) · [`B` Buy](#b--buy) · [`A` Auction](#a--auction) · [`M` Settlement](#m--settlement) · [`P` Governance](#p--governance) · [`U` Unreserve](#u--unreserve) · [`F` Burn attestation](#f--burn-attestation)

**[7. Indexer rules](#7-indexer-rules)**

- [7.1 Scanning — one code path, no address index](#71-scanning--one-code-path-no-address-index)
- [7.2 Replay](#72-replay)
- [7.3 Name state machine](#73-name-state-machine)
- [7.4 Rejection: forfeit versus refund](#74-rejection-forfeit-versus-refund)
- [7.5 Transactions the indexer must ignore](#75-transactions-the-indexer-must-ignore)
- [7.6 What earns a log line](#76-what-earns-a-log-line)

**[8. State, log, and verification](#8-state-log-and-verification)**

- [8.1 Merkle tree](#81-merkle-tree)
- [8.2 The NNS log](#82-the-nns-log)
- [8.3 Proof format](#83-proof-format)
- [8.4 Tiered verification](#84-tiered-verification)
- [8.5 Client verification](#85-client-verification)
- [8.6 Delegated resolution](#86-delegated-resolution)
- [8.7 What gates usability, and what does not](#87-what-gates-usability-and-what-does-not)
- [8.8 Segments and snapshots](#88-segments-and-snapshots)

**[9. EVM anchoring](#9-evm-anchoring)**

**[10. Economics](#10-economics)**

- [10.1 Pricing — one base fee, fixed multipliers](#101-pricing--one-base-fee-fixed-multipliers)
- [10.2 Where fees go, and the burn share](#102-where-fees-go-and-the-burn-share)
- [10.3 Revenue lines beyond registration](#103-revenue-lines-beyond-registration)
- [10.4 Term length](#104-term-length)
- [10.5 Payment exactness](#105-payment-exactness)
- [10.6 Governance](#106-governance)
- [10.7 Ecosystem payouts — deliberately not protocol rules](#107-ecosystem-payouts--deliberately-not-protocol-rules)

**[11. Node and operational requirements](#11-node-and-operational-requirements)**

- [11.1 What the indexer needs](#111-what-the-indexer-needs)
- [11.2 Do not co-locate with a validator](#112-do-not-co-locate-with-a-validator)
- [11.3 Start the history sync early](#113-start-the-history-sync-early)
- [11.4 Public fallback](#114-public-fallback)
- [11.5 Sending addresses MUST be balance-checked and alerted on](#115-sending-addresses-must-be-balance-checked-and-alerted-on)

**[12. Open questions](#12-open-questions)**

**[13. Build order](#13-build-order)**

**[14. Deliverables](#14-deliverables)**

**[15. Positioning](#15-positioning)**

**[16. Deferred to v2](#16-deferred-to-v2)**

- [16.1 Name reveal (anti-MEV registration)](#161-name-reveal-anti-mev-registration)
- [16.2 Pricing signalling messages](#162-pricing-signalling-messages)
- [16.3 Rate limiting and backoff](#163-rate-limiting-and-backoff)
- [16.4 Log compaction](#164-log-compaction)
- [16.5 Signed delegate responses](#165-signed-delegate-responses)
- [16.6 Richer records](#166-richer-records)

---

## 1. Design principles

1. **The chain provides ordering, not enforcement.** Nimiq has four account
   types — Basic, Vesting, HTLC, and the single Staking contract. There is no
   general smart contract layer, so no consensus rule can enforce name
   ownership. NNS is a deterministic interpretation of transaction history,
   in the same family as Ordinals and BRC-20 on Bitcoin.
2. **Determinism over authority.** Any two correct implementations replaying
   the same history MUST produce byte-identical state roots. Every parameter
   that can change lives on-chain, never in an operator's config.
3. **Verifiable, not trusted.** Clients verify Merkle proofs against publicly
   anchored roots rather than trusting an API response.
4. **Verification must be cheap enough that people actually do it.** This is
   why registration has a price floor at all: the log is the verification
   artifact, and an artifact nobody can afford to download is not a guarantee.
5. **Fail closed, with evidence.** Any malformed, ambiguous, or unaffordable
   message is rejected with a logged verdict (§7.4, §8.2): it changes nothing
   in the registry, and the log shows why. "Ignored" — no log line at all —
   is reserved for what §7.5 discards before parsing.
6. **The protocol is not the police.** Where a rule would block many
   legitimate names to catch a rare abuse, it belongs in the interface layer.
7. **Simplicity is a security property.** Every message type is a surface for
   divergence between implementations.
8. **Delegate rather than store.** Where a use case needs unbounded names,
   push the state to whoever benefits from it (§8.6) instead of absorbing it
   into consensus.

---

## 2. Threat model

| Threat | Mitigation | Residual risk |
|---|---|---|
| Indexer operator rewrites the mapping | Merkle inclusion proofs verified client-side; roots anchored on an EVM chain (§9) | A name newer than the last anchor is trusted until the next checkpoint |
| **Operator forges a whole state and anchors it** | Not stopped by proofs — a sole publisher's lie is internally consistent. Defeated by independent replay (Tier 3), client quorum (§8.5), and multi-publisher anchoring (§9) | Users of a single resolver with a single anchor publisher are exposed; see §2.1 |
| Operator refuses to answer for a name (API censorship) | Detectable — the entry is in the published log and any independent resolver answers it | Not preventable; users must switch resolver endpoints |
| Log-growth spam | **Not mitigated in v1** — only registration is priced (§7.6). Mechanisms designed and deferred (§16.2, §16.3) | Spam scales with names owned (~$200 of names sustains ~6.5 GB/year); visible in the log, and answerable by raising `FEE_BASE` within a week (§10.6) |
| **Operator serves a malicious frontend** | Not mitigated by any protocol mechanism — see §2.2. Bounded by wallet-native resolution and by third-party apps shipping their own clients | Users of the operator's own mini app are fully exposed while it is served |
| Operator serves a different root per victim | Roots fetched from a public RPC, not from the NNS API | None, if the client checks the anchor |
| Anchor publisher key compromise | Tier 1/3 replay detects divergence; clients alarm and halt on anchor/replay mismatch (§8.5) | Disputed state until a correct root is anchored from a rotated key |
| Operator fabricates entries | Published NNS log; entries spot-checkable by transaction hash | None |
| Operator omits entries (censorship) | Independent full replay by any history-node operator (Tier 3, §8.4) | Requires at least one honest independent operator |
| **State-bloat denial of service** | Non-zero fee in every band (§10.1) | Bounded by cost: ~$0.20 per junk name |
| Registration front-running | Accepted, not mitigated — see §6.2 | A mempool observer or block producer can take a name from a user |
| Seller cancels against an incoming `B` | Buyer's payment sits at `MARKETPLACE_ADDRESS` and is refunded via `M` (§6) | Nuisance only — the buyer waits for a refund instead of losing funds |
| Two buyers pay for one offer | First in canonical order wins; the loser is refunded via `M` | Refund depends on the marketplace operator — custodial, but auditable |
| Marketplace operator defaults or is compromised | Ownership never depends on the operator; owed vs. settled is computable from the log and publicly visible (§6 `M`) | In-flight settlement funds (bounded by open offers) can be lost; sellers of just-consumed offers are the most exposed |
| Bulk land-grab at launch | Thorough `RESERVED_NAMES`; the fee | Squatting of unreserved names remains possible |
| **Malicious or compromised delegate resolver** | Not covered by proofs — clients MUST label delegated results differently (§8.5) | A parent can misdirect its own subdomains; scope limited to that parent |
| Confusable names (digit/letter) | Digits barred between letters, and `0`/`1` barred at either end — the boundary clause adopted in r6 (§4.2) | Accepted residual: confusions needing neither an interior digit nor a leading/trailing `0`/`1` |
| Confusable names (multigraph) | Rendering (§4.3), identicons, first-use pinning (§8.5) | Accepted residual |
| Admin key compromise | **A fork, with `GOVERNANCE_DELAY`'s ~24 h of public notice in front of a `P`.** A `P` is on-chain before it bites; the price rails (`PRICE_FLOOR`/`PRICE_CEILING`) are fat-finger protection, not a defence, and there are no rate limits (§10.6). A `U` has no notice since r22 and takes effect on landing, and since 2026-09-11 awards any name without an owner — never one with | Visible, and reversible only by coordination: `ADMIN_ADDRESS` is a §3 constant, so a stolen key is routed around by a spec revision, not rotated. Within a day it can reprice the registry anywhere inside the rails; it can give away ownerless names one public `U` at a time, immediately, which is a day earlier than before r22 and against a remedy that took days either way |
| **Owner key compromise** | **None. A lost or stolen owner key is a lost name**, as in ENS | Total and immediate: `O` + `B` moves the name in two blocks (§6 `B`), so not even the `X` timelock delays a thief who reads this document. v1 removed the recovery address rather than advertise a defence the owner key itself defeats (r20) |
| Mistyped `XFER` recipient | `XFER_TIMELOCK` with owner veto via `K` — this, and not key compromise, is what the timelock is for | Permanent if unnoticed within `XFER_TIMELOCK` |
| Chain reorganisation | State advances only on macro-block-finalised batches | None |
| Operator disappears | MIT indexer, one-command run, log published to IPFS and addressed from the anchor (§8.2, §9) | Users must switch resolver endpoints; the log survives only while somebody pins it |

**Not claimed:** NNS is not a rollup and Nimiq is not an L2 of Ethereum.
Anchoring provides attestation, not adjudication. It binds the operator to
past claims; it does not let Ethereum reconstruct or arbitrate NNS state.

### 2.1 What the guarantee actually is

Stated plainly, because it is easy to overclaim and a reviewer will test it:

**Proofs and anchoring alone do not stop a dishonest operator.** An operator
who is both the state producer and the sole anchor publisher can build a
false state, build a tree over it, anchor that root, and serve proofs that
verify against it. Every check in §8.5 passes. What those mechanisms buy is
narrower and still worth having: the operator cannot tell different stories
to different users (one root, publicly anchored), and cannot rewrite a past
claim (the anchor is timestamped and non-repudiable).

**Three things defeat the forgery:**

1. **Independent replay (Tier 3, §8.4).** Transaction history lives on
   Nimiq, not with the operator. Anyone applying the published rules to the
   same history derives the true root; a divergence from the operator's root
   is *proof* of deviation, and diffing the two logs identifies the exact
   transaction mishandled.
2. **Client quorum (§8.5).** Detection by a third party does not help a user
   mid-transaction unless the client checks more than one source. Querying
   independent resolvers and failing on disagreement is what converts a
   community-level guarantee into a per-user one.
3. **Multi-publisher anchoring (§9).** Matching roots from *independent*
   publishers are the trust signal. A single publisher's anchor only proves
   they said it.

**The property that makes the attack pointless** is that correct state is
recomputable from the chain **without the operator's cooperation**. If the
operator steals the namespace, the community re-derives correct state,
publishes it, and clients point elsewhere; the stolen names are honoured
only by a resolver nobody uses. Contrast a custodial registry, where the
data exists nowhere else and theft is final.

So the guarantee is *the registry can be reconstituted without the
operator*, not *the operator cannot cheat*. Everything in §8 and §9 exists
to make the first statement cheap enough to be true in practice.

**Outside the guarantee entirely:** API-level censorship (detectable, not
preventable), the marketplace hot wallet (auditable, not trustless, §6 `B`),
and delegate resolver answers (§8.6, by design).

### 2.2 Client delivery — the limit of every client-side rule

Every requirement in §8.5 — verify the proof, meet the resolver quorum, pin
on first use — is a promise about code that the operator serves at page
load. A mini app is JavaScript fetched from a domain, so **the party being
checked also delivers the checker.** An operator can serve an honest bundle
to everyone and a hostile one to a single device; nothing on-chain records
it, and no bundle hash helps, because whatever would verify the hash was
served by the same party.

Scope of the attack:

- **It can** display any address for any name, so a user sends funds to the
  operator. That is sufficient.
- **It cannot** forge registry state, take ownership of names, or hide
  afterwards: the recipient address is on-chain and contradicts the
  registry, so the theft is provable after the fact. This makes it a
  one-shot reputational suicide rather than a sustainable position — but it
  is no comfort to the victim.

Mitigations, strongest first:

1. **Wallet-native resolution.** If resolution runs inside Nimiq Pay itself
   — signed, store-distributed, reviewed — the client is not the
   operator's to swap. This is the only mitigation that closes the hole
   rather than narrowing it, and it is the strongest reason for the project
   to become part of Nimiq rather than an app beside it. **To be explicit:
   this is a strengthening, not a requirement.** The protocol, the indexer,
   the verification model in §8, and the mini app all stand on their own —
   independent replay and resolver quorum defend the state layer with or
   without wallet involvement. What wallet-native resolution removes is a
   residual risk in the *delivery* layer that the mitigations below narrow
   but cannot close.
2. **The resolver package in third-party apps (§14).** Other mini apps ship
   their own bundles from their own domains, so their users are outside the
   operator's reach entirely. Wide adoption of the package is therefore a
   security property, not only a distribution strategy.
3. **Independent deployments.** The frontend is MIT; anyone may host it, and
   users who prefer not to trust the operator's domain can use another.

(A fourth — content-hash pinning of the build by the mini-app framework —
was listed through 2026-08-29 and dropped without being asked: hard to
implement, questionable result, and nobody would deploy it.)

This is the ordinary trust boundary of every web frontend in the ecosystem,
but it deserves stating here because NNS is a system whose entire product is
a mapping the user is being asked to trust.

---

## 3. Constants

Blocks are ~1 s; 60 blocks = 1 batch ≈ 1 min; 43,200 blocks = 1 epoch ≈ 12 h.
NIM figures assume ~$0.00032/NIM, the rate at the launch freeze (2026-09-22).

| Constant | Proposed value | Notes |
|---|---|---|
| `PROTOCOL_ID` | `NNS1` | 4 ASCII bytes, prefix of every message |
| `LAUNCH_HEIGHT` | 62,275,680 | Indexers start here, not at genesis |
| `TREASURY_ADDRESS` | `NQ39 M3TJ 2NC1 G4PJ 07JF BFKG Q3X6 AK7K J7YT` | Receives fees — and only fees |
| `PROTOCOL_ADDRESS` | `NQ91 SQRC L91X D5QK 6A21 1UV7 11EY 7YA3 BBRT` | Receives dust-only signalling messages and acts as the §5.3 sentinel; key held cold, never in a node |
| `REFUND_FLOOR` | 1 NIM (100,000 luna) | Below this, a refundable amount is forfeited instead (§7.4). 10,000 luna through r28 |
| `ANCHOR_STALENESS_LIMIT` | 48 h | Client warns beyond this (§8.5). One missed daily-floor anchor of margin (§9) |
| `SEGMENT_LENGTH` | 31,536,000 blocks (~1 y) | Log segment boundary (§8.8). Read 3,153,600 — a tenth of its own label — through r28; nothing derives from it yet |
| `AUCTION_MIN_INCREMENT` | 5% | Minimum raise over the standing bid (§6 `A`) |
| `MIN_PRICE` | `FEE_BASE` | Floor on an `O` price and an `A` starting price (§6) — the cheapest a name can be registered |
| `AUCTION_MIN_DURATION` | 86,400 blocks (~24 h) | Shortest permitted auction (§6 `A`) |
| `AUCTION_MAX_DURATION` | 604,800 blocks (~7 d) | Longest permitted auction (§6 `A`), measured like the shortest. r31 fold, 2026-09-22 |
| `AUCTION_EXTENSION` | 600 blocks (~10 min) | Anti-sniping extension (§6 `A`) |
| `ADMIN_ADDRESS` | `NQ95 0MNS X5BJ 3SMV XA2E 7059 BU9F AXX6 J4MX` | Governance only; cold key, distinct from treasury |
| `MARKETPLACE_ADDRESS` | `NQ55 SY33 7HS4 DP5N H9P0 9PMG 7MD8 PTL8 N2P5` | `B` escrow and `M` settlement; the only NNS hot wallet, distinct from both |
| `BURN_ADDRESS` | `NQ07 0000 0000 0000 0000 0000 0000 0000 0000` | Canonical Nimiq burn address |
| `RESERVED_NAMES` | Published list + by rule (§4.1) | The published half is in the reference implementation's constants; **still incomplete** — additions are free until `LAUNCH_HEIGHT` and out of scope afterwards (§10.6) |
| `LISTING_FEE` | 0 | Value owed on an `O` (§6 `O`). Not governable: no `P` field carries it (§10.6, §12 item 3) |
| `MIN_NAME_LEN` | 5 chars | 1–4 reserved by rule (§4.1) for later award or auction; the floor binds only while a name is reserved |
| `MAX_NAME_LEN` | 24 chars | Longer than any handle people actually use; keeps messages well inside 64 bytes |
| `MAX_LABEL_LEN` | 24 chars | Subdomain label (§4.4) |
| `MAX_HOST_LEN` | 30 chars | Delegate resolver host (§6 `D`); `resolver.binance.com` is 20 |
| `MAX_REF_LEN` | 24 chars | Referrer on a registration (§6 `G`) — a registered name, so it equals `MAX_NAME_LEN` |
| `FEE_BASE` | 625 NIM (~$0.20) | The 12+ band's yearly fee and the base every other band is a multiple of (§10.1); **the one governable price** |
| `FEE_MULTIPLIERS` | 1–2 → 200×, 3 → 100×, 4 → 50×, 5 → 25×, 6 → 10×, 7–11 → 5×, 12+ → 1× | Yearly fee by name length, as multiples of `FEE_BASE` (§10.1). Frozen: a spec revision, never a `P`. 1–4 binds once a name is released, awarded or auctioned (§4.1) |
| `LIFETIME_MULTIPLIER` | 10 | A lifetime term costs this many yearly fees of its band (§10.4) |
| `LIFETIME_TERMS` | 100 | A lifetime term is this many `TERM_LENGTH`s — a plain expiry ~100 y out, not a sentinel (§10.4) |
| `BURN_SHARE` | 20% | Of all revenue received, forwarded to `BURN_ADDRESS` |
| `COMMISSION_RATE` | 250 bp (2.5%) | Marketplace cut on a settled sale; governable |
| `COMMISSION_CEILING` | 1,000 bp (10%) | Governance hard upper bound |
| `COMMISSION_MAX_STEP` | 250 bp | Maximum change per adjustment |
| `PRICE_FLOOR` | 1 NIM | Governance hard lower bound on `FEE_BASE` — chosen so a long name stays ≤ ~$1 even at $1/NIM. A fat-finger rail, not attack protection (§10.6) |
| `PRICE_CEILING` | 100,000 NIM | Governance hard upper bound on `FEE_BASE`; every band scales with it |
| `GOVERNANCE_DELAY` | 86,400 blocks (~24 h) | Minimum notice before a `P` bites — and, since the rate limits were removed, the whole of what bounds a hostile one (§10.6). **`P` only:** r22 took `U` out of it, because a release announced a day ahead arms a frontrunner and an award has nobody to warn (§6 `U`) |
| `XFER_TIMELOCK` | 43,200 blocks (~12 h) | Window in which the owner can cancel their own pending `X` with a `K` (§6). Guards a mistyped recipient, not a thief (§2) |
| `TERM_LENGTH` | 31,536,000 blocks (~1 y) | See §10.4. A *length*: the term is `[registration, registration + TERM_LENGTH)` and the name is in `GRACE` at `expiry` (§7.3) |
| `GRACE_PERIOD` | 2,592,000 blocks (~30 d) | Resolution off, renewal still allowed. Also a length: `[expiry, expiry + GRACE_PERIOD)`, `AVAILABLE` at the end (§7.3) |
| `OFFER_MAX_LIFETIME` | 1,296,000 blocks (~15 d) | Then auto-expires |
| `CHECKPOINT_INTERVAL` | 720 blocks (~12 min) | Root recomputed and published |
| `RESOLVER_QUORUM` | 2 | Independent resolvers a client must agree before acting (§8.5) |
| `ANCHOR_QUORUM` | 2 | Independent publishers whose roots must match (§9) |
| `DUST_VALUE` | 1 luna | Value for non-fee-bearing messages (§5.4) |
| `FINALITY_RULE` | last finalised macro block | State never advances past it |

---

## 4. Name rules

### 4.1 Validity

A candidate name is **valid** if and only if all hold:

1. Length between `MIN_NAME_LEN` and `MAX_NAME_LEN` inclusive. **The floor
   binds only while a name is reserved:** a 1–4 character name satisfying
   rules 2–5 is a member of `RESERVED_NAMES` by rule (below), so while it is
   held it fails rule 6, not rule 1 — and once a fired `U` (§6 `U`) removes
   it from the reserved set, the floor no longer applies and it is a normal
   name. The ceiling is unconditional.
2. Characters drawn only from `a-z`, `0-9`, and `-` (ASCII, lowercase).
3. Contains at least one letter.
4. Does not begin or end with `-`, and contains no two consecutive `-`.
5. Satisfies the positional digit rule (§4.2).
6. Not currently in `RESERVED_NAMES` — on neither membership route below,
   or already removed by a fired `U`.

`.` is **not** a valid character in a registered name. Dots appear only in
queries, as resolution syntax (§4.4).

**Why `-` and not `_`.** Most social platforms use the underscore, so the
choice deserves a reason. An underscore **disappears under an underline**,
and names will be rendered as links in wallets and explorers — `self_crypto`
underlined reads as `self crypto` or `selfcrypto`, which is exactly the
confusion class §4.2 exists to remove. Hyphens are also legal in DNS labels
where underscores are not, so a name can bridge into a hostname later;
resolution syntax is already dotted (§4.4). Rules 2 and 4 above are, arrived
at independently, GitHub's username rules. Allowing **both** separators would
be the worst option: `my-name` and `my_name` would be a manufactured
collision pair.

**On length.** `MAX_NAME_LEN` is 24. Every naming system built for humans
lands between 15 and 39 — X 15, Farcaster 16, Instagram 30, Telegram 32,
GitHub 39 — and the outlier, ENS, is unbounded only because it hashes labels
rather than storing them, which is also where its homoglyph problems live.
Past roughly 20 characters a name stops being recognisable at a glance, and
recognition is the entire product: `rico` instead of an address.

Implementations MUST reject rather than normalise. Uppercase input is not
lowercased — it is invalid.

`RESERVED_NAMES` has two membership routes, checked in this order or any
other — they are disjoint:

- **By list:** a versioned list published in the repo, covering `nimiq`,
  Nimiq's own products, major exchanges, wallets, and obvious brand terms.
  It is a **constant**, not a deployment setting — two indexers running
  different lists derive different roots and neither is detectably wrong at
  startup. It is also **not yet complete**: adding an entry is free until
  `LAUNCH_HEIGHT` and out of governance scope afterwards (§10.6), and the
  asymmetry below says which way to err.
- **By rule:** every name of length 1–4 satisfying rules 2–5. Membership is
  checked exactly that way — measure the length, run rules 2–5 — never by
  materialising the ~1.7 million short names into the published list. A
  short name failing rules 2–5 is on neither route: it is plain invalid and
  can never be released.

Short names are **reserved, not invalid** — held back for later release,
award (§6 `U`) or auction (§6 `A`), not lost. A `U` moves one out of the
reserved set exactly as it moves `binance` out, and from that point it is a
normal name. A `U` can also award a name that was never reserved (§6 `U`);
that touches the reserved set not at all.

> **This list is the primary defence against a launch land-grab** and deserves
> an afternoon of real work rather than a token twenty entries. With
> single-transaction registration, an empty namespace is trivially scriptable
> on day one.
>
> **Err long, never short.** A name left off is registrable by anyone the block
> after `LAUNCH_HEIGHT`, and no rule takes it back once it has an owner (§10.6)
> — under-reserving is **permanent**. A name reserved by mistake is released,
> or awarded to the right party, with one `U` (§6 `U`) — over-reserving is
> **reversible**, and costs one announced governance message.

### 4.2 Positional digit rule

**Digits may appear only at the start or the end of a name, never between
letters.** Formally: strip any leading run of digits and any trailing run of
digits; the remainder MUST contain no digits.

| Valid | Invalid |
|---|---|
| `layer`, `web3`, `2fa`, `bitcoin7`, `21rico` | `n1m1q`, `nimiq0pay`, `g00gle`, `b1tc0in`, `1ayer`, `sud0` |

*(`web3` and `2fa` illustrate the digit rule only — at 1–4 characters they
are reserved by rule (§4.1) and registrable only after a `U` releases them.
Do not turn them into acceptance tests.)*

Lowercase-only already removes `I`/`l` and `O`/`0` at the capital end. This
rule removes the rest of the realistic surface, because impersonating a name
requires substituting a character *inside* it. One clause, no lookup table.

Deliberately **not** addressed: multigraph confusions (`rn`/`m`, `cl`/`d`,
`vv`/`w`). Blocking those rejects ordinary words — `corner` and `comer`,
`barn` and `bam`. Handled at the interface layer (§4.3, §8.5).

**Boundary clause — adopted in r6.** Additionally, **`0` and `1` may not be
the first or last character** of a name. This closes the boundary collisions
(`nimiq0`/`nimiqo`, `1rico`/`lrico`) while preserving `web3`, `x2`, `2fa`,
`bitcoin7`. Desirable names do not begin or end in `0` or `1`, so the
casualty list is effectively empty.

### 4.3 Rendering (SHOULD)

Integrators SHOULD render names in a typeface that separates `0`/`o`, `1`/`l`,
and `rn`/`m`. The reference resolver package ships the required CSS so
adopting apps inherit correct rendering.

Recommended: Inter with `font-feature-settings: "ss02", "zero"`; or a
monospace face for the name field alone — JetBrains Mono and IBM Plex Mono
provide these by default.

Integrators SHOULD also display the **Nimiq identicon** of the resolved
address alongside the name.

### 4.4 Dotted queries

A dot is **resolution syntax, not a registrable character**. `a.b` means *ask
b's delegate resolver about a*.

A query is a **dotted query** if it contains exactly one `.`. It splits into
`label` and `parent`:

- `parent` MUST be a currently `REGISTERED` name with a delegate host set (§6 `D`)
- `label` MUST be 1…`MAX_LABEL_LEN` characters from `a-z`, `0-9`, `-`, not
  beginning or ending with `-`, with no consecutive `-`
- The positional digit rule does **not** apply to labels — they are not
  scarce, not sold, and not confusable with registered names because the
  parent disambiguates them
- More than one `.` is invalid in v1. Nested delegation may come in v2

Labels are never protocol state. NNS stores nothing about them, the log never
grows from them, and the Merkle tree never contains them.

---

## 5. Transaction encoding

### 5.1 Budget and encoding

Basic Nimiq transactions cap `recipient_data` at **64 bytes**
(`MAX_BASIC_TX_RECIPIENT_DATA_SIZE`). Every message must fit.

**Verified empirically** (mainnet, 2026-08-06): a 64-byte payload was
included in a block; 65-byte and 128-byte payloads were accepted by the RPC,
returned transaction hashes, and were then **silently dropped** — they never
appeared in any block. Note that the node will construct a 256-byte
transaction locally without complaint, so local construction proves nothing
about network acceptance. The limit is a **byte** budget, not a character
count: the Nimiq wallet accepts 64 ASCII characters or 32 two-byte
characters, and both are 64 bytes.

**Encoding.** The field holds raw bytes. Over JSON-RPC they are represented
as **lowercase hex in both directions** — a transaction carrying
`NNS1Gtestname` is sent as `4e4e533147746573746e616d65` and read back
identically. The RPC field names are `recipientData` and `senderData`, not
`data`. Wallets take plain text and encode it themselves; NNS clients using
the RPC directly must hex-encode. Non-ASCII UTF-8 round-trips byte-identically,
though §4.1 restricts names to ASCII regardless.

### 5.2 Layout

```
NNS1 <type> <payload>
```

- Bytes 0–3: `NNS1`
- Byte 4: one uppercase type character
- Bytes 5+: type-specific payload, `|`-delimited where multi-field

**The `NNS1` prefix is the boundary between ignored and rejected.** Data not
starting with `NNS1` is not a message: §7.5 discards it before parsing and it
earns no log line. A payload that carries the prefix but has an unknown type
character, or exceeds 64 bytes, is **rejected with a logged verdict**
(`UNKNOWN_TYPE`, `OVER_LENGTH` — §7.4): it has no effect on the registry, but
its line enters the log and therefore the §8.2 hash. In this document
"ignored" means §7.5's discards — invisible to the log — and nothing prefixed
`NNS1` is ever ignored. Through r22 this paragraph called all three cases
"ignored", which read as no-log-line for two messages §7.4 logs: opposite
facts to the log hash, and a silent fork that was *reachable* for the
unknown-type case — any dust transaction carrying `NNS1` and a spare letter
lands on mainnet today, and the retired `R` is such a letter since r20.

All fields use text-safe encoding (ASCII plus base64url); raw binary is never
used, so a message is human-readable in a block explorer.

**Numeric fields are canonical decimal:** a plain integer with no sign, no
leading zeros, no whitespace, never empty. `0123` as a height or price makes
the message `MALFORMED_PAYLOAD`. Exactly one representation per value is the
only reading under which two encodings of the same message are impossible —
anything looser lets implementations accept different message sets and
diverge.

**Canonical order** is `(block_number ascending, transaction hash ascending,
bytewise)`, and `tx_index` — the second coordinate of the `(height,
tx_index)` identity used throughout §6 and §8 — is a transaction's
zero-based **rank** in that order within its block. The rank's universe is
pinned exactly: every transaction in the block whose `recipientData` begins
with `NNS1`, taken **before** any §7.5 discard — a failed or wrong-network
message still occupies its rank, and everything unprefixed is invisible to
the count. This is the only set every implementation can derive from the
batch response alone; ranking over §7.5 survivors instead would couple
`tx_index` to the discard rules and invite drift. Hashes compare bytewise —
on lowercase hex that is plain lexicographic order.

The hash is on every object `getTransactionsByBatchNumber` returns, so the
order requires no further call. Through r26 the second coordinate was the
position in the block body array — an index the RPC transaction object does
not carry (verified 2026-08-06 against the full object), which forced one
`getBlockByNumber(h, true)` call per NNS-bearing block and required the node
to retain bodies across the scan range. The tiebreak's only real requirement
is that it be deterministic and identical across implementations; the hash
provides that from the batch response alone.

Stated plainly: a same-block sender can grind a transaction with a low hash
to sort ahead of a competitor without out-bidding fees. This is accepted
deliberately — §6.2 accepts front-running wholesale, and body position never
protected against it either: the validator orders the body freely.

### 5.3 Routing

| To `TREASURY_ADDRESS` or `PROTOCOL_ADDRESS` | To the counterparty | To `BURN_ADDRESS` |
|---|---|---|
| `G` register, `N` renew, `K` cancel, `O` offer, `D` delegate, `E` EVM address, `A` auction, `P` governance, `U` unreserve *releasing* a name | `S` set, `X` transfer, `U` unreserve *awarding* a name | `F` burn attestation |

**`U` is the only type whose recipient chooses what it does.** For every other
type the recipient is a route: it says where the message belongs and is checked
against that one answer. A `U` to `PROTOCOL_ADDRESS` releases the name; a `U`
to anything else awards the name to that address (§6 `U`). The recipient is
therefore an operand, and §7.4 checks it as one — `U` has no `WRONG_RECIPIENT`
row. The single address it may not name is `BURN_ADDRESS`.

**Sender and recipient must differ.** Nimiq rejects self-transactions, and it
does so *silently*: the RPC accepts the transaction, returns a hash, and the
network then drops it — no error is surfaced anywhere. Every message type
must therefore have a recipient that cannot be the sender. One operation
would otherwise be unsendable, and it uses `PROTOCOL_ADDRESS` as a sentinel
recipient: `S` resetting a name's target to the owner's own address (§6).
Through r19 there was a second — `R` clearing the recovery address — which
went with `R` itself.

The same rule bounds the `U` award for free: a `U` is signed by
`ADMIN_ADDRESS`, so an award *to* `ADMIN_ADDRESS` is a self-transaction and can
never be mined. A compromised admin key cannot move a reserved name into the
address it already controls; it has to name some other address, in public. That
is the whole of the bound since r22 removed the notice — the publicity, not the
delay in front of it (§6 `U`).

**Three routes to a silent drop, not two.** The RPC accepting a transaction and
returning a hash means nothing; there are three known ways for a well-formed
NNS message to be accepted, hashed, and never mined:

| Route | Where |
|---|---|
| Payload over 64 bytes | §5.1 |
| Sender equals recipient | above |
| **Sender cannot cover `value` + `fee`** | here |

The third was found the hard way on mainnet 2026-08-13, sending from an
`ADMIN_ADDRESS` that had drained to 0. Every NNS message carries at least
`DUST_VALUE` (§5.4), so an address with no income eventually stops being able
to send at all — and it stops *quietly*, indistinguishably from a healthy send.
`getTransactionByHash` returning "not found" after the transaction should have
been included is the only signal there is, so a client MUST NOT treat a
returned hash as confirmation that a message was sent. See §11.5 for what this
requires of the addresses NNS itself signs from.

**Two protocol addresses, split by purpose.** `TREASURY_ADDRESS` receives
money — registration and renewal fees, listing fees, marketplace commission.
`PROTOCOL_ADDRESS` receives everything that carries only `DUST_VALUE`:
`K`, `D`, `E`, `P`, a releasing `U`, and the two sentinels above.

The split earns its keep three ways. It keeps the treasury's traffic close to
its revenue: without it, §10.2's base would sit under an unbounded
accumulation of signalling dust, where since r24 the residue is only the
stray cases §10.2 lists — which is why the base is defined over the log
rather than read off the balance at all. It gives block explorers one address to label as
*NNS Protocol*, where all protocol signalling is visible together. And it is
a better sentinel than the treasury — resolving a name to a donation address
is at least conceivable, while resolving one to a protocol sink never is, so
the sentinel can never collide with a legitimate intent.

`P` (governance) is sent from `ADMIN_ADDRESS` to `PROTOCOL_ADDRESS`, and so is
a `U` that releases a name; a `U` that awards one is sent from `ADMIN_ADDRESS`
to the awardee.
`B` (buy) is sent to `MARKETPLACE_ADDRESS`; `M` (settlement) is sent from
`MARKETPLACE_ADDRESS` to the seller being paid or the buyer being refunded
(§6).

`S` and `X` put the counterparty in the transaction recipient so Nimiq
Pay's native confirmation dialog displays the destination address and its
identicon before signing, in the wallet's own trusted UI. (`B` lost this
property in r7 — the buyer's wallet dialog now shows the marketplace address,
so the client UI must present the offer's name, price, and seller itself.)
The indexer does not rely on this split for discovery; see §7.1.

### 5.4 Value

Fee-bearing messages (`G`, `N`, `O`) carry the fee and go to
`TREASURY_ADDRESS`. Non-fee-bearing messages carry `DUST_VALUE`: `S` and `X`
to their counterparty, and `K`, `D`, `E`, `A`, `P` plus the single §5.3
sentinel to `PROTOCOL_ADDRESS`. `F` and `M` carry the amount being moved (§6).

A `U` carries `DUST_VALUE` under both of its behaviours — to
`PROTOCOL_ADDRESS` when it releases a name, to the awardee when it awards one.
**An award is free in both directions**: the recipient pays nothing, because
the name is a gift and a fee they never agreed to would be unpayable by the
admin on their behalf, and the admin pays nothing beyond the dust, because
`TREASURY_ADDRESS` collecting a fee from itself is bookkeeping, not revenue.

`DUST_VALUE` cannot be 0: **a `value` of 0 is rejected by the network**,
verified twice on mainnet (2026-08-06) with everything else held constant.
A `fee` of 0 *is* accepted for data-carrying transactions, so no minimum-fee
rule is needed.

---

## 6. Message types

### 6.1 Registration is a single transaction

Commit–reveal was removed in revision 4. Registration is one transaction; the
first valid one for a given name wins, in canonical order. This deleted the
`C` and `R` types — `R` for *reveal*, unrelated to the recovery `R` that
revision 20 removed — salts, the account-binding hazard, two delay constants, the
tier declaration field, and four rejection cases.

Note that removing commit–reveal also made **length-based pricing cheap
again**: with `G`, the name is visible in the same transaction, so the indexer
simply measures it. The tier no longer has to be declared, so the wire field,
the mismatch check, and its rejection code never come back (§10.1).

### 6.2 Front-running: accepted, and why

Removing commit–reveal re-opens the possibility that a mempool observer takes
a name after seeing someone else's intent. The judgement to accept it:

1. **Low bot activity.** Nimiq has no established MEV infrastructure.
2. **The prize is thin.** Every 1–4 character name is reserved by rule
   (§4.1), so a sniper's maximum reward is a 5+ character name.
3. **It defended the wrong threat.** The realistic risk is a scripted bulk
   land-grab in the first hours, and commit–reveal does nothing against that —
   a grabber isn't racing anyone, they're just paying.

Paying a maximum fee does **not** solve front-running: equal fees leave
ordering to propagation and to the block producer's own policy, and a producer
running a bot has absolute priority regardless of fee.

The same judgement covers **hash grinding** (§5.2, r27): same-block order is
the hash rank, so a sender can grind a low hash to sort ahead of a competitor
already in the same block. That is a narrower power than the two above — it
needs the competitor's message visible *and* a same-block landing — and it
was never absent: under the body-position order the block producer placed the
body freely, so same-block priority was always for sale to someone. Accepted
on the same grounds, re-evaluated on the same triggers.

The mitigation that does work is `RESERVED_NAMES` (§4.1).

**This judgement is contingent, and the contingency is written down rather
than left to memory.** Both premises above depend on Nimiq's current state:
if NIM appreciates or MEV tooling arrives, a 5-character name stops being a
thin prize and mempool sniping becomes worth automating. **v2 MUST
re-evaluate anti-MEV registration when any of these holds:**

- the median observed 5-character fee (`FEE_BASE` × 25, §10.1) in USD exceeds ~$100
- more than 1% of registrations in a month are lost to a same-block race
  (measurable directly from `REFUND` verdicts in the log, §8.2)
- any third party is observed running a registration bot

The likely answer is a soft commitment rather than full commit–reveal: `G`
carries `keccak256(name ‖ salt)` and a second message reveals it. A 32-byte
digest is 43 characters in base64url, so the committing message fits
comfortably inside the budget (§5.1). Recording the trigger and the sketch
now means the decision is a measurement, not an argument.

### `G` — Register

```
NNS1G<name>
NNS1G<name>|<ref>
NNS1G<name>|<ref>|L
NNS1G<name>||L
```

- **Size:** 5 + `MAX_NAME_LEN` + 1 + `MAX_REF_LEN` + 2 = **56 bytes** max,
  inside the verified 64-byte ceiling (§5.1)
- **To:** `TREASURY_ADDRESS`
- **Value:** ≥ the fee this message owes at this block height — the name's
  band fee (§10.1, §10.6), or `LIFETIME_MULTIPLIER` times it with `L`; a
  surplus at or above `REFUND_FLOOR` is owed back (§10.5)
- `L`: **optional** lifetime term (§10.4). The third field is exactly the
  character `L` or absent; anything else in it, or an empty third field, is
  `MALFORMED_PAYLOAD`. The second field may be empty when only `L` is wanted
  — an empty `ref` is an absent one, as the next bullet says
- `ref`: **optional** referrer, 1…`MAX_REF_LEN` characters from `a-z`,
  `0-9`, `-` — **a registered name** whose owner drove the registration, so
  the referral share can be paid to it and the buyer's rebate returned
  (§10.7). It has **no effect on
  validity, price, or ownership**: an unknown, malformed, or absent `ref` is
  recorded as absent and the registration proceeds normally. Deliberately
  inert — a revenue-sharing detail must never be able to reject a paid
  registration

The field exists in r10 rather than later because adding one after the
format freeze would require a new spec version; leaving it unused costs
nothing.

Valid if `name` is valid per §4.1 and `AVAILABLE` at this transaction's
position in canonical order. On success the name is registered to the sender
with `target = sender` and `expiry = block_height + TERM_LENGTH` — or
`block_height + LIFETIME_TERMS × TERM_LENGTH` with `L`. The term is
the half-open window `[block_height, expiry)`, so the last block on which the
name resolves is `expiry - 1` and it is in `GRACE` at `expiry` itself (§7.3).
A lifetime is a long term, not a different kind of record: nothing downstream
distinguishes it (§10.4).

Ties within a block resolve by ascending transaction index, which is
already unique within a block. Never by timestamp.

### `S` — Set resolution target

```
NNS1S<name>
```

- **To:** the new resolution target, value `DUST_VALUE`
- **To reset the target to the owner's own address:** send to
  `PROTOCOL_ADDRESS` instead — the network rejects self-transactions (§5.3),
  so the owner cannot name themselves as recipient
- Sender must be the current owner

Changes where the name resolves; ownership unchanged. This — not `X` — is the
correct operation for "I generated new seeds and want my name to point at the
new address."

### `E` — Set EVM address

```
NNS1E<name>|<evm>
```

- `evm`: the 20-byte EVM address the owner claims, **base64url, unpadded —
  exactly 27 characters**. An empty `evm` clears the record. Canonical form
  is the only valid form: the trailing two bits of the final character MUST
  be zero, and the all-zero address is invalid — it is the EVM burn address,
  and it would be a second spelling of the empty-field clear. Any violation
  — wrong length, a character outside the base64url alphabet, nonzero
  trailing bits, twenty zero bytes — is `MALFORMED_PAYLOAD` (§7.4), never a
  token of its own: unlike a `D` host, this field is a fixed-width canonical
  encoding of a value, like a numeric field (§5.2), not structured content
- **Size:** 5 + `len(name)` + 1 + 27 ≤ 57 for every valid name — inside the
  58-byte working limit every message keeps (§6 `D`)
- **To:** `PROTOCOL_ADDRESS`, value `DUST_VALUE`
- Sender must be the current owner

Declares the address the owner controls on EVM chains — one address for
every EVM chain, because multicoin wallets share the derivation convention
that makes the same address valid on all of them. The record is
**self-declared**: the protocol verifies that the name's owner said it, not
that the owner controls the EVM key. Control is demonstrated on the EVM
side, where the declared address can prove itself by transacting — which is
also why `evm` sits in the §8.1 leaf: the tree is keccak256, so an EVM
contract can verify an §8.3 proof and bind a name to `msg.sender` with no
oracle. Nothing on any other chain is, or becomes, protocol: every further
per-chain or per-name record composes on the EVM side, authorized
transitively through this one record.

A later `E` replaces the record; there is no frequency bound and no
timelock — a mistyped `E` is the same class of self-inflicted loss as a
mistyped `S` target, and is repaired the same way, by sending another. The
record persists through `GRACE` and renewal, like `target`; it is cleared
when a transfer takes effect and on the fall to `AVAILABLE` (§7.3) — it
authorizes a foreign-chain key, and that authorization must not outlive the
ownership that granted it.

Clients taking an EVM address as user input SHOULD validate the EIP-55
checksum when the input is mixed-case, before encoding; the wire and leaf
forms are raw bytes and carry no checksum of their own.

Example: `NNS1Erico|Gz9qCeLEDVXIobLD1OX2BxgpOks` — 37 bytes.

### `X` — Transfer ownership

```
NNS1X<name>
```

- **To:** the new owner, value `DUST_VALUE`
- Sender must be the current owner
- Forfeits `AUCTION_OPEN` or `OFFER_OPEN` while the name has a pending
  operation of another kind — one pending thing per name (§7.3, r30),
  checked after the owner and before nothing: it is `X`'s last row

Takes effect at `height + XFER_TIMELOCK`. Until then the name still resolves
as before and the current owner retains control. A second `X` replaces the
first and restarts the timelock (§7.3) — how a mistyped recipient is fixed —
and a `K` cancels it (§6 `K`). On taking effect the transfer resets the
name's dependent state (§7.3).

**What the timelock is for.** `XFER_TIMELOCK` is the window in which **the
owner can cancel their own pending transfer** with a `K` (§6 `K`) — a
second chance on a *mistyped recipient*, nothing more. It is not a defence
against a stolen key, and must not be described as one: a thief holding the
owner key does not need `X` at all, because `O` + `B` moves the name in two
blocks with no timelock (§6 `B`), and the same key sends the only `K` that
could stop it. §2 states the consequence plainly — a lost owner key is a lost
name. r20 removed the recovery address rather than keep a mechanism the owner
key defeats at dust cost.

### `D` — Set delegate resolver

```
NNS1D<name>|<host>
```

- `host`: hostname with optional short path; `https://` is implied and MUST
  NOT be included. Maximum `MAX_HOST_LEN`. Characters drawn only from `a-z`,
  `0-9`, `.`, `-`, `/` (ASCII); MUST NOT begin or end with `.` or `-`, MUST
  NOT begin with `/`, and MUST NOT contain consecutive `.` or `/`. Anything
  else forfeits `INVALID_HOST` (§7.4) — every one of these rules, the
  character set included, resolves to that one token, and validation must be
  exact or indexers diverge on the same message.
- **Size:** 5 + `len(name)` + 1 + `len(host)` ≤ 58, so name and host together
  MUST NOT exceed **52** characters. `D` is the largest message in the
  protocol; the limit is 58 rather than 64 so it keeps the same margin as
  everything else (§5.1)
- **What the short path is for.** Mounting several delegate **processes** on
  one machine — one proxy route per process. It is **not** what separates two
  names sharing a host, and it is not needed to serve several names: since r23
  the §8.6 request carries the parent, so one process can hold every name
  pointing at it and the namespaces are separate whether or not a path is
  used. Through r22 the path was the only remedy, and `MAX_HOST_LEN` bounding
  host and path together is why it was never sufficient — a bare host is the
  normal case, and a path costs budget a longer name may need. Since r25 it is
  also the only place a word like `delegated` can appear in the URL: §8.6
  supplies no segment of its own, so `example.com/delegated` and
  `delegated.example.com` are the two ways to say it and both say it once
- **To:** `PROTOCOL_ADDRESS`, value `DUST_VALUE`
- Sender must be the current owner

Enables dotted queries under this name (§4.4, §8.6). An empty `host` clears
the delegation and disables subdomain resolution for the name.

Example: `NNS1Dbinance|nns.binance.com` — 28 bytes.

### `K` — Cancel

```
NNS1K<name>
```

- **To:** `PROTOCOL_ADDRESS`, value `DUST_VALUE`
- Sender must be the current owner

Vetoes a pending `X`, or withdraws an `O`, at any height — effective on
inclusion. A name has one pending thing at a time (§7.3), so a `K` is the
way to change its *kind*: cancel, then send the other message. (Within a
kind the later message replaces the earlier one and no `K` is needed.) An open auction is not
cancellable (§6 `A`) — bidders have committed money against the window — so
a `K` on a name whose only pending item is an auction finds nothing. A `K`
with nothing to cancel forfeits with `NOTHING_TO_CANCEL`: the value at stake
is `DUST_VALUE`, and the log then records why the message had no effect
instead of a misleading `OK`. There is no cancel delay on either side. The
r6 `CANCEL_DELAY` went first and `OFFER_IRREVOCABLE` followed it in r30, on
the same argument: with escrowed settlement (§6 `B`) a `B` pays the
marketplace and moves the name only if the sale is still open when it lands,
so a cancellation racing an incoming `B` costs the buyer a refund wait rather
than their money, and a delay on the seller bought nobody anything.

### `N` — Renew

```
NNS1N<name>
NNS1N<name>|L
```

- **Size:** 5 + `MAX_NAME_LEN` + 2 = **31 bytes** max
- **To:** `TREASURY_ADDRESS`
- **Value:** ≥ the fee this message owes at this height — the name's band
  fee, or `LIFETIME_MULTIPLIER` times it with `L`; a surplus at or above
  `REFUND_FLOOR` is owed back (§10.5)
- `L`: optional lifetime term, on `G`'s terms — exactly `L` or absent
- Sender: anyone

Extends expiry by `TERM_LENGTH` — `LIFETIME_TERMS × TERM_LENGTH` with `L` —
from the current expiry, not from the renewal height, so early renewal is
never penalised. Anyone may renew any name, for any term: a renewal changes
nothing but the expiry, so there is no way to harm a name by paying for it.
An `N|L` on a yearly name is how an owner upgrades to a lifetime; an `N` on
a lifetime name adds a year to a date a century out, which is pointless but
harmless and needs no rule.

### `O` — Offer

```
NNS1O<name>|<price_in_luna>
```

- **Size:** 5 + `MAX_NAME_LEN` + 1 + 15 = **45 bytes** max
- **To:** `TREASURY_ADDRESS`
- **Value:** `LISTING_FEE`. Settled at **0** (§3, §12 item 3), so an `O`
  carries `DUST_VALUE` — §5.4 rejects a `value` of 0 outright, and dust is
  the only sendable encoding of "no fee". The check survives at zero because
  the fee is a constant rather than a literal, but `INSUFFICIENT_VALUE` is
  unreachable for `O` while it stays there (§7.4)
- **`price` MUST be ≥ `MIN_PRICE`.** Below it the message forfeits:
  client-preventable. `MIN_PRICE` is `FEE_BASE` — the cheapest a name can be
  registered from scratch — so an offer can never be priced below what a
  buyer would pay to simply register a fresh long name instead. Being
  defined *as* a governed constant rather than a fixed luna amount, it
  tracks the NIM price through §10.6 instead of going stale like any
  hardcoded figure would (§10.6's own argument, applied here).

  It is therefore `FEE_BASE` **as in effect at this message's own block
  height**, the same rule §6 `M` states for the commission rate: an
  implementation comparing against the launch constant agrees with everyone
  else until the first `P` moves `FEE_BASE` and disagrees, silently, from
  that block on. The active value is committed to in every checkpoint
  (§8.1), so a client can prove the floor it is about to be held to.

  Three things make a token floor unworkable, and they are worth recording
  so nobody lowers it later: a price of 0 is unsatisfiable, since `B` must
  carry the price exactly and the network rejects `value: 0` (§5.4); any
  floor below `REFUND_FLOOR` means a losing bidder is **forfeited rather
  than refunded**, contradicting §7.4; and a floor small enough that
  `floor(price × AUCTION_MIN_INCREMENT)` rounds to 0 erases the auction
  increment rule, admitting unlimited dust bids that each oblige an `M`
  refund. At `FEE_BASE` all three are far below the floor, which is the
  point: the floor is set by what a name costs, not by what arithmetic
  tolerates
- Sender must be the current owner
- Forfeits `AUCTION_OPEN` or `TRANSFER_PENDING` while the name has a pending
  operation of another kind — one pending thing per name (§7.3, r30),
  checked after the owner and before the price

A second `O` replaces the standing one — a reprice, with a fresh lifetime
(§7.3); a `B` carrying the old price is refunded `WRONG_PRICE`. Cancellable
via `K` at any height (§6 `K`), auto-expiring at `OFFER_MAX_LIFETIME`.

### `B` — Buy

```
NNS1B<name>
```

- **To:** `MARKETPLACE_ADDRESS`
- **Value:** must equal the offer price **exactly**

The first valid `B` in canonical order wins: **ownership moves to the buyer
immediately and deterministically**, with the same dependent-state resets as
`X` (§7.3), and the buyer inherits the name's current expiry. Settlement
never gates the transfer — the marketplace operator handles money, never
names, so a stalled or dishonest operator cannot touch resolution or
ownership.

The winning payment creates a debt: the marketplace owes the seller the
price, discharged with `M`. Every other `B` — the race loser, a `B` against
a cancelled or expired offer, a wrong value — creates the opposite debt: the
marketplace owes its sender a refund, also discharged with `M` (§7.4).

**A `B` on a name with an open auction is a bid** (§6 `A`, r28): its value is
the bid, a bid short of what the auction requires refunds under
`WRONG_PRICE`, and a bid that stands moves no ownership — the close does
that, at the end height. State decides which kind of `B` a message is, and
because an auction and an offer never coexist on a name, it decides
unambiguously.

This is the one deliberately custodial piece of NNS. The direct
buyer-to-seller alternative was rejected in r7 because it let a race
loser's money land in the seller's pocket with no recourse — worse than
bounded, auditable custody. Exposure is limited to funds in flight between a
`B` and its `M`, and the log makes any shortfall permanently visible.

### `M` — Settlement

```
NNS1M<height>|<tx_index>
```

- **Size:** 5 + 10 + 1 + 5 = **21 bytes** max
- **To:** the party being paid or refunded
- **Value:** the amount owed for the referenced transaction
- Sender MUST be `MARKETPLACE_ADDRESS` (for a `B`) or `TREASURY_ADDRESS`
  (for a refunded `G`, or a §10.7 referral payout on one) — whichever
  address holds the funds

References the transaction being settled by block height and transaction
index — the same canonical identity used everywhere else. No effect on name
state; it exists so *settled vs. owed* is computable from the log, exactly
like the burn commitment (§10.2). One `M` per leg is operator guidance
(SHOULD), not a reducer rule — the discharge rule below makes a duplicate
harmless. The operator SHOULD settle only past finalised macro blocks,
mirroring `FINALITY_RULE`.

**Discharge is an exact four-coordinate match, or nothing.** An `M`
discharges the single outstanding leg agreeing with it on all four of: the
referenced transaction's `(height, tx_index)`; `owedBy` equal to the `M`'s
**sender**; `owedTo` equal to the `M`'s **recipient**; and `amount` equal to
the `M`'s **value, exactly**. "Outstanding" is evaluated at the `M`'s own
position in canonical order. Everything else is one case — an amount wrong
in either direction, a leg already discharged, a reference no leg was ever
created under, the wrong purse: **accepted, `OK`, and discharging nothing.**
The debt stays standing, which is how "the log makes any shortfall
permanently visible" actually works. Only an `M` from a sender that is
neither `MARKETPLACE_ADDRESS` nor `TREASURY_ADDRESS` forfeits
(`WRONG_SENDER`, §7.4).

**Partial discharge does not exist**, for the reason §10.5 keeps a credit
ledger off the fee side: the arithmetic is a comparison, not a balance. And
here it is not merely a simplification — the amount is a *selector*. A
winning `B` creates two legs under one reference, seller and treasury,
ordinarily told apart by recipient; the two collapse onto one address the
day the treasury sells a name it owns, and the exact amount is what still
distinguishes the legs. A proportional `M` against that reference would
match nothing well-defined without a leg identifier on the wire.

**The cross-purse case is a non-match, not a forfeit.** An `M` from
`TREASURY_ADDRESS` against a leg owed by `MARKETPLACE_ADDRESS`, or the
reverse, passes the sender rule — both are legitimate `M` senders — and then
fails the `owedBy` coordinate: accepted, `OK`, discharges nothing. A debt is
discharged only by the purse that owes it. §7.4's `WRONG_SENDER` row gates
who may send an `M` at all, never which debt a legitimate sender may settle.

**A misfired `M` is the operator's own loss, and it is bounded.** An
underpayment reaches the owed party and counts for nothing: the leg remains
outstanding and dischargeable by a correct `M`, and the overshoot when the
full amount follows is borne by the operator that misfired — visible in the
log like everything else here. The economic total a party received is still
computable from the `M` lines by anyone who wants it; what this clause
defines is the *discharge* number, the one the settlement service acts on.

**Why this clause carries the whole weight.** Obligations are deliberately
not committed (§8.1), and every `M` above earns the same `OK` line under
every reading of "matching" — so no root and no log hash ever differs
between two implementations that disagree about discharge. The disagreement
surfaces only as two reconcilers reporting different shortfalls from one
log, which is the exact number the custody argument in §6 `B` rests on. The
definition above is the agreement; there is no hash behind it.

**Amount owed:**

| Referenced `B` | Owed to | Amount |
|---|---|---|
| Winning (`OK`) | Seller | `price − commission` |
| Winning (`OK`) | `TREASURY_ADDRESS` | `commission = floor(price × rate)` |
| `REFUND` (§7.4) | Buyer | the full value sent, **never deducted from** |

`rate` is `COMMISSION_RATE` as in effect at the `B`'s own block height
(§10.6), in basis points. Deducting from a refund would reintroduce a
smaller version of the outcome r7 removed: a buyer who lost a race paying
for the privilege.

Rounding is `floor`, with the seller taking the remainder, so the two legs
of a sale sum to the price exactly with no dust unaccounted for. A winning
`B` therefore settles as two `M` transactions — seller and treasury.

The rate lives on-chain precisely so this table is checkable. If the cut
were an operator config value, an auditor replaying the log could not
distinguish a legitimate commission from a skim, and *settled vs. owed*
would stop meaning anything — which is the entire justification for
accepting custody in §6 `B`.

### `A` — Auction

```
NNS1A<name>|<starting_price>|<end_height>
```

- **Size:** 5 + 24 + 1 + 15 + 1 + 10 = **56 bytes** max
- **To:** `PROTOCOL_ADDRESS`, value `DUST_VALUE`
- Sender must be the current owner of a `REGISTERED` name, or
  `ADMIN_ADDRESS` for a name still held in `RESERVED_NAMES` (§4.1) — the
  two auctions are told apart by whether the name has a record, and that is
  decided before the sender is looked at
- `starting_price` MUST be ≥ `MIN_PRICE`, for the reasons §6 `O` gives and one
  more: the increment rule below is `⌊standing × AUCTION_MIN_INCREMENT⌋`, and
  at a token starting price it rounds to zero, so the floor is what keeps a bid from
  "raising" by nothing
- `starting_price` is exactly that: the least a first bid can carry, public
  in the pending entry (§8.1). A bid short of it is refunded on arrival and
  never stands. The field was `reserve` until 2026-09-04; it was renamed
  because an auction-house reserve is a hidden threshold that bids *below*
  still stand under, which is the opposite of this rule. Bytes unchanged
- `end_height` MUST be at least `AUCTION_MIN_DURATION` above the height of
  the block the message landed in — measured from inclusion like `P`'s
  notice, and forfeiting `INSUFFICIENT_NOTICE` on the same terms
- `end_height` MUST be at most `AUCTION_MAX_DURATION` above that same height,
  forfeiting `AUCTION_TOO_LONG` (r31 fold, 2026-09-22). An auction is a sale
  with a date: while it runs the name can do nothing else, `K` cannot cancel
  it, and every bid is held until it ends. A window of months is a listing
  wearing an auction's exclusivity, and a listing is what `O` is for. Seven
  days is eBay's default and OpenSea's auction cap. Extensions still carry an
  end past the cap, exactly as they can carry it onto the term
- For the owner's auction, `end_height` MUST be below the name's `expiry`
  — an auction sells the current term, and the close hands over the current
  expiry. Forfeits `AUCTION_BEYOND_TERM`; the expiry is in the checkpoint
  tree (§8.1), so a correct client prevents it. An admin auction of a
  still-reserved name has no term to fit

**Check order, after §5.3 routing:** name state (`NAME_NOT_REGISTERED` for a
grace name, `NAME_NOT_FOUND` for a name nobody could auction), then the
sender (`NOT_OWNER` / `NOT_ADMIN`), then the pending-state rows
(`AUCTION_OPEN`, `OFFER_OPEN`, `TRANSFER_PENDING` — one pending thing per
name, §7.3), then the starting price floor, then the window's length — floor,
then cap — then its end against the term — state, authority, pending status,
payload, as `O`'s order already runs (§7.4).

**Nothing opens over an auction, and an auction opens over nothing.** A name
with a pending transfer or an open offer refuses the `A` (§7.3); the owner
clears it with a `K` first. From the opening until the close the auction is
the name's one pending thing: `O`, `X` and a second `A` forfeit
`AUCTION_OPEN`, and `K` cannot cancel it — bidders have committed money
against a window they were told in advance, and the owner set the starting
price. `S`, `E`, `D` and `N` are unaffected.

**Bids are `B`s.** A `B` to `MARKETPLACE_ADDRESS` whose name has an open
auction is a bid, and its `value` is the bid. State decides which kind of
`B` a message is, not the client: an auction and an offer never coexist on a
name, so the same payload can only mean one thing at any height. The rules,
all deterministic from the log:

- The first bid must meet the starting price; every later one must reach
  `standing + ⌊standing × AUCTION_MIN_INCREMENT⌋`. Anything less is
  `REFUND` under `WRONG_PRICE` — a losing bid can be a same-block race, so it
  is never the bidder's fault
- **A successful bid refunds the outbid bidder at once**, an obligation on
  `MARKETPLACE_ADDRESS` keyed by the outbid bid's own `(height, tx_index)`.
  The marketplace therefore holds exactly one bid per auction, never a pile,
  and custody is bounded by the standing bid rather than by every bid for the
  life of the window
- After a successful bid, `end_height = max(end_height, bid_height +
  AUCTION_EXTENSION)`: the end is never less than `AUCTION_EXTENSION` after
  the last bid that stood. Without this, sniping the last block reproduces
  the race the auction exists to avoid. A refunded bid moves nothing, and
  there is no cap on extensions — each costs the extender at least
  `AUCTION_MIN_INCREMENT` more, so the money runs out before the blocks do
- Two bids in one block are ordered by §5.2; the first sets the standing bid
  and the second must beat it by the increment, so a tie cannot occur

**The close is a height-driven effect (§7.3), not a message.** At
`end_height` — as moved by extensions — and before that block's
transactions, the standing bid wins: the name transfers with the same
dependent-state resets as `X`, the winner inheriting the current expiry, and
two legs are created against the **winning bid's** `(height, tx_index)`:
`SALE_PROCEEDS` to the seller less `COMMISSION_RATE` as in effect at the close
height (governance activation fires first, §7.3), and `COMMISSION` to
`TREASURY_ADDRESS` — discharged by `M` exactly as a sale is (§6 `M`). For an
admin auction of a still-reserved name the seller is `TREASURY_ADDRESS`, the
close creates the registration on `U`'s award terms — a full `TERM_LENGTH`
from the close height, nothing set — and the name enters the unreserved set
(§8.1); both legs then land on the treasury and are told apart by amount, the
case §6 `M` anticipated. With no standing bid the auction simply ends and the
name stays where it was; a bid under the starting price was refunded when it
arrived and never stood, so "the starting price was never met" is the same state
as "nobody bid". A `B` arriving at or after the close refunds under
`OFFER_NOT_OPEN`, the ordinary no-offer path.

**An auction cannot open past the name's term, but an extension can carry
it there.** The opening rule above keeps the window inside the term; a late
bid can still push the end to or past the expiry. The §7.3 grace reset then
cancels the running auction exactly as it cancels an `O` or an `X`, and —
because a bid is money — refunds the standing bid by that bid's own ref;
when the end lands exactly on the expiry, the expiry fires first, so a
winner never receives a name that is already in grace. An owner who wants
the sale renews first. Through 2026-09-02 the opening rule did not exist
and the close fired ahead of the expiry; the live battery showed the
collision handing the winner a grace name, and that was judged the wrong
side to protect.

**Why this is not how ordinary registration works.** Making the highest payer
win a same-block race would be worse than ordering: today, taking a name from
someone requires controlling ordering, which means being the block producer;
under price priority, any mempool watcher takes it for one extra luna. That
converts front-running from a producer-only capability into a scripted one
(§6.2). An auction avoids this because the window is explicit and known to
everyone in advance — price discovery where it is worth having, without
turning a fixed-price registration into a blind bidding war.

**How it got here.** Through r27 an `A` was parsed, logged and forfeited
`AUCTION_NOT_IN_V1` — by protocol version, not by omission, so that an
implementation honouring auctions could not silently derive a different root
from one that did not — with activation deferred to "a spec revision from a
stated height". r28 activated it before anything launched, when that height
is simply `LAUNCH_HEIGHT`: every piece the clause leaned on already existed
(the §7.3 effect engine, the §8.1 pending set, `M`), and the deferral had
been a judgement about the first cycle's workload, not about the design. The
token left the vocabulary under §7.4's own rule — no rule on any deployment
can produce it now — and `AUCTION_OPEN` took its slot, so the count is
unchanged. The versioning mechanism the old clause described remains the
way a future type would arrive: below the stated height every
implementation keeps the `UNKNOWN_TYPE` lines, at and above it every
implementation honours the type, and no already-derived root moves.

### `P` — Governance

```
NNS1P<fee_base>|<commission_bp>|<effective_height>
```

- **Size:** 5 + 15 + 1 + 5 + 1 + 10 = **37 bytes** max
- **To:** `PROTOCOL_ADDRESS`, value `DUST_VALUE`
- Sender MUST be `ADMIN_ADDRESS`
- `commission_bp`: marketplace rate in basis points, 0 … `COMMISSION_CEILING`
- `effective_height` ≥ **the height of the block this message lands in** +
  `GOVERNANCE_DELAY`

Both parameters are set in one message so they can never drift out of sync.
One price field moves every band at once (§10.1): the bands are fixed
multiples of `FEE_BASE`, so a `P` never has to say how they relate and
cannot get that wrong. Through 2026-09-10 the message carried two prices
and a bound holding them in order.
Bounds and scope in §10.6. Rejected if any bound is violated — every indexer
enforces them independently.

**A `P` accepted while another is still pending replaces it.** There is at most
one pending `P` (§8.1), and it is always the most recently accepted one; the
superseded change never takes effect and earns no further log line. This is the
same rule §6 `X` states for the other repeatable message, and it is what makes
§8.1's single-entry pending `P` a consequence rather than an assumption. It
became reachable in the ordinary case when r20 removed `PRICE_MIN_INTERVAL`:
two `P`s may now be accepted a block apart, so "the second one queues" and "the
second one replaces" would otherwise be a live disagreement between two
implementations at any height. Bounds are still measured against the **active**
prices, never against a pending `P`'s.

**Notice is measured from inclusion, not from sending.** The indexer sees only
the block a message landed in; it has no idea when the message was built, and
two indexers could not agree on it if it did. A governance message therefore
has to carry enough notice to survive however long it waits in the mempool.

Get this wrong and there is no second attempt at the same message: it takes an
`INSUFFICIENT_NOTICE` forfeit and stays on-chain permanently. **A governance
message is unretractable** — there is no `K` for a `P`, and nothing that has
landed can be recalled. Verified on mainnet 2026-08-13: a `P` and a `U` built
with `head + 10,000` against a `GOVERNANCE_DELAY` of 43,200 — the value at the
time — both forfeited, and both are still there. The `U` half of that
measurement is now history rather than a rule: r22 removed the notice from `U`
altogether, and a message of that shape would today be `MALFORMED_PAYLOAD` for
carrying a second field. Clients MUST compute a `P`'s `effective_height` from a
fresh head with margin above `GOVERNANCE_DELAY`, never from the exact minimum.

**This clause is `P`'s alone.** `U` carries no height and no notice: it takes
effect in the block it lands in (§6 `U`). It is still unretractable, but in the
stronger sense that it has already happened.

### `U` — Unreserve

```
NNS1U<name>
NNS1U<name>|L
```

- **Size:** 5 + `MAX_NAME_LEN` + 2 = **31 bytes** max
- **To:** `PROTOCOL_ADDRESS` to *release* the name, any other address to
  *award* it to that address. Value `DUST_VALUE` either way (§5.4)
- Sender MUST be `ADMIN_ADDRESS`
- `name` MUST satisfy §4.1 rules 2–5 and the rule 1 ceiling (the floor never
  binds a `U` — every well-formed short name is reserved by rule, §4.1).
  For a **release** it MUST be in `RESERVED_NAMES` (rule 6 inverted) and
  MUST NOT already have been released. For an **award** it MUST have no
  owner: reserved and unreleased, or plain `AVAILABLE` — never `REGISTERED`
  or in `GRACE` (`NAME_NOT_AVAILABLE`, §7.4)
- `L`: optional lifetime term for an award (§10.4), on `G`'s terms — the
  second field is exactly `L` or absent, anything else is
  `MALFORMED_PAYLOAD`. A release has no term to set and ignores it. Through
  2026-09-10 any `|` was malformed; an r21-format `U` carrying a height
  still is

**A `U` takes effect in the block it lands in**, at its own position in that
block, like `G`, `S`, `X` and every other message. It carries no height, it is
never pending, and `GOVERNANCE_DELAY` does not reach it — that constant is
`P`'s alone (§3, §10.6).

**Two behaviours, chosen by the recipient.** The payload is identical in both
cases; the transaction recipient decides which act it is:

| Recipient | Effect, on landing |
|---|---|
| `PROTOCOL_ADDRESS` | **Release.** `name` leaves `RESERVED_NAMES` and is `AVAILABLE` under the normal rules |
| Any other address | **Award.** `name` becomes `REGISTERED` to that address: `owner` and `target` both set to it, `expiry = <landing height> + TERM_LENGTH` — or `+ LIFETIME_TERMS × TERM_LENGTH` with `L` — no delegate host, nothing pending. A reserved name leaves `RESERVED_NAMES` on the way |

A name that was reserved joins the unreserved set committed to in every
checkpoint (§8.1) either way; a name that never was leaves the set untouched.
This is the wire mechanism for the release power in §10.6, and since
2026-09-11 for a free registration to a chosen address of any name nobody
holds — giveaways, beta testers, a partner's name, and the re-award of
names a rules rebuild has repriced out of the registry. Nothing is owed and
no fee is earned: an award is outside §10.2's burn base and §10.7's share.
*Adding* to the list remains impossible without a new spec version — that
direction takes names away from people.

**Why there is no notice period.** A notice window protects parties who can act
on the warning, and it is worth exactly what those parties can do with it. A
`U` has no such party in either of its forms.

An **award** has no counterparty at all. Nobody owns the name — it is
reserved, so no `G` for it can succeed (§7.4 `RESERVED_NAME`), or it is
`AVAILABLE` and nobody has claimed it; the admin hands it to a chosen
address. There is nobody the day of warning warns, and nothing anyone would
do with it — except, for an available name, race it, which a notice would
only make easier.

A **release** does have an interested party, and the interested party is a
frontrunner. Announcing a release `GOVERNANCE_DELAY` blocks ahead means a
sniper never has to watch the mempool: tracking `ADMIN_ADDRESS`, reading the
transaction and extracting the name yields a scheduled starting gun with the
time published. §6.2 accepts that races go to whoever watches the chain
hardest, but an *uncertain* race is not the same object as a certain one whose
start is announced a day in advance, and the notice was what converted the
first into the second. Removing it does not make the release un-raceable; it
takes the timetable away from the racer.

Fat-finger protection was the remaining argument for the delay — a `U` cannot
be recalled, so a mistyped name or awardee is permanent. That protection now
lives in the admin CLI (`packages/admin`), as a decoded dry run and an explicit
confirmation before anything is broadcast. It belongs there: it catches the
mistake *before* it is published, which is strictly better than a window in
which the mistake is on-chain and irreversible anyway.

**Why an award is its own outcome, and not a release the recipient races
for.** Releasing a reserved name to `AVAILABLE` and expecting the intended
holder to register it first is a race, and the honest party is not the
favourite in it even without a published schedule — a partner is not running
mempool infrastructure, and a sniper is. Handing `binance` to Binance therefore
has to skip `AVAILABLE` entirely. The alternative, an admin racing on the
partner's behalf and then transferring, is the same race with an extra `X` and
a period where the admin owns a name it was given to pass on.

**What still bounds a stolen admin key**, since it is no longer a day of
notice: an award reaches only names with no owner, so it can never move,
revoke or shorten a name somebody holds (§10.6). It cannot award to itself
at all — that is a self-transaction, dropped silently by the network (§5.3).
It spends registrations the treasury would otherwise have sold, one name and
one public transaction at a time. And the remedy was always a fork rather than a bound
(§10.6): the notice bought hours in front of a response that takes days to
coordinate, and it bought them for the attacker's opponent and the frontrunner
alike.

**Ordering inside the landing block.** A `U` is an ordinary message under §5.2's
canonical order, so a `G` for the same name in the same block is decided by
the hash rank (r27; body position through r26). Ahead of the `U` it sees a reserved name and
forfeits `RESERVED_NAME` — or, for a name that was `AVAILABLE`, registers
it, and the award behind it then finds a `REGISTERED` name and forfeits
`NAME_NOT_AVAILABLE`. Behind a release it sees an available one and
registers normally. Behind an award it sees a `REGISTERED` name and takes
`LOST_REGISTRATION_RACE` — a refund, since losing to a state change inside the
block is precisely the concurrency loss §7.4 refunds. An award of an
available name is therefore raceable from the mempool, exactly as a `G` is
(§6.2), and accepted on the same grounds: a giveaway is a thin prize, and
a sniper who wins one has paid the fee for a name the admin can no longer
give. Through r21 an award
fired in §7.3's height-driven step and therefore beat *every* `G` in its block;
it now beats the ones behind it.

**The one forbidden recipient is `BURN_ADDRESS`** (`INVALID_RECIPIENT`, §7.4).
It has no key, so a name awarded there would be unusable and unrecoverable
until `TERM_LENGTH` and the grace period ran out — dropping a name down a hole
for a year is not a power §10.6 grants, and it is not distinguishable from a
mistake. Through r21 there was a second reason: `BURN_ADDRESS` is the all-zero
address, which is how §8.1's pending-`U` entry encoded *no* recipient, so
permitting the award would have collapsed it onto the release encoding. r22
removed that entry, so only the first reason remains — and it is sufficient on
its own.

**Short names are `U` operands like any other reserved name.**
`RESERVED_NAMES` holds every 1–4 character name satisfying §4.1 rules 2–5 by
rule, and rule 1's floor binds only while a name is reserved — so a released
short name is a normal name the next `G` registers at the normal fee, and an
awarded one is a normal registration from the `U`'s own block. r17 forfeited
these as `INVALID_NAME`, on the premise that a short name can never be a
valid registration; §4.1 no longer says that, and the r17 rule had turned
"held for later auction" into *lost* — `MIN_NAME_LEN` blocked every `G`, the
narrowing blocked every `U`, `A` is deferred, so nothing could ever release
or award one. Awarding a short name is the same designed use as awarding a
long one: handing `nq` to an exchange so it can run a delegate host is
handing `binance` to Binance, two characters shorter. What `INVALID_NAME`
still guards for `U` is rules 2–5 and the length ceiling (§7.4): a name
failing those is one no client accepts, is on neither membership route, and
no `U` may create or release it. Only rule 6 is inverted, and only for a
release: a released name must have been reserved, which is the whole point
of releasing it.

**A second release for the same name is `NAME_NOT_RESERVED`; a second award
is `NAME_NOT_AVAILABLE`.** Through r21 this was
`UNRESERVE_PENDING`, a token whose whole job was to stop two `U`s coming due
against a state only the first of them was validated against. Executing on
landing removes the gap the token guarded: the first `U` takes the name out of
`RESERVED_NAMES` — or gives it an owner — in its own block, so the second one
fails its operation's own row. `UNRESERVE_PENDING` is
therefore gone from §7.4's vocabulary — not deprecated, unreachable. An award
*after* a release is a normal award of an available name, and a release
after an award is `NAME_NOT_RESERVED` — the name left the set when it was
awarded.

### `F` — Burn attestation

```
NNS1F
```

- **Size:** **5 bytes**
- **To:** `BURN_ADDRESS`, value = amount being burned
- Sender: `TREASURY_ADDRESS`

Tags a treasury-to-burn transfer so it enters the log and the burn dashboard
(§10.2). No protocol effect; it exists to make the burn commitment auditable.

---

## 7. Indexer rules

### 7.1 Scanning — one code path, no address index

The indexer walks **batches** from `LAUNCH_HEIGHT` using
`getTransactionsByBatchNumber`, filtering every transaction on the `NNS1` data
prefix. That is the entire discovery mechanism.

It deliberately does **not** use `getTransactionsByAddress`:

1. **It works on any history node.** Address-indexed queries require the
   node's transaction index, roughly doubling storage (~1TB → ~2TB). Batch
   scanning needs history but no index, so any validator already running a
   history node can host an indexer by pointing at their existing RPC.
2. **It is one code path, not two.** `S`, `X`, and `B` go to arbitrary
   recipients and always required prefix scanning.
3. **It avoids a known bug.** `getTransactionsByAddress` paginates on a
   transaction hash cursor, and Nimiq issue #2514 reports invalid hashes for
   reward inherents in that call path.

Cost is round trips: 720 batches per day of chain. With `LAUNCH_HEIGHT` at
protocol launch, a full replay is a few thousand local RPC calls.

Inherents and reward transactions appear in the batch response alongside
user transactions. No heuristic is needed to identify them: they carry no
`NNS1` payload, so the prefix filter excludes them — from discovery and from
§5.2's rank universe alike (r27; through r26 they threatened the counted
body position, which is gone).

### 7.2 Replay

1. Start at `LAUNCH_HEIGHT`.
2. Process transactions in canonical order: ascending `block_number`, then
   ascending transaction hash, bytewise (§5.2 — the rank is derived from the
   batch response alone; no body fetch, no index field needed).
2b. Discard everything §7.5 excludes **before** applying any rule.
2c. Derive each surviving transaction's **effective sender** (below) before
   any rule reads the sender.
3. Advance state only through the last **finalised macro block**.
4. Persist state plus a cursor so restarts resume rather than resync. In
   steady state only the most recent batch is read, so tailing works against a
   pruning node; history is required only for bootstrap and rebuilds.

**Attribution — the effective sender.** Wherever §6 and §7 speak of a
transaction's *sender*, they mean the **effective sender**: the sending
account, unless that account is an HTLC (Nimiq account type 2) and the
transaction's proof is one of the two shapes pinned here — then it is the
address of the **contract-sender signature** the proof carries.

| Proof discriminant | Total length | Effective sender |
|---|---|---|
| `0x01` EarlyResolve | 197 bytes | the second signature proof's key |
| `0x02` TimeoutResolve | 99 bytes | the only signature proof's key |

A signature proof here is exactly 98 bytes: `0x00` (Ed25519, no flags), a
32-byte public key, `0x00` (empty Merkle path), a 64-byte signature. The
address is `blake2b-256(pk)[0..20]`, the §4/§8.1 derivation. **Any other
byte shape — RegularTransfer, WebAuthn/ES256 signature proofs, non-empty
Merkle paths, length mismatches — attributes to the account**, exactly as
before this rule existed; the parse MUST never fail a message. Signatures
are not re-verified: an invalid proof never reaches a block, so inclusion is
the verification.

Why the rule exists: "owner = the sending account" silently assumes accounts
and keys are the same thing. Nimiq Pay is the live counterexample — it holds
its spendable balance in an HTLC it destroys routinely (an emptied contract
is pruned, and the pruned address has no key and never can), while every
spend from that contract carries the signature of the user's persistent
wallet, the contract sender. Attributing to that key makes ownership survive
the contract. It is derivable from the transaction alone — an account lookup
would not replay once the contract is pruned — so any implementation reaches
the same answer from the same wire facts.

Consequences, stated so no implementation guesses:

- Refund obligations (§7.4) are owed to the **effective** sender. A refund
  paid to a pruned contract's address is burned.
- The log line's `sender` field records the effective sender (§8.2).
- A message whose effective sender equals its recipient is possible — the
  network's self-transaction rule binds accounts, not keys — and is subject
  to no additional rule.

### 7.3 Name state machine

```
RESERVED ──U to PROTOCOL_ADDRESS───▶ AVAILABLE
RESERVED ──U to any other address──▶ REGISTERED (awardee)
RESERVED ──A + B… (close)──────────▶ REGISTERED (winner)

AVAILABLE ──G──▶ REGISTERED ──expiry──▶ GRACE ──+30d──▶ AVAILABLE
                      │
                      ├──X (after timelock)──▶ REGISTERED (new owner)
                      ├──S──────────────────▶ target changed
                      ├──E──────────────────▶ EVM address set/cleared
                      ├──D──────────────────▶ delegate host set/cleared
                      ├──O + B──────────────▶ REGISTERED (buyer)
                      └──A + B… (close)─────▶ REGISTERED (winner)
```

During `GRACE` the name does not resolve, dotted queries under it fail, and
it can still be renewed by the former owner. Grace names remain in the
checkpoint tree with `status = GRACE` (§8.1), so a client can prove both the
state and the height at which it ends.

**Every window is half-open: `[start, end)`.** A constant named as a number of
blocks is the *length* of the window, so the block at `end` is the first one
outside it, never the last one inside. Spelled out for the two windows a
name passes through:

| Window | Blocks | Last block inside | State at `end` |
|---|---|---|---|
| Term | `[registration, registration + TERM_LENGTH)` | `expiry - 1` | `GRACE` |
| Grace | `[expiry, expiry + GRACE_PERIOD)` | `expiry + GRACE_PERIOD - 1` | `AVAILABLE` |

So a name registered at height `h` is `REGISTERED` for exactly `TERM_LENGTH`
blocks, `h … h + TERM_LENGTH - 1`; `expiry` is `h + TERM_LENGTH`, and **at
`expiry` the name is already in `GRACE`** — that height belongs to the grace
window, not to the term. Grace runs for exactly `GRACE_PERIOD` blocks and the
name is `AVAILABLE` at `expiry + GRACE_PERIOD`, which is the first block a `G`
for it can succeed and the first at which an `N` takes `NAME_NOT_FOUND`
(§7.3 clears all state on the fall to `AVAILABLE`, so there is no record left
to renew).

This is the same "at" every scheduled effect in this section uses — §6 `X`
takes effect *at* `height + XFER_TIMELOCK`, §6 `P` *at* `effective_height`,
§6 `O` auto-expires *at* `opened_height + OFFER_MAX_LIFETIME` — and it is
stated here because through r20 it was the one timing the spec left to
inference. §6 `G` fixed the *value* of `expiry` and the arrows above were
drawn, but no clause said whether an arrow fired at that height or the block
after it, which is a one-block disagreement about `status` inside the §8.1
leaf and therefore about every root for a full block. The half-open form is
the only one under which §3's block counts are the lengths it calls them, and
it is what the same-height ordering rule below already presumes: a maturing
`X` can collide with an expiry only if both are due at a height computed the
same way.

**Height-driven effects, and their order.** State advances on height as
well as on messages: expiry, grace release, timelock maturity, and
governance activation all fire at a height whether or not any transaction
arrives. An implementation MUST apply due effects at least at every
`CHECKPOINT_INTERVAL` boundary — one that advances only on messages passes
almost every test and then commits a root containing an expired name still
`REGISTERED` at any checkpoint taken during a quiet stretch.

Effects due at one height fire **before that block's transactions**, in a
fixed order: governance activation, maturing `X`, expiry to `GRACE`, grace
release to `AVAILABLE`, **auction close** (§6 `A`, r28), offer expiry — ties
within a category bytewise by name. The order is consensus-relevant: a
maturing `X` colliding with an expiry genuinely diverges (transfer-first hands
the name over and then places it in `GRACE`; expire-first voids the transfer).
Transfer fires first because it was scheduled before the expiry came due, and
because the grace reset exists to stop a lapsed name answering for
subdomains, not to void a transfer already in flight. The auction close sits
after governance activation so the commission it owes is at the rate active
at the close height, exactly as a `B` in that block would be charged, and
**after the expiry and the grace release**: an `A` cannot open past the term
(§6 `A`), so the two meet only when an extension pushed an end exactly onto
the expiry, and there the seller who let the term lapse keeps a grace name
while the bidder is refunded — closing first would have handed the winner a
name already in grace. A close and a maturing `X` can never collide on one
name: an open auction excludes `X`.

**There is no unreserve step.** Through r21 this list had six categories, with
unreserve activation second. r22 made a `U` take effect in the block it lands
in (§6 `U`), so nothing about a release or an award is ever scheduled and there
is nothing for a height to fire. The remaining five kept their relative order,
which is the only thing consensus depends on, and r28 inserted the auction
close as a sixth; `P` activation is the only governance effect driven by
height at all.

A `U` therefore competes with the transactions in its own block on the ordinary
§7.2 ordering rather than preceding all of them — see §6 `U`, "Ordering inside
the landing block", for what a same-block `G` sees from either side of it.

**One pending thing per name** (r30). A name holds at most one pending
operation — a transfer (`X` inside its timelock), a sale (an open `O`) or an
auction (an open `A`). A message of a **different** kind forfeits while one
stands, with the token naming what does: `AUCTION_OPEN`, `OFFER_OPEN` or
`TRANSFER_PENDING`. A message of the **same** kind replaces it — a second
`X` retargets and restarts the timelock, a second `O` reprices — unless it
holds bids: an auction is never replaced, and a second `A` forfeits
`AUCTION_OPEN` like everything else. Nothing of one kind ever voids another:
the owner crosses kinds with a `K` (§6 `K`), which clears a transfer or a
sale at any height and never an auction, and then sends the new message.
Only one map can hold the name, so the order of the pending-state rows is
unobservable and fixed in §7.4 for the record alone. The three are three
ways of giving the name away, and two of them standing at once put the
name's destination in the hands of whoever acted first — before r30 a `B`
landing inside a transfer's timelock took the name at once and voided the
transfer with no log line and no notice to its recipient, deterministically
in every ordering and still not what the owner decided. Refusing is the
whole rule across kinds; within a kind the later message is the same owner
restating the same intent, and a `B` at a replaced price is refunded exactly
as one against a withdrawn listing is.

**Dependent-state resets.** When a transfer takes effect (`X` after its
timelock, `B`, or an auction closing): `owner` and `target` both become the
new owner, the EVM address and the delegate host are cleared, open offers are
cancelled, and any pending `X` is void. A clean slate is the safe default — in
particular, the old target must not keep receiving funds sent to the name,
and the old owner's EVM key must not keep answering for it —
and the new owner reconfigures explicitly. On entering `GRACE`: the delegate
host is cleared (a lapsed name cannot keep answering for its subdomains),
open offers and any pending `X` are cancelled, and an open auction is
cancelled with its standing bid refunded (§6 `A`); the EVM address
persists, like `owner` and `target`, so a grace-then-renew round trip does
not force the owner to re-declare it. On falling to
`AVAILABLE`, all state for the name is cleared.

### 7.4 Rejection: forfeit versus refund

**Refund for losses caused by concurrency, forfeit for losses the client could
have prevented or the user chose** — with one exception since r29: **an
underpayment is refunded.** The treasury received money for nothing, and an
honest client can underpay without a mistake of its own — a `P` activates at
a height, and a `G` priced correctly when it was built and delayed past that
height lands short.

Where one message could fall in both columns, the check order decides — and
for `G` it is fixed: recipient, name syntax, reservation, **value, then
availability**. An underfunded `G` for an already-taken name is therefore
logged as `INSUFFICIENT_VALUE`, not as a lost race: both are refunds owed by
the treasury, so the order chooses only the token, and the underpayment is
the more informative of two true answers.

**Forfeit** — value not recoverable through the protocol:

- Data prefixed `NNS1` but carrying an unknown type, an unparseable payload,
  or more than 64 bytes. Data *not* prefixed `NNS1` is not a forfeit — §7.5
  discards it before it is parsed, and it earns no log line
- Wrong recipient for the message type
- `G` whose name is invalid per §4.1 or reserved — checkable offline
- `G` for a name in `GRACE` — the status and its end height are provable
  from the checkpoint tree (§8.1), so a correct client prevents it
- `S`, `O`, `D`, `E`, `X`, `K`, `A` from anyone other than the current owner
- `O` whose price, or `A` whose starting price, is below `MIN_PRICE` (§6 `O`, §6
  `A`). The floor is `FEE_BASE` as
  in effect at that height, and the active prices are committed to in every
  checkpoint (§8.1), so a correct client can prove it before sending. The
  payload is checked before the value carried, exactly as a `G`'s name
  syntax is: a message whose own payload is unusable is rejected on that
  ground whatever it paid
- `O`, `X` or a second `A` on a name with an open auction (§6 `A`, r28) —
  the auction is in the committed pending set (§8.1), so a correct client
  prevents it; and `A` from anyone but `ADMIN_ADDRESS` for a name still held
  in `RESERVED_NAMES`, or for a name nobody could auction, or with less than
  `AUCTION_MIN_DURATION` or more than `AUCTION_MAX_DURATION` of window from
  the landing block, or — the owner's — with an end at or past the name's
  expiry
- `X`, `S`, `D`, `E`, `A` on an expired or grace-period name
- `D` whose host exceeds `MAX_HOST_LEN` or includes a scheme
- `P` from any sender other than `ADMIN_ADDRESS`, violating a §10.6 bound, or
  carrying less than `GOVERNANCE_DELAY` notice — counted from the height of the
  block the message landed in (§6 `P`), so a `P` that sat too long in the
  mempool takes an `INSUFFICIENT_NOTICE` forfeit even though it was correct
  when it was built, and cannot be withdrawn. **`U` carries no notice**: r22
  removed the field and the bound (§6 `U`)
- `U` from any sender other than `ADMIN_ADDRESS`, awarding to `BURN_ADDRESS`,
  naming a name that fails §4.1 rules 2–5 or the length ceiling (the floor
  never binds a `U`, §6 `U`), releasing a name that is not reserved or has
  already been released, or awarding a name that is `REGISTERED` or in
  `GRACE`. **That is the check order, and it is fixed:** sender,
  recipient, name syntax, then the operation's own row — reservation for a
  release, availability for an award

  **The recipient is checked before the name**, which is the one place a
  `U` departs from the order every other type uses. It follows from §5.3: a
  `U`'s recipient is an *operand*, not a route — `PROTOCOL_ADDRESS` releases
  the name and any other address awards it — so a `U` naming `BURN_ADDRESS` is
  not a release of a bad name or an award of one. It is neither operation, and
  reporting anything about its name would describe a defect it does not have.
  Through r20 this list read the other way round and no clause said it was an
  order at all; r21 fixed the order and stated why the recipient leads, and r22
  removed the notice row it used to lead — the reasoning is unchanged, and the
  row it now leads is `INVALID_NAME` instead. Since 2026-09-11 the recipient
  also selects the last row: `NAME_NOT_RESERVED` for a release,
  `NAME_NOT_AVAILABLE` for an award. The distinction is
  consensus-relevant because both conditions produce a verdict token and §8.2
  commits the token into the log hash

**Refundable** — recorded in the log with a `REFUND` verdict. The value sits
at whichever address received it, which owes the sender a refund discharged
via `M` (§6):

- `G` for a name that was `AVAILABLE` when the client checked but was
  registered by a transaction ordered ahead of this one — owed by
  `TREASURY_ADDRESS`
- `G`, `N` or `O` carrying less than the fee it owes — the band fee, or
  `LIFETIME_MULTIPLIER` times it for a lifetime term — the full value sent,
  owed by `TREASURY_ADDRESS` (r29). Through r28 this forfeited as
  client-preventable; it moved because the treasury keeps nothing it did not
  earn, and because a governance activation can leave a correctly built
  message short through no fault of its sender
- Any `B` that does not win an open offer — the race loser, a `B` against a
  cancelled or expired offer, or a `B` whose value is not exactly the price
  — owed by `MARKETPLACE_ADDRESS`
- Any bid that does not stand (§6 `A`) — short of the starting price or of the
  increment over the standing bid, which can be a same-block race — and
  **every bid that is outbid**, refunded the moment a higher one lands, owed
  by `MARKETPLACE_ADDRESS` and keyed by the bid's own transaction. A bid
  standing when the grace reset cancels the auction is refunded the same way

Registration and purchase races are the same kind of loss and are handled
the same way. Earlier revisions gave registration a *credit* ledger instead,
reasoning that a ledger entry needs no key while a refund does; but the
treasury already spends (the burn share is forwarded from it), so refunds
introduce no new class of hot key, and the machinery was disproportionate to
a fee of a couple of dollars.

**`REFUND_FLOOR`.** An amount below `REFUND_FLOOR` — 1 NIM since r29 — is
forfeited rather than refunded. Without a floor, an attacker could send thousands of trivially
underfunded messages and convert them into an obligation to broadcast
thousands of transactions. Nothing an honest user does falls below it.

Note that a malformed or unknown `ref` (§6 `G`) is **not** in either column:
it is ignored and the registration proceeds. Accounting must never be able
to reject a paid registration.

Nothing in the forfeit column can be triggered by an honest user of a correct
client.

Rejected messages are recorded in the NNS log (§8.2) with their reason code,
so independent replays can confirm the rejection was correct rather than
merely observing an absence.

#### The verdict vocabulary

The prose above says which *column* a rejection falls in. That is not enough:
§8.2 commits the `<verdict>` token into the log hash, so two implementations
that agree perfectly about which messages are rejected, and disagree by one
character about what to call a rejection, derive different log hashes and
therefore different checkpoints. The vocabulary below is **normative and
closed** — every token an implementation may write into `<verdict>`, and
nothing else may appear there.

`REFUND` and `FORFEIT` are the names of the columns, not tokens. A "`REFUND`
verdict" elsewhere in this document means a log line whose token is one of
the three in the refundable table.

**OK.** One token, `OK`, for every message that takes effect — whatever it
did. An `M` that matches no outstanding obligation is `OK` too: it had no
effect, but it broke no rule, and the debt it failed to discharge stays
visible in the log (§6 `M`).

**Forfeit tokens.** The *Types* column is exhaustive: a token may only appear
against a message of a listed type.

| Token | Types | Condition |
|---|---|---|
| `UNKNOWN_TYPE` | any | `NNS1` prefix, but the type character is not one of the 14 in §6 |
| `OVER_LENGTH` | any | Payload longer than the 64-byte budget (§5.1) |
| `MALFORMED_PAYLOAD` | any | Known type, but the payload does not parse per §6 — wrong field count, empty name, unparseable integer, non-canonical number (§6) |
| `WRONG_RECIPIENT` | `G` `D` `E` `K` `N` `O` `B` `A` `P` `F` | Not the recipient §5.3 routes this type to |
| `INVALID_RECIPIENT` | `U` | Recipient is `BURN_ADDRESS` — the one address a name may not be awarded to (§6 `U`) |
| `WRONG_SENDER` | `M` `F` | `M` from neither `MARKETPLACE_ADDRESS` nor `TREASURY_ADDRESS`; `F` from other than `TREASURY_ADDRESS` |
| `INVALID_NAME` | `G` `U` | Name fails §4.1 rules 2–5 or the rule 1 ceiling. The floor never fires here: a 1–4 character name satisfying rules 2–5 is reserved by rule (§4.1), so a `G` for one takes `RESERVED_NAME` while it is held and is a normal registration once a `U` has released it. Rule 6 is inverted for a `U` release, whose name must be *in* `RESERVED_NAMES`; an award ignores rule 6 |
| `RESERVED_NAME` | `G` | Name currently in `RESERVED_NAMES` — on the published list or reserved by rule (§4.1) — and not yet removed from it by a fired `U` |
| `NAME_IN_GRACE` | `G` | Name exists in `GRACE` |
| `NAME_NOT_REGISTERED` | `S` `X` `D` `E` `O` `A` | Name absent, expired, or in `GRACE` — these types require `REGISTERED`. For `A`, a name *with a record* that is not `REGISTERED`; a name with none takes the row below |
| `NAME_NOT_FOUND` | `K` `N` `A` | Name has no record at all. Distinct from the row above because `K` and `N` are valid against a name in `GRACE`. For `A`: no record and not held in `RESERVED_NAMES` either — nobody's to auction (§6 `A`) |
| `NOT_OWNER` | `S` `X` `D` `E` `O` `K` `A` | Sender is not the current owner |
| `INVALID_HOST` | `D` | Host fails any §6 `D` rule: over `MAX_HOST_LEN`, a character outside the §6 `D` alphabet (which is how a scheme is caught — `:` is not in it), or a leading/trailing/consecutive-character rule. Never `MALFORMED_PAYLOAD` — a bad host still splits into fields per §5.2, so the payload parses and the host is judged as content |
| `NOT_ADMIN` | `P` `U` `A` | Sender is not `ADMIN_ADDRESS` — for `A`, on a name still held in `RESERVED_NAMES` (§6 `A`) |
| `INSUFFICIENT_NOTICE` | `P` `A` | `effective_height` less than `GOVERNANCE_DELAY` above the height of the block the message landed in; for `A` (r28), `end_height` less than `AUCTION_MIN_DURATION` above it. `U` left this row in r22 — it no longer carries a height |
| `NAME_NOT_RESERVED` | `U` (release) | Name is absent from `RESERVED_NAMES`, or a `U` for it has already fired. Since r22 this is also what a second release for the same name earns: the first one fired on landing, so there is nothing pending to collide with |
| `NAME_NOT_AVAILABLE` | `U` (award) | Name is `REGISTERED` or in `GRACE` — somebody holds it, and §10.6 lets no `U` touch a held name. A reserved-and-unreleased name and a plain `AVAILABLE` one both pass (2026-09-11) |
| `GOVERNANCE_BOUND_VIOLATED` | `P` | A §10.6 bound exceeded, measured against the **active** prices |
| `NOTHING_TO_CANCEL` | `K` | Nothing currently cancellable — no pending `X`, no open `O`. An open auction is pending and not cancellable (§6 `A`), so a `K` beside one lands here |
| `BELOW_MIN_PRICE` | `O` `A` | Price, or starting price, below `MIN_PRICE`, which is `FEE_BASE` at this message's height |
| `AUCTION_OPEN` | `O` `X` `A` | An auction is open on the name — one pending thing per name (§7.3): the owner cannot list, transfer, or auction it again until the close, and `K` cannot end it. Checked after the owner row and before any payload row |
| `OFFER_OPEN` | `X` `A` | An offer is open on the name — one pending thing per name (§7.3): a listing is a standing invitation to strangers, so a transfer or an auction beside it would let whoever sends a `B` first decide where the name goes. The way across is a `K`; a second `O` is not refused but replaces the listing (§6 `O`). Checked with `AUCTION_OPEN`, which it can never co-occur with |
| `TRANSFER_PENDING` | `O` `A` | A transfer is pending on the name — one pending thing per name (§7.3): the owner has already said where the name goes, and a sale or an auction would say somewhere else. The way across is a `K`, which lands at once; a second `X` is not refused but replaces the transfer (§6 `X`). Checked with the two rows above, which it can never co-occur with |
| `AUCTION_TOO_LONG` | `A` | `end_height` more than `AUCTION_MAX_DURATION` above the height of the block the message landed in (§6 `A`, r31 fold): the cap on the window, judged right after its floor |
| `AUCTION_BEYOND_TERM` | `A` | The owner's `end_height` is at or past the name's `expiry` (§6 `A`): an auction sells the current term. The last payload row, after the window's length at both ends |
| `BELOW_REFUND_FLOOR` | `G` `N` `O` `B` | A message that would otherwise be refundable, carrying less than `REFUND_FLOOR`. The only token that crosses columns |

`OVER_LENGTH` is **unreachable on mainnet**. The network caps transaction
data at 64 bytes — the same number as the §5.1 budget — so an over-length
payload is dropped before it can be judged: the RPC accepts it and returns a
hash, and it never lands in a block (measured; `docs/rpc-reference.md`). The
token stays in the vocabulary because the budget is the protocol's own rule,
not a hope about the network's — a deployment with a looser data cap must
still forfeit here — but no mainnet log can ever contain it.

That is an instance of the rule this vocabulary is maintained under: **a
token is dropped when the protocol makes it unreachable, and kept when only
the environment does.** `TOO_SOON` (r20), `UNRESERVE_PENDING` (r22) and `AUCTION_NOT_IN_V1` (r28) went
because after their revisions no rule on *any* deployment could produce them.
The 64-byte cap is a measured Nimiq property, not an NNS constant: were a
Nimiq upgrade to raise it, over-length payloads would start landing in blocks
the day it activated, and every indexer must already agree on the verdict —
deleting the token would turn that upgrade into an NNS fork.

**Refund tokens.** Each creates an obligation on the address named, discharged
by an `M` (§6).

| Token | Types | Owed by | Condition |
|---|---|---|---|
| `LOST_REGISTRATION_RACE` | `G` | `TREASURY_ADDRESS` | Name was taken by a transaction ordered ahead of this one |
| `OFFER_NOT_OPEN` | `B` | `MARKETPLACE_ADDRESS` | Neither an open offer nor an open auction: the race loser, a cancelled or expired offer, or a `B` after an auction closed. All refund identically, so the log does not distinguish them |
| `WRONG_PRICE` | `B` | `MARKETPLACE_ADDRESS` | Against an offer, value is not **exactly** the price — over as well as under (§10.5). Against an auction, the bid is short of the starting price or of the increment over the standing bid (§6 `A`) |
| `INSUFFICIENT_VALUE` | `G` `N` `O` | `TREASURY_ADDRESS` | Value below the fee this message owes: the band fee for the name at this message's height for `G` and `N` (§10.1), the listing fee for `O` (§6 `O`) — unreachable for `O` while `LISTING_FEE` is 0. The full value sent is owed back. A forfeit through r28 |

**One refund rides an `OK` line.** A `G` or `N` that paid *more* than the
fee in effect succeeds and owes the **surplus** back from `TREASURY_ADDRESS`
under its own ref (§10.5) — the mirror of `INSUFFICIENT_VALUE`, with the
same `REFUND_FLOOR`. No token: the verdict is `OK`, and obligations are not
committed (§8.1), so the rule moves no root and no log hash.

**Check order.** A message can fail several of the rows above at once, and
only the first one reached is written, so the order is as normative as the
strings. Parsing runs **hex → `NNS1` prefix → length → type → payload** —
which is why an over-length payload that is not ours is discarded by §7.5
rather than forfeiting `OVER_LENGTH`, and why an unparseable payload of an
unknown type is `UNKNOWN_TYPE`, not `MALFORMED_PAYLOAD`.

The recipient check then precedes every other check on the types that have
one. `S` and `X` have none: §5.3 routes them to the target address
itself, so any recipient is meaningful. Since r17 `U` has none either, for a
different reason — its recipient is an operand rather than a route (§5.3), so
it is checked in a row of its own rather than before everything else. After it,
each type runs its rows in this order:

| Type | Order |
|---|---|
| `G` | `INVALID_NAME`, `RESERVED_NAME`, `INSUFFICIENT_VALUE`, `NAME_IN_GRACE`, `LOST_REGISTRATION_RACE` — as fixed above |
| `S` | `NAME_NOT_REGISTERED`, `NOT_OWNER` |
| `E` | `NAME_NOT_REGISTERED`, `NOT_OWNER` |
| `D` | `NAME_NOT_REGISTERED`, `NOT_OWNER`, `INVALID_HOST` |
| `X` | `NAME_NOT_REGISTERED`, `NOT_OWNER`, `AUCTION_OPEN`, `OFFER_OPEN` |
| `K` | `NAME_NOT_FOUND`, `NOT_OWNER`, `NOTHING_TO_CANCEL` |
| `N` | `NAME_NOT_FOUND`, `INSUFFICIENT_VALUE` |
| `O` | `NAME_NOT_REGISTERED`, `NOT_OWNER`, `AUCTION_OPEN`, `TRANSFER_PENDING`, `BELOW_MIN_PRICE`, `INSUFFICIENT_VALUE` |
| `B` | `OFFER_NOT_OPEN`, `WRONG_PRICE` — with an auction open, the bid path has only `WRONG_PRICE` (§6 `A`) |
| `M`, `F` | `WRONG_SENDER` |
| `A` | `NAME_NOT_REGISTERED` / `NAME_NOT_FOUND` (which auction this is), `NOT_OWNER` / `NOT_ADMIN`, `AUCTION_OPEN`, `OFFER_OPEN`, `TRANSFER_PENDING`, `BELOW_MIN_PRICE`, `INSUFFICIENT_NOTICE`, `AUCTION_TOO_LONG`, `AUCTION_BEYOND_TERM` — state, authority, pending status, payload (§6 `A`) |
| `P` | `NOT_ADMIN`, `INSUFFICIENT_NOTICE`, `GOVERNANCE_BOUND_VIOLATED` |
| `U` | `NOT_ADMIN`, `INVALID_RECIPIENT`, `INVALID_NAME`, then `NAME_NOT_RESERVED` (release) or `NAME_NOT_AVAILABLE` (award) — the recipient chose which |

`BELOW_REFUND_FLOOR` is not a position in that order: it substitutes for
whichever refund token the message had already earned.

`U`'s order runs envelope, then operation, then operand. `INVALID_RECIPIENT`
sits directly after `NOT_ADMIN` because the recipient decides which of two
operations the message even is, and a release and an award are not the same
act; the two name rows then run from the most fundamental fact about the name
outward — its syntax, then whether the operation can have it — so each can
assume the one above it. r22 removed two rows from the middle and the end of
this order, `INSUFFICIENT_NOTICE` and `UNRESERVE_PENDING`, without disturbing
the four that remain; 2026-09-11 split the last one by operation.

What the orders have in common is that a message's **own payload is checked
before the value it carried** — `G`'s name syntax, `O`'s price floor — so a
message that is unusable on its face is rejected on that ground whatever it
paid. They do not put payload before *state*: `O` establishes that the sender
owns a registered name before it looks at the price, because `BELOW_MIN_PRICE`
against a name the sender never owned would be the less informative of two
true answers.

**§7.5 reasons are not verdict tokens.** A transaction discarded for wrong
network, height below `LAUNCH_HEIGHT`, `executionResult: false`, being a
reward transaction, or not carrying the `NNS1` prefix earns **no log line**
at all (§7.6). An implementation naming those states internally must keep
those names out of the `<verdict>` field.

### 7.5 Transactions the indexer must ignore

Applied before any other rule, and before a message is even parsed:

| Condition | Reason |
|---|---|
| `executionResult` is `false` | **Albatross includes failed transactions in blocks.** Without this rule a failed `G` could take a name, and two implementations disagreeing about it would produce different roots |
| Reward transactions | `getTransactionsByBatchNumber` returns them alongside user transactions; they carry no `NNS1` payload but must not be counted in ordering either |
| `networkId` is not ours | Guards against a misconfigured node fed by a different network |
| Height below `LAUNCH_HEIGHT` | Nothing before launch is protocol material. §7.1's scan starts at `LAUNCH_HEIGHT`; a pre-launch `NNS1`-shaped payload a node serves anyway must not become a message |
| `recipientData` does not begin with `NNS1` | The ordinary case — most chain traffic is not NNS |

The `executionResult` rule is the one that matters: it is invisible in the
happy path, silently wrong in the unhappy one, and was found only by
inspecting a real transaction object.

### 7.6 What earns a log line

Every message surviving §7.5 is logged, with its verdict. Nothing else is.
That is the whole rule.

Deliberately, there is **no anti-spam machinery in v1**. Fee-bearing messages
(`G`, `N`, `O`) are priced by their own fee, which is what §8.2's growth
bound rests on. Signalling messages (`K`, `D`, `E`, `S`, `X`) are not priced,
so someone who owns a name can emit them repeatedly for the cost of the dust
and the network fee. Registration is the only gate.

**This is an accepted risk, not an oversight.** Filters, per-name rate
windows and signalling fees were all specified and then removed: each is a
rule every independent implementation must match exactly, added against an
attack nobody has yet run, on a protocol with no users. §1 treats simplicity
as a security property, and the response to spam is available in a week
through §10.6 pricing if it ever materialises. §16 records the mechanisms and
the analysis behind them so the work is not lost.

---

## 8. State, log, and verification

### 8.1 Merkle tree

Every `CHECKPOINT_INTERVAL` blocks, build a tree over all names in
`REGISTERED` **or `GRACE`** state.

**Checkpoint heights are absolute multiples of `CHECKPOINT_INTERVAL`** —
counted from block zero, never as offsets from `LAUNCH_HEIGHT`. The schedule
must not move with a config value: `LAUNCH_HEIGHT` was open until the launch freeze, so
an offset schedule is one two operators can disagree about while both honestly
implementing "every `CHECKPOINT_INTERVAL` blocks". Multiples of 720 from zero
need no agreement. `LAUNCH_HEIGHT` itself never gets a checkpoint unless it
happens to be such a multiple; a boundary is strictly above the previous one.

The tree itself:

- Leaves sorted bytewise-lexicographically by name
- `leaf = keccak256(0x00 ‖ enc)`; internal nodes `keccak256(0x01 ‖ left ‖
  right)`. The one-byte domain-separation prefixes prevent a crafted leaf
  from being reinterpreted as an internal node (second-preimage hardening)
- `enc = len(name):u8 ‖ name ‖ owner:20B ‖ target:20B ‖ evm:20B ‖
  expiry:u64-BE ‖ status:u8 ‖ len(host):u8 ‖ host`
  - `name` and `host` are raw ASCII bytes; every variable-length field is
    length-prefixed, so no two distinct states share an encoding
  - Addresses are the raw 20-byte form, never the `NQ` string; an unset
    host has length 0
  - `evm` is the address set by the name's last effective `E` (§6 `E`), or
    20 zero bytes when unset — unambiguous, because an all-zero `E` payload
    is `MALFORMED_PAYLOAD`, so no set record can encode as unset
  - Through r19 a `recovery:20B` field sat between `status` and the host.
    r20 deleted the recovery address (§6), so it is gone and **every root
    changes**; r26 then inserted `evm:20B` between `target` and `expiry`,
    and every root changes again; the prices digest below lost a field on
    2026-09-11 and every root changes a third time. `COMMITMENT_LAYOUT` is `6`
  - `status` is `0x00` for `REGISTERED`, `0x01` for `GRACE`
- Odd nodes promoted unchanged; empty tree → 32 zero bytes

The referrer (§6 `G`) is **not** in the leaf: it is an accounting detail,
not registry state, and lives only in the log.

Grace names are in the tree so that **non-inclusion cleanly means
`AVAILABLE`**. Before r6 a grace name proved *absent*, and a client following
§8.5 to the letter would have let a user pay for an unregistrable name.

The delegate host is inside the leaf so that clients can verify *which*
resolver a parent designated, even though they cannot verify what that
resolver answers.

Three things beyond the name tree are consensus-relevant state and MUST be
committed to in the checkpoint alongside it, or independent replays diverge:

- The **active prices and commission rate** (§10.6).
- The **pending set** — in-flight `X`, open offers, open auctions (r28) **and
  any pending `P`**, each with its effective, expiry or end height. A pending
  `P` decides what a later registration costs, and is as consensus-relevant as
  a pending transfer; an open auction decides what the next `B` on the name
  means and who holds it at the close.
  Through r21 a pending `U` was a fourth category here; r22 made a `U` take
  effect on landing (§6 `U`), so nothing of the sort exists to commit.
- The **unreserved set** — the reserved names whose `U` has already taken
  effect. An award of a name that was never reserved adds nothing to it.

The unreserved set was missing through r15, and its absence was the sharpest
hole in this clause. Under r16–r21 a pending `U` was committed under tag `0x09`
and then fell out of the commitment entirely the moment it fired: the name has
no leaf in the name tree (it is `AVAILABLE`, not `REGISTERED` or `GRACE`), and
it was no longer pending. So two indexers disagreeing about whether a reserved
name has been released — the disagreement that decides whether a registration
for it is honoured or forfeited as reserved — produced **identical
checkpoints**, and stayed identical until somebody actually registered the
name. The one class of divergence this whole design exists to catch was
invisible for exactly as long as it was cheapest to fix. Tag `0x0A` closes it,
and it is the half of that pair r22 leaves standing: a `U` now has no pending
form to commit, and the fired set is the whole of what a `U` leaves behind.

**The commitment layout.** Each component is domain-separated by a distinct
tag byte and hashed on its own; the four digests are then bound together with
the log hash and the height into the single value an anchor publishes (§9).

| Tag | Domain |
|---|---|
| `0x00` | name leaf |
| `0x01` | internal node |
| `0x02` | the checkpoint commitment |
| `0x03` | the active prices |
| `0x04` | the pending set |
| `0x05` | a pending `X` |
| `0x06` | *retired* — carried a pending `R` through r19; see below |
| `0x07` | an open `O` |
| `0x08` | a pending `P` |
| `0x09` | *retired* — carried a pending `U` through r21; see below |
| `0x0A` | the unreserved set |
| `0x0B` | an open `A` (r28) |

Field conventions, throughout: heights and luna amounts are **`u64-BE`**;
addresses are the raw **20 bytes**, never the `NQ` string, and an unset address
is 20 zero bytes; a `name` is raw ASCII behind a `u8` length prefix; and `‖` is
plain concatenation — no separators, no padding, no alignment.

```
prices     = keccak256(0x03 ‖ fee_base:u64-BE ‖ commission_bp:u64-BE)
```

The pending set is one entry per pending item, concatenated **in category
order** — transfers, offers, auctions, governance — and, inside a category,
bytewise-lexicographically by name. There is at most one pending `P`, and it is
the one entry carrying no name.

```
transfer   = 0x05 ‖ len(name):u8 ‖ name ‖ new_owner:20B
                  ‖ effective_height:u64-BE
offer      = 0x07 ‖ len(name):u8 ‖ name ‖ seller:20B ‖ price:u64-BE
                  ‖ opened_height:u64-BE ‖ expiry_height:u64-BE
auction    = 0x0B ‖ len(name):u8 ‖ name ‖ seller:20B ‖ starting_price:u64-BE
                  ‖ end_height:u64-BE ‖ bidder:20B ‖ bid:u64-BE
governance = 0x08 ‖ prices(proposed):32B ‖ effective_height:u64-BE

pending    = keccak256(0x04 ‖ entry₁ ‖ entry₂ ‖ … ‖ entryₙ)
```

**Tags `0x06` and `0x09` are retired, not reused.** `0x06` carried the
pending-`R` entry through r19; r20 deleted `R` (§6) and the transfer entry lost
its trailing `via_recovery:u8`, which distinguished the two timelocks and can
now only be one value. `0x09` carried the pending-`U` entry through r21, with a
20-byte `recipient` that made it a release or an award; r22 made a `U` execute
on landing (§6 `U`), so no state can hold one. Both are left as holes
deliberately: an implementation written against the earlier revision that meets
a tag it no longer expects fails on a tag it knows, rather than misreading a
renumbered one it thinks it understands. The pending `P` entry embeds the
32-byte `prices` digest of the **proposed** prices rather than their fields.

**The auction entry** (r28) carries the seller — the owner who opened it, or
`TREASURY_ADDRESS` for an admin auction of a still-reserved name — the
starting price, the end height *as moved by extensions*, and the standing bidder and
bid: 20 zero bytes and 0 until a bid has met the starting price, so a client can
prove "no bid stands" from the checkpoint alone. The standing bid's own
`(height, tx_index)` — what the close's two `M` legs will name — is
deliberately **not** in the entry: it is settlement identity, kept out of the
commitment on the same terms as the obligations below.

**Removing the unreserve category moved no bytes, and adding the auction
category moves none either.** The concatenation above carries no separators
and no entry count, so a category with no entries contributes nothing;
through r21 the unreserves category was empty in every state with no `U` in
flight, and under r22 it is empty in every state there is. A commitment
derived under r22 is therefore byte-identical to the r21 commitment over the
same state, and on the same argument every r28 commitment over a state with
no auction open — which is every state any r27 implementation could reach —
equals its r27 value. `COMMITMENT_LAYOUT` stayed **`4`** through r22 and
stays **`5`** through r28, and no root already published becomes
incomparable. What does change is the §8.2 log — a `U`'s `<data>` is 11 bytes
shorter and its verdict may differ; an `A`'s verdict is no longer a forfeit
and a `B` on an auctioned name is a bid — so a database whose scanned range
contains one must be rebuilt even though the layout did not move.

With nothing pending the concatenation is empty and `pending` is
`keccak256(0x04)`, the hash of the lone tag byte. Note the asymmetry with the
name tree, whose empty form is 32 zero bytes: the two empty cases are different
values on purpose, so an implementation cannot substitute one for the other.

The unreserved set is a flat list of names — no heights, because a `U` that has
fired carries nothing but the fact that it fired — encoded exactly as a name is
encoded everywhere else in this clause, and ordered the same way the pending
entries within a category are:

```
unreserved = keccak256(0x0A ‖ len(name₁):u8 ‖ name₁
                            ‖ len(name₂):u8 ‖ name₂ ‖ … )
```

Names bytewise-lexicographic, no separators. With nothing unreserved the
concatenation is empty and the digest is `keccak256(0x0A)`, following `pending`
rather than the name tree. A name enters this set in the block its `U` lands in
and never leaves it — the set is the record of a governance act, not of the
name's current status, so a later registration of the name does not remove it.

An **awarded** name enters on exactly the same terms as a released one: the
award is what took it out of `RESERVED_NAMES`, which is what this set records.
The two are told apart by the awarded name's leaf in the name tree, not here,
and that is sufficient — an indexer that mistook an award for a release would
be missing a `REGISTERED` leaf, so the disagreement is caught by `name_root`
without this list needing to carry the recipient a second time.

```
commitment = keccak256(0x02 ‖ name_root:32B ‖ prices:32B ‖ pending:32B
                            ‖ unreserved:32B ‖ log_hash:32B ‖ height:u64-BE)
```

`height` is the checkpoint height and `log_hash` the §8.2 log hash through it.
Settlement obligations (§6 `M`) are deliberately **not** committed: §6 `M` makes
settled-versus-owed computable from the log, which makes them derived state
rather than consensus state.

The reference implementation's `merkle.json` conformance vectors pin every value
above, all three empty forms included. They track this clause: `0x0A` and the
six unreserved cases landed with r16, the pending `U`'s 20-byte `recipient`
with r17, the name leaf lost `recovery:20B` with r20 and gained `evm:20B`
with r26, and the open-auction entry landed with r28 — each regeneration
recorded in the file's own `spec` field. r22 removes the pending-`U` cases:
**every case whose state is still reachable keeps its r21 value, byte for
byte**, which is the file-level form of the argument above. The two that existed
only to separate a pending `U` from a fired one are gone, and
`every_pending_category` lost its fourth entry — so it is the one value in the
file that moved, and it moved because its *state* moved, not because the
encoding did. Any checkpoint already computed must record which layout produced
it, which is what `COMMITMENT_LAYOUT` and the indexer's `unreserved_root` column
are for.

keccak256 here so proofs stay cheap to verify on-chain if a future version
wants that.

### 8.2 The NNS log

Every `NNS1`-prefixed transaction, in canonical order, one line each.
`tx_index` is the transaction's **zero-based** rank in canonical order
within its block (§5.2, r27) — stated explicitly because a one-based
reading, or a rank taken over §7.5 survivors instead of the full universe,
would produce a different log hash and therefore a different checkpoint,
silently.
The `<data>` field carries the message as **lowercase hex, never raw text**:
a malformed but `NNS1`-prefixed payload still earns a line, and nothing
stops such a payload containing a space or a newline — written raw, it
would forge an entire log line and silently change the committed log hash.
Addresses in a log line use the compact 36-character `NQ` form, unspaced,
for the same reason:

```
<block_height> <tx_index> <tx_hash> <sender> <recipient> <value> <data> <verdict>
```

`verdict` is `OK` or a reason code from §7.4. The `data` field carries the
message verbatim, so the referrer of a `G` (§6 `G`) is recoverable from the
log without a dedicated column. Since r17 the `recipient` field is
load-bearing for one type rather than only informative: a `U`'s recipient is
what decides whether it released a name or awarded it, and to whom (§6 `U`).
It was already in the line, so replaying an award needs nothing the log did
not already carry.

Since r25 the `sender` field records the **effective sender** (§7.2), not
necessarily the sending account. Tier 1 replays the log, and the log does not
carry the transaction proof — a line recording the raw contract account would
replay to a different owner, and therefore a different root, than the chain
produces. The sending account stays recoverable through `tx_hash` for anyone
who wants the chain-level fact.

The log is small — 100k messages at ~140 bytes is under 15 MB — and it is what
makes verification cheap. **This is why no registration band is free:** at
zero cost an attacker could inflate the log until nobody replays it, killing
Tier 1 verification and with it the trust model. Published alongside every
checkpoint root, with its own hash included in the checkpoint.

**Canonical form**, so the committed hash is reproducible: UTF-8, one line
per message, fields separated by single spaces in the order above, hashes
and other hex fields lowercase, every line terminated by a single `\n`. The
committed log hash is the keccak256 of the file bytes from the first line
through the last message at or below the checkpoint height.

**Publication to IPFS.** Each log snapshot is added to IPFS and referenced
by its CID, which is carried in the `Anchored` event (§9). This does not add
tamper-evidence — the keccak256 above already provides that — it adds
**availability that does not depend on the operator**. Before r11, Tier 1
verification began by downloading the log from the very party being checked;
now anyone can fetch it from any node or gateway, and third parties can pin
their own copies.

**The DAG parameters are normative — and they bind the party doing the
add.** A log snapshot is a **UnixFS file** with a **dag-pb** root, **CIDv1**,
**sha2-256**. A multi-megabyte file is not one block, so its root hash is
over DAG structure rather than over the file bytes, and every parameter that
shapes the DAG changes the root CID. The table is the flag set every
publisher and pinner MUST use, pinned so that independent parties adding the
same bytes mint the same CID:

| Parameter | Value |
|---|---|
| CID version | 1 |
| Root codec | `dag-pb` (`0x70`) |
| Multihash | sha2-256 (`0x12`), 32 bytes |
| Chunker | fixed size, **262,144 bytes** (256 KiB) |
| Layout | balanced — never trickle |
| Max links per node | 174 |
| Raw leaves | **off** |
| Inline blocks | off |

- **Raw leaves are off deliberately**, and it is not a performance choice.
  With raw leaves on, a snapshot short enough to fit in a single chunk has no
  intermediate node at all: the root *is* the leaf, and its codec is `raw`
  rather than `dag-pb`. The codec would then depend on the size of the file,
  which is exactly what a client reconstructing a CID from a bare digest
  cannot know. With raw leaves off, every snapshot — the first one after
  launch and a full segment alike — has a `dag-pb` root, and the codec is a
  constant of this spec. Note that **kubo turns raw leaves on by default the
  moment `--cid-version=1` is given**, so a conforming add passes
  `--raw-leaves=false` explicitly rather than relying on any default
- On the wire, the root CID's **32-byte multihash digest as base64url — 43
  characters**. Everything else is fixed above, so a client rebuilds the full
  CID as CIDv1 + `0x70` + `0x12` + `0x20` + digest. A base32 CIDv1 would be
  59 characters and would fit a message exactly, with no margin; the digest
  form leaves room
- **Never a URL, and never a shortener.** A shortener is a mutable
  indirection controlled by somebody, which destroys exactly the property
  content addressing provides
- Clients MUST NOT trust a gateway to have served the right content, and
  the check is keccak256: hash the fetched bytes and compare against the
  `log_hash` committed inside the anchored checkpoint. The binding check
  costs nothing extra on top: replaying the fetched log derives the
  checkpoint, and a gateway that altered a byte cannot produce the anchored
  root (§8.4). **No client re-derives the root CID from fetched bytes** —
  the CID is a locator, not a verifier; IPFS itself refuses to serve content
  that does not match the CID it was asked for, and the only CID computation
  a client performs is rebuilding the CID *string* from the event's digest,
  above

**Only the producer of a snapshot ever derives a CID from bytes**, and it
does so by running a reference implementation of the table — kubo, or a
pinning service's importer — never by reimplementing UnixFS. A wrong CID in
an anchor costs discoverability, not integrity: the event points at nothing
fetchable, but the anchored commitment still binds the log hash, and any
copy of the bytes still verifies against it. The mitigation is therefore
operational — a publisher adds the snapshot through **two independent
implementations** and requires equal CIDs before anchoring the digest.

Published once per anchor (on change with a daily floor, §9) rather than
once per checkpoint — 120 CIDs a day would be noise, and the unchanged
prefix dedupes anyway. Pinned snapshots are **kept, all of them**: at a
daily ceiling the retention question dissolves — a year of a full registry
is a few gigabytes across two free tiers — rather than needing a pruning
policy that would itself be an availability decision.

**IPFS gives integrity, not persistence.** Unpinned content disappears.
Publication is therefore backed by pinning: the operator's own service, and
independent operators pinning their own copies (§15). Claiming the log is
"on IPFS" without pinning commitments behind it would be precisely the kind
of overclaim §2.1 exists to avoid.

### 8.3 Proof format

```json
{
  "name": "rico",
  "owner": "NQ...",
  "target": "NQ...",
  "evm": "0x1b3f6a09e2c40d55c8a1b2c3d4e5f60718293a4b",
  "expiry": 215725374,
  "status": "REGISTERED",
  "delegate": "nns.binance.com",
  "root": "0x...",
  "nimiq_height": 58060800,
  "leaf_index": 1042,
  "proof": [
    { "hash": "0x...", "side": "left" },
    { "hash": "0x...", "side": "right" }
  ],
  "anchor": { "chain": "ethereum", "tx": "0x...", "block": 23100000 }
}
```

Each proof step carries its **side**, and the leaf index travels with the
proof. A bare array of hashes — the obvious format — is not verifiable
here: §8.1's odd-node promotion makes the tree shape depend on the leaf
count, so neither a sibling's side nor the promotion points can be recovered
from the hashes alone.

The document carries **every field the §8.1 leaf encodes** — `delegate` and
`evm` included, `""` when unset; `evm` is lowercase `0x`-prefixed hex when
set, per the §5.1 hex convention, and a verifier rebuilds `""` as 20 zero
bytes — because the client re-derives the leaf hash
from these fields and recombines it with the proof (§8.5). Omit one and the
proof stops binding the record: a verifier that cannot rebuild the preimage
is verifying a hash it was handed, which proves nothing about the fields
next to it. This rule has already been broken once: `recovery` was missing
from this example through r16, and the gap was found when the first
verification test tried to rebuild a leaf for a record that had one. That
field is gone with `R` (r20), but the rule it exposed is not — `delegate`
and `evm` now carry it, and an implementation must keep a test that strips a
leaf field and expects verification to fail.

**Non-inclusion** — needed before a user pays to register — is proven by
returning the two adjacent leaves that lexicographically bracket the queried
name, each with its own proof. When the queried name sorts before the first
or after the last leaf, the single boundary leaf and its proof suffice — the
proof path itself shows the leaf is the extreme one. Because grace names are
in the tree (§8.1), non-inclusion proves `AVAILABLE`, not merely
not-`REGISTERED`.

### 8.4 Tiered verification

**Tier 1 — anyone, no node, seconds.** Fetch the log by the CID in the
anchor (§8.2), replay it with the reference implementation, and compare the
derived checkpoint to the anchored root. The comparison is what verifies the
bytes: the log hash is committed inside the checkpoint, so a gateway that
served altered bytes cannot reach the anchored root. Keccak256 of the fetched
bytes against the committed log hash is a cheaper early check on the same
thing, not a second guarantee; no tier re-derives the CID from the bytes
(§8.2). Catches any manipulation of state or rules — and since r11
the fetch does not route through the operator, so the cheapest tier no longer
depends on the party being checked.

**Tier 2 — anyone with a normal node or a public endpoint.** Spot-check log
entries by transaction hash against any Nimiq RPC, including the free
rate-limited `rpc.nimiqwatch.com`. Catches fabricated entries.

**Tier 3 — any history node.** Full independent replay from `LAUNCH_HEIGHT`.
The only tier that catches **omission**.

Tier 3 is the security-critical one, and §7.1 exists to make it broadly
reachable: any validator already running a history node can point the indexer
at their existing RPC. No new storage, no index, no resync.

It is also the only tier that catches a **forged state** (§2.1): Tiers 1 and
2 check the operator's story for internal consistency, while Tier 3
recomputes the answer from the chain. An NNS with no independent Tier 3
operator has an honest-operator assumption, however many proofs it serves.

### 8.5 Client verification

The mini app MUST:

1. Fetch the latest anchored root from a **public RPC for the anchor chain
   (§9)**, never from
   the NNS API — and from at least `ANCHOR_QUORUM` independent publishers
   (§9), treating a mismatch as a hard failure. `anchor()` is permissionless,
   so "publisher" here means an address **on the client's
   `ANCHOR_PUBLISHERS` list**: anchors from unknown addresses are ignored,
   never counted toward the quorum, and never treated as a mismatch
2. **Query at least `RESOLVER_QUORUM` independent resolvers** and compare
   both the root and the resolved answer. If they disagree, stop and warn —
   never silently prefer one. One resolver plus one anchor publisher is one
   party, and a single party's proofs are internally consistent whether or
   not they are honest (§2.1). Two fetches is the entire cost of closing
   that hole, and the resolver list ships with the client. **A disagreement
   is measured at one height.** Two answers given as of different state
   heights differ the way two roots at different checkpoint heights do — as
   lag, not conflict: for the seconds after a message lands, one resolver
   has the block and another has not, and their answers must differ. The
   client says the change is still propagating and asks again; the alarm is
   for different answers **as of the same height**
3. Verify the inclusion proof locally against the agreed root. **"Root"
   means two different digests in this list and the client must not conflate
   them.** What §9 anchors is the §8.1 **checkpoint commitment** — the
   six-component digest, which is the only value that binds the prices, the
   pending set, the unreserved set and the log hash as well as the names. An
   inclusion proof, by contrast, verifies against the **name root**, one of
   those six components. So the check is in two steps: confirm the
   checkpoint document's `commitment` equals the anchored value, then verify
   the proof against that same document's `nameRoot`. Verifying a proof
   against a `nameRoot` from a document whose `commitment` was never checked
   proves only that the server is internally consistent, which is precisely
   what §2.1 says a single party's proofs always are
4. Resolve normally if the name is at or below `nimiq_height` of the anchor
5. If newer than the last anchor, label it as *recently registered — anchor
   pending*. This is a **depth indicator, not a warning**: the name
   resolves, the proof verifies against the current checkpoint, and the
   anchor is simply not due yet (§8.7). Alarming language belongs only to
   genuine mismatches, and using it here would train users to ignore it
6. **Visually distinguish verified from delegated results.** A registered name
   resolved from a proof is *verified on-chain*. A dotted query answered by a
   delegate host is *resolved by `<parent>`* and carries no cryptographic
   guarantee. If both render identically, one compromised partner resolver
   undermines the trust story for the entire registry.

7. **Alarm and halt on anchor mismatch.** If a locally replayed root
   disagrees with the anchored root, surface the conflict and stop resolving
   — never silently prefer either side. A mismatch means the operator or the
   anchor publisher is compromised (§2), and both are somebody else's key.
8. **Warn on a stale anchor.** If the newest anchor is older than
   `ANCHOR_STALENESS_LIMIT`, say so. An offline publisher must not degrade
   security silently — the client cannot tell "nothing to anchor" from
   "the publisher stopped", so it reports the fact rather than guessing
9. **Preflight every message against the size ceiling** before submitting
   it. Over-length messages are accepted by the RPC and then silently
   dropped (§5.1), so a client that does not check produces a transaction
   hash and no effect — the worst possible user experience. Reject locally,
   with a specific error
10. **Warn before `B`.** Show that settlement is custodial: if this `B`
   loses a race or hits a cancelled offer, the refund comes from the
   marketplace operator (§6 `M`), not from the protocol — auditable in the
   log, but a promise, not a rule. Require explicit confirmation.

The app **MUST** pin `name → address` on first use and hard-stop with a
warning if a previously seen mapping changes. Promoted from SHOULD in r9:
this is the strongest per-user defence there is, because it needs no
external party at all. It converts a mass redirect into many simultaneous
alarms, and it covers the multigraph confusions left out of §4.2.

The app MUST check availability via non-inclusion proof before letting a user
register.

### 8.6 Delegated resolution

For a dotted query `label.parent`:

1. Resolve `parent` normally, with proof. If it is not `REGISTERED` or has no
   delegate host, the query fails.
2. `GET https://<host>/<parent>/<label>`
3. Expected response: `{"address": "NQ...", "ttl": <seconds>}`
4. Validate that the address is well-formed. Cache for `ttl`, capped at one
   hour by the client.

**The request carries the parent and the label.** A delegate host is therefore
able to tell which name a query came from, and two names delegating to the same
bare host have **separate** label namespaces: `shop.a` and `shop.b` are
different questions and a host may answer them differently. Clients MUST cache
delegate answers under `host`, `parent` and `label` together — the same triple
the request carries. `host` stays in the key because a parent that re-points
elsewhere must not keep serving the old host's answers.

A delegate **MAY ignore the parent** and serve one flat namespace; a host
answering for a single name has nothing to disambiguate, and nothing here
requires per-parent configuration. A delegate that does act on it MUST answer a
parent it does not serve with the **same** response it gives a label it does not
hold — a distinguishable "wrong parent" would tell a client which names a host
serves, which is the same thing §8.5 forbids one level down.

**This shape changed in r23, and the old one is not a fallback.** Through r22
the request was `GET https://<host>/nns/v1/resolve/<label>` — label only — so a
host could not tell two parents apart and one answer served both, silently, with
a payment address as the wrong answer. §6 `D`'s short path was the stated remedy
and does not stretch far enough: `MAX_HOST_LEN` bounds host and path together,
which suits one owner on a short domain and fails for a host serving several
owners. A client MUST NOT retry the retired path when the current one fails:
that would keep the shared-namespace shape reachable indefinitely and offer a
downgrade to anyone able to force an error. An un-migrated delegate therefore
stops answering entirely, which is the intended failure — loud, and never a
wrong address.

**r25 removed the `v1` segment and the `delegated` segment that carried it**,
and the same rule governs both: one shape, tried once, no fallback in either
direction and no delegate serving two shapes. The reasoning is in the revision
note; the short version is that nothing is deployed yet that a version marker
would protect — reopened at the launch freeze rather than settled forever — and
that a path segment the protocol owns is a naming decision taken away from the
operator, and taken twice over from the one who names the host after the
service.

**The request is addressed to the host, and the whole path is the host's.**
A delegate MUST read the parent and the label as the **last two segments** of
the request path and MUST ignore anything before them, because §6 `D`'s short
path arrives in the URL the client builds from the record and no proxy can
strip what is part of the address. A delegate MUST NOT require, and MUST NOT
be configured with, the prefix it is mounted under: the prefix says where the
delegate listens, never which name is being asked about. One consequence is
deliberate — an r24 URL is this same lookup under a mount spelled
`delegated/v1`, and is answered as one.

**Optional signed responses.** A delegate MAY return
`{"address": "NQ...", "ttl": <seconds>, "timestamp": <unix>, "sig": "<base64url>"}`
where `sig` is an Ed25519 signature by the parent's owner key over the ASCII
string `parent ‖ "\n" ‖ label ‖ "\n" ‖ address ‖ "\n" ‖ ttl ‖ "\n" ‖ timestamp`.
Clients that verify it MUST reject a timestamp older than `ttl`.

**The parent is in the signed payload** (r23) for the same reason it is in the
request. Verification uses the parent's owner key, so an answer signed by one
owner never verifies for another's name — but where **one owner holds two
names**, a payload omitting the parent is byte-identical across them and a
signed answer for a label under the first replays as the same label under the
second. An exchange holding several names is exactly the party that would turn
signing on.

v1 requires neither producing nor verifying this, but the format is fixed
**now** so a delegate can opt in later without a spec revision — and so two
delegates cannot invent incompatible schemes in the meantime. What it buys:
proof that the parent authorised a particular answer, so a compromised host
alone cannot fabricate subdomain addresses.

The parent's ownership and its designated host are provable from the
checkpoint; the answer is not. That boundary is exactly right — an exchange
already controls the deposit addresses it is naming — but it MUST be surfaced
to the user per §8.5.

**Why this design.** The exchange registers one name, pays once, and issues
unlimited free subdomains to its users. NNS stores nothing per subdomain, the
log does not grow, and Tier 1 verification is unaffected. The party that
benefits from unbounded names carries the cost of storing them.

### 8.7 What gates usability, and what does not

Three clocks run at different speeds, and only the first determines whether
a name works:

| Clock | Interval | What it gates |
|---|---|---|
| Finality (`FINALITY_RULE`) | ~minutes, last finalised macro block | **The name is registered and resolves** |
| Checkpoint (`CHECKPOINT_INTERVAL`) | ~12 min | A Merkle proof exists for it |
| Anchor (§9) | ~1 h | The root is notarised on the anchor chain (§9) |

**A name is usable at the first clock.** Registration takes effect when the
transaction is final; the indexer applies it, the resolver answers for it,
and payments to it work. Checkpoints and anchors add *verification depth* to
a name that already functions — they are not an activation queue, and no
part of this specification makes resolution wait for them.

The practical consequence is that a name registered between anchors resolves
normally and carries a proof against the current checkpoint, with only the
anchor attestation pending. §8.5 requires the client to show that state
plainly, and to make it read as a depth indicator rather than a problem: a
user who has just paid for a name should not be told something is wrong
with it.

### 8.8 Segments and snapshots

**Specified now, not implemented in v1** — the first boundary is a year
away, and a launch-week resolver replays days, not years. It is written down
because the format must be agreed before anyone depends on it.

Verification must stay cheap as history accumulates, or §2.1's guarantee
becomes theoretical: a resolver that has to replay years of log before it can
answer is a barrier to exactly the independent operators §15 recruits.

- The log is divided into **segments** of `SEGMENT_LENGTH`. A closed segment
  is immutable, keeps its own CID, and stays pinned and anchored.
- At each boundary the operator publishes a **state snapshot**: the full
  contents of the Merkle tree at that height — every leaf, not just the root
  — with its root anchored as usual.
- A verifier chooses. **Fast:** take the anchored snapshot, replay only the
  current segment. **Full:** fetch every archived segment and replay from
  `LAUNCH_HEIGHT`.

**Nothing is ever deleted.** Deleting "invalid" lines would be the wrong
move twice over: the spam that matters is *valid* (§7.6), and a rejection
line is what lets an independent replay confirm the rejection was correct
rather than infer it from an absence (§7.4). Segmentation bounds the working
set without destroying evidence — which is what r11's content addressing
bought: an archived segment remains fetchable at the CID it always had.

**The cost, honestly.** A verifier starting from a snapshot trusts the
anchoring quorum for everything before it instead of deriving it. That is a
real weakening for newcomers, mitigated but not removed by the archives
remaining available; Bitcoin's `assumevalid` makes the same trade for the
same reason. The full path always exists, and §8.5's quorum applies to
snapshot roots exactly as it does to checkpoint roots.

**Compaction within a segment is deliberately not specified for v1.** If it
is ever added, one rule keeps it safe: a line may be omitted only when its
verdict is terminal *and* any obligation it created is discharged — a
`REFUND` line stays until its `M` exists — and the uncompacted segment keeps
its own CID so the compaction itself is checkable.

---

## 9. EVM anchoring

```solidity
event Anchored(
    bytes32 indexed root,
    address indexed publisher,   // msg.sender
    uint64  nimiqHeight,
    uint64  timestamp,
    bytes32 logDigest      // multihash digest of the log snapshot's CID (§8.2)
);
function anchor(bytes32 root, uint64 nimiqHeight, bytes32 logDigest)
    external;                    // permissionless — see below
```

`root` is the **§8.1 checkpoint commitment** at `nimiqHeight` — the
six-component digest, not the name root and not any other component. It is
the only one of the six that binds all of them, and it is the value a client
compares an anchor against before trusting a proof (§8.5 #3). A publisher
takes it verbatim from the checkpoint it is anchoring and never recomputes
it: re-deriving a commitment in a publisher would make the publisher a
second implementation of §8.1, which is the divergence this whole section
exists to detect rather than to contain.

`logDigest` is the 32-byte sha2-256 multihash digest of the log snapshot's
**root CID** — an address, not a hash of the file. It is not the keccak256
log hash of §8.2, which is a hash of the file bytes and is already committed
inside `root` by way of the checkpoint. The two are different digests over
different things and both are load-bearing: `logDigest` says *where the
evidence is*, the keccak256 inside `root` says *what it must contain*.

The client rebuilds the full CID from `logDigest`, since CID version, codec
and hash function are fixed by §8.2. Carrying it in the event costs one extra
word of log data and means a single attestation covers both the state and the
evidence for it.

Events rather than storage — logs live in the receipt trie, are independently
verifiable, and cost a fraction of an `SSTORE`.

Cadence: **on change, with a daily floor**, to one chain. The publisher
runs on a schedule (every few hours), anchors when the log digest differs
from the one its own last anchor carries — which it already reads from the
chain for idempotency — and anchors **unconditionally when its newest
anchor is older than 24 hours**, so a live publisher over a quiet registry
still attests daily and a stale anchor still means what §8.5 #8 needs it to
mean: the publisher stopped, not the registry. The log digest, not the
commitment, is the change signal: §8.1 binds the checkpoint height into
the commitment, so it differs at every checkpoint even over an unchanged
registry, while an unchanged log means an unchanged registry — state moves
only through logged messages. Every root is also served by
the NNS API's checkpoint documents.

An anchor is an event emission of roughly 30k gas — fractions of a cent on
any cheap EVM chain — so gas was never the constraint; even hourly would
cost a publisher a few dollars a year. What a fixed fast cadence actually
multiplies is **pin churn and operational noise**: each anchor obligates a
log snapshot pinned on two independent services (§8.2), and a bursty,
mostly-quiet registry makes almost all fixed-schedule anchors re-attest an
unchanged commitment. Anchoring on change spends the pins where the
attestations are, and the daily floor bounds the not-yet-anchored window at
a width that is proportionate because every prior anchor already chains the
whole history — the commitment binds the cumulative `log_hash` — and
because anchoring never gates usability (§8.7). Twenty-four hours against
`ANCHOR_STALENESS_LIMIT`'s forty-eight leaves exactly one missed floor
anchor of margin before clients warn, the same margin the hourly design
had at its scale. Per-checkpoint anchoring (120 a day) remains affordable
in gas and remains the wrong trade for the same churn reason.

### The chain is a deployment choice, not a protocol rule

**Nothing in this specification depends on which chain the anchor contract
lives on.** Chain id, contract address and RPC endpoints are client and
publisher *configuration*; the contract below is plain Solidity with no
chain-specific opcode, precompile or assumption, so it deploys unchanged on
any EVM chain — and whether a configured address holds it is checked against
the committed bytecode with one `eth_getCode`, never inferred from how the
address was derived.
Moving to a different chain, or anchoring to a second one in parallel, is a
deployment decision and a change to a config value — it needs **no revision
of this document**. A future reader should treat the chain named below as
current practice, not as a constant of the protocol.

**v1 launches on Polygon PoS — chain id 137, the PoS chain and not
Polygon zkEVM.** The reason is not gas and not RPC availability, both of
which several chains would satisfy. It is that Nimiq already runs its
stablecoin rails on Polygon PoS, so it is the chain the team and the
community already operate on, and the most likely first independent
publisher (§2.1's whole point) is the Nimiq team. A publisher who already
has keys, funding and monitoring on a chain is a publisher who might
actually run the cron; one who would have to stand all of that up on a
chain chosen for its RPC ecosystem probably will not. Anchoring is worth
exactly as much as the number of independent parties doing it, so the
chain should be picked to maximise that number and nothing else.

A non-EVM L2 was considered and rejected on cost, not merit: it would
replace Solidity, the toolchain, the event-signature seam and `eth_getLogs`
decoding for a contract that is one event and one function.

**What Polygon PoS does not give you, stated plainly.** It is a
**sidechain, not a rollup**. It checkpoints its state roots to Ethereum but
does **not** post its transaction data there, so an anchor recorded here is
*not* reconstructible from L1 data the way a rollup's would be: if the
Polygon validator set were to withhold or lose history, the anchors are as
available as that chain and no more. This specification does not claim
rollup-grade data availability for them, and no client should be written as
though it had it.

Three things bound what that costs:

1. **The anchor is one tier of three, not the root of trust.** §8.4's Tier 1
   is replaying the log and deriving the root yourself, which needs no
   Ethereum access at all; §8.2's IPFS publication makes the evidence for
   that replay available independently of both the operator and the anchor
   chain. The anchor adds a timestamped third-party attestation on top. It
   is the tier that degrades most gracefully, because losing it costs
   *notarisation*, not verifiability.
2. **Its failure mode is loud.** A client that cannot read anchors reports
   the fact (§8.5 #8) rather than silently resolving unverified.
3. **It is one config value away from a different chain**, per the
   subsection above — including anchoring to Ethereum L1 as well, should
   the registry's value ever justify the gas.

Monthly anchoring to Ethereum L1 was specified through r17 and is
**dropped**. Its purpose was availability that did not depend on an L2, and
it does not survive contact with the reasoning above: a second chain doubles
what every independent publisher must fund, key and monitor, which is a
direct tax on the one number that makes anchoring worth anything. Paying it
to soften a data-availability property this section now declines to claim is
the wrong trade at launch. Nothing prevents adding it later; per the
subsection above, doing so is a deployment decision.

**Anchoring is permissionless.** `anchor()` has no access control: any
address may call it, and every independent indexer is encouraged to publish
its own root for the same Nimiq height. The contract records who called by
emitting `msg.sender` as the `publisher` field, and **that is the only thing
it does about identity** — it does not decide who counts. There is no
publisher registry, no `onlyPublisher` modifier, and consequently no owner,
no admin function, and no upgrade path: the contract is a deployed
append-only event emitter with a single external function.

**Who counts is decided entirely on the client.** `ANCHOR_PUBLISHERS` is a
**client-side list**, not a protocol constant and not contract state —
shipped with `packages/resolver` and extended as independent indexers come
online. A client fetches the anchors for a root, keeps the ones whose
`publisher` is on its list, and requires at least `ANCHOR_QUORUM` distinct
survivors (§8.5 #1). An anchor from an address the client does not know is
not invalid; it is simply not counted.

Why the allowlist is not in the contract, given §2. The trust signal is that
**independent parties agree** (§2.1) — a single publisher's anchor proves
only that they said it. A contract-level allowlist would put the operator in
charge of who is allowed to be one of those parties, which converts "several
independent parties agree" into "several parties the operator admitted
agree", and an operator who can exclude a dissenting publisher can silence
exactly the disagreement anchoring exists to expose. Nothing is gained in
exchange: the same operator ships the client, so an on-chain allowlist would
not even reduce the client-delivery exposure §2.2 already bounds — it would
add a second lever to the same hand. Between two lists controlled by the
operator, the honest choice is the one that is visibly a client-side default
the user's client can override, not one that looks like a protocol rule.

**Spam is a client-side non-problem, which is what the indexed fields are
for.** A permissionless `anchor()` lets anyone emit anything, so the event
must be cheap to filter without trusting the emitter. `root` and `publisher`
are both `indexed`: the client's primary query is "anchors for *this* root",
a topic filter that a junk root never appears in, and the secondary filter is
by publisher address, also a topic. Garbage anchors therefore cost a client
no bandwidth and no parsing — only the spammer's gas. `nimiqHeight` stays
unindexed deliberately: the client already knows which height it is asking
about and MUST check the field against it, so indexing it would spend the
third topic on a query nobody makes.

Because each publisher anchors its **own** log digest as well as its own
root, two publishers that disagree have both published the evidence for
their disagreement. Anyone can fetch both logs and diff them, turning
"someone deviated" into "here is the transaction they handled differently" —
without either party's cooperation.

The reference publisher key SHOULD be a multisig, and handing a signer to
the Nimiq team or another ecosystem party is the cheapest available
reduction in operator trust: it removes the project's ability to anchor
unilaterally. Note that this is now a statement about one entry in
`ANCHOR_PUBLISHERS`, not about privileged access — under a permissionless
contract the reference publisher has no power another publisher lacks.

Nimiq Pay injects `window.ethereum`. The earlier enumeration here — mainnet,
Base, Arbitrum, Optimism, BNB Chain, Sepolia — was a snapshot and is
**withdrawn**; per Nimiq's developer documentation the reachable set is not
a fixed list but whatever their RPC provider supports, extensible without a
client change, and it explicitly includes **Polygon PoS** (where their own
USDT rails run). Anchors on the chain named above are therefore readable
through the injected provider with no extra setup. Do not re-add a list
here: it will be stale again, and §9 does not depend on one. Note that
Nimiq Pay mediates only wallet requests; other RPC calls go to the host's
configured endpoint. Because that endpoint is chosen by the host rather than the
client, the app MUST cross-check the `Anchored` event against at least one
independent public JSON-RPC endpoint over plain `fetch` and require
agreement, so no single provider can feed a client a false anchor.

Each anchor MUST carry the Nimiq height it corresponds to. Without it the root
is unverifiable, because nobody can know which history to replay.

---

## 10. Economics

### 10.1 Pricing — one base fee, fixed multipliers

One governable number, `FEE_BASE`, and a frozen table of multipliers by
name length. Every band is `FEE_BASE × multiplier`, per `TERM_LENGTH`:

| Length | Multiplier | Yearly fee at launch | Rationale |
|---|---|---|---|
| 1–2 | 200× | 125,000 NIM (~$40) | Reserved by rule (§4.1) until the admin auctions (§6 `A`), awards (§6 `U`) or releases it; the band is what it costs to hold afterwards |
| 3 | 100× | 62,500 NIM (~$20) | Reserved by rule likewise. Most tickers and brands live at 3–4, which is what keeps the published list short |
| 4 | 50× | 31,250 NIM (~$10) | Reserved by rule likewise |
| 5 | 25× | 15,625 NIM (~$5) | The top of the open market; priced so bulk squatting for resale is not a day-one business |
| 6 | 10× | 6,250 NIM (~$2) | |
| 7–11 | 5× | 3,125 NIM (~$1) | The desirable range |
| 12+ | 1× | 625 NIM (~$0.20) | Effectively free to a user; still bounds the log |

A lifetime term (§10.4) costs `LIFETIME_MULTIPLIER` (10) times the band's
yearly fee.

**Why one governed number.** Governance exists to follow the NIM/USD rate
(§10.6), and that is one scalar: when NIM moves, every band should move
with it, by the same factor. Two independently governed prices could only
drift apart by mistake, and needed an ordering bound to catch the mistake.
The *ratio* between lengths is a positioning decision, not a market
reading, and it is frozen exactly as `TERM_LENGTH` is: changing it is a
spec revision from a stated height, and a `P` cannot get it wrong. It also
keeps `P` at one price field however many bands there are — the 64-byte
budget could not carry four independent prices at all (§5.1).

**Why not free.** Nobody squats 12-character names, so the usual objection
does not apply. The real risk is state bloat: Nimiq transactions cost almost
nothing, so free registration lets an attacker inflate the log and the Merkle
tree until Tier 1 verification is impractical (§8.2). The fee floor is what
makes the verification artifact bounded. Client-side rate limiting cannot
substitute — an independent indexer could not validate it, so it cannot be a
protocol rule.

**Why $0.20 rather than $0.05.** Price is the lever that actually bounds
bloat: at $0.20, $10,000 of attack buys 50,000 junk names (~7 MB of log)
instead of 200,000 (~28 MB). It remains trivial for a real user.

**Why the short end climbs.** Through 2026-09-10 every open name from 5 to
11 characters cost the same ~$1. The desirable 5-character names — first
names, dictionary words — number in the tens of thousands, so at $1 a year
the whole set was squattable for the price of a laptop and resellable on
this protocol's own marketplace. Price is the lever §10.1 already trusts
against bloat; it is the same lever against squatting, applied where the
scarcity is. $5 is deliberately a fraction of what ENS charges for its
short bands — a smaller ecosystem, priced for its users rather than its
speculators — and the cap Rico set on 2026-09-11.

**Why the reserved lengths have a band at all.** A 1–4 character name
enters the open registry by auction, award or release, and from then on
it is a normal name: it renews by `N`, it can be re-registered after
grace, and an award may have been yearly. The band is its holding cost —
what a name of that scarcity costs to keep each year — and it grades by
scarcity like the rest of the table, halving per step down. An auction
sets the sale price once; the band is what stops a cheap early win from
being held forever for the price of a long name. Nothing here reaches an
award, which owes nothing, or a lifetime, which never renews.

**Why the bands stop at 12 rather than moving to 14.** Raising the
threshold does not bound bloat at all — an attacker simply uses longer names.
It only moves 12–13 character names into a dearer band, and almost nothing
anyone actually wants lives there; desirable names are short. Price is the
effective lever; the threshold is not.

Note also that delegated subdomains (§8.6) removed the strongest argument for
an ultra-cheap band: an exchange needs one standard-band name, not thousands
of cheap ones.

`FEE_BASE` is governable (§10.6), so no figure above is a one-way door; the
multipliers are not, and that is the point.

### 10.2 Where fees go, and the burn share

All fees to `TREASURY_ADDRESS`. **20% is forwarded to `BURN_ADDRESS`.**

**The burn base is defined over the log, not the balance** (r24): it is the
sum of `value` over `OK`-verdict `G`, `N`, `O` and `M` lines whose recipient
is `TREASURY_ADDRESS` — accepted registrations, renewals, listing fees, and
marketplace commission, the commission counted when its `M` lands (an `M`
*to* the treasury is a commission by construction; refunds run the other way
and never enter the base). What is owed is `⌊BURN_SHARE × base⌋`, floored to
whole luna. One rule, one number, computable by any outsider from §8.2's log
alone.

Because signalling messages go to `PROTOCOL_ADDRESS` instead (§5.3), the
treasury's balance *approximates* its revenue — but only approximates it.
The balance also holds dust from `S`/`X` messages that happen to name the
treasury as counterparty, refund-class money in flight between its §7.4
verdict and the `M` that pays it back, forfeited junk, and wrongly-sent
amounts. None of that is revenue, which is why the base above is the
normative one; through r23 this section claimed the balance *was* the
revenue, and the first implementation to compute the owed half had to
choose. **Forfeited inflows stay outside the base deliberately**: the
treasury keeps them, but a commitment computed over accidents would make
*owed* depend on other people's mistakes, and the chosen direction only ever
under-obligates — an operator may always burn more than owed, never less.

`PROTOCOL_ADDRESS` receives only `DUST_VALUE`, so nothing accumulates there
worth sweeping. If §16's signalling fee is ever adopted, that changes and the
inflows burn in full.

A transaction has one recipient, so the split cannot happen inside the
registration. The operator periodically forwards the burn share, tagging each
transfer with `F` so it enters the log.

This makes the commitment **auditable rather than promised**: fees received
and NIM burned are both computable from the log and verifiable on-chain, so
the dashboard can show *burned vs. owed* and any shortfall is publicly and
permanently visible. There are no smart contracts, so it remains a policy —
but a policy whose violation is impossible to hide.

Routing fees to a treasury does not weaken the trust model. The security risk
in NNS is the indexer, which is why §8 exists. The fee destination grants no
additional power over resolution.

Nimiq has no native burn operation; `NQ07 0000 0000 0000 0000 0000 0000 0000
0000` is a valid address whose private key is unknown and unobtainable, used
by the team at mainnet launch. Coins sent there remain in the ledger as an
unspendable balance rather than being subtracted from supply.

### 10.3 Revenue lines beyond registration

- Listing fee on `O`
- **Marketplace commission** — `COMMISSION_RATE` on every settled sale
  (§6 `M`), governable and bounded. Escrow made this trivial to implement:
  the funds already pass through `MARKETPLACE_ADDRESS`, so the cut is a
  subtraction rather than a second transaction anyone has to be persuaded
  to send
- Auctions for withheld 1–4 character names
- **Partner integrations.** Exchanges want `binance`, `kraken`, and the like —
  all on the reserved list. Selling or licensing those, bundled with delegated
  subdomain support, is the clearest enterprise line and the strongest
  distribution channel the project has.
- Hosted resolver API with an SLA. Self-hosting stays free and open — that is
  the trust guarantee — while the managed service is the commercial product.

### 10.4 Term length

**One year, renewable**, with a 30-day `GRACE_PERIOD` after it.

**The term is chosen so the mechanism runs.** Expiry, grace, the fall to
`AVAILABLE` and re-registration are consensus rules that no amount of testing
exercises the way real traffic does, and at a five-year term nothing would
have expired until 2031 — the paths would sit unexercised through the whole
formative period, on a design that is frozen long before that. A one-year term
puts every one of them in front of real owners inside the first year, while the
registry is still small enough to act on what they turn up. `GRACE_PERIOD` is
paired to it: 30 days is a window to notice a missed renewal in, not a second
term.

The indexer cost of expiry is negligible either way: one field per name already
inside the Merkle leaf, the `N` handler, and the `GRACE` check. The expensive
part of renewals is entirely user-facing — reminders, expiry UI, support — and
a one-year term does not defer it. **Renewal has one year of runway, not five:
`N` must be reachable in the client, and the reminder below must fire, before
the first cohort registered at launch comes due.**

**One client requirement is not deferrable at all.** Silent expiry is the most
common failure in naming systems, and a year is long enough to forget in.
Clients MUST surface an approaching expiry in-app, prominently, from
`GRACE_PERIOD` × 2 — 60 days — before the date. It is a client requirement
rather than a protocol rule: no indexer validates it, and nothing in consensus
depends on it.

**A lifetime term exists, and it is a term.** `G` and `N` take an optional
`L` (§6): the term is `LIFETIME_TERMS` × `TERM_LENGTH` — a hundred years —
for `LIFETIME_MULTIPLIER` (10) times the band's yearly fee. The expiry is a
plain height a century out, so nothing downstream has a special case: the
state machine, the leaf, the auction's term check and the reminder above all
read it as they read any other expiry, and the reminder simply never comes
within reach. A hundred-year height was chosen over a sentinel for exactly
that reason — a sentinel would need its own rule at every comparison and at
every `N`, and "forever" buys nobody anything a century does not.

Why it exists: the option was always there. `N` stacks without bound and
from anyone, so ten renewals already bought ten years, a hundred a century,
and permanence was never something this design withheld — only something it
priced by the message. The tier prices it at ten years, in one message, and
brings that revenue forward to when the service is new, which is when a
registry earns or does not. The two costs are stated rather than argued
around: a lifetime name behind a lost key never returns, so the namespace
degrades by that much; and a lifetime name never reprices, whatever `P`
does after the sale. Both are the bet, taken deliberately on 2026-09-11.

Expiry itself stays, for the reason it always had: it is a one-way door.
Expiry cannot be added later to names sold as permanent without breaking a
promise, whereas a term — even a hundred-year one — can always be extended
by pricing renewal near zero.

### 10.5 Payment exactness

A fee-bearing message succeeds iff `value ≥ fee` at that transaction's block
height, where the fee is what the message owes — the band fee, or
`LIFETIME_MULTIPLIER` times it for a lifetime term (§10.4). There is no credit ledger and no partial payment: the arithmetic is
a comparison, and the whole of it lives in §7.4's two columns — below the
fee the message has no effect and its value is refunded in full (r29), at or
above it the message takes effect.

**Overpayment on a successful `G` or `N` is refunded — the surplus, not
the message.** The registration or renewal takes effect and the treasury
owes `value − fee` back to the effective sender, as a `REFUND` obligation
under the message's own ref, discharged by an `M` like any other (§6 `M`);
the verdict stays `OK`. Below `REFUND_FLOOR` the surplus is kept, as an
underpayment below the floor is, and for the same reason. This is the
mirror of the underpayment refund and stands on the same argument: a `P`
that lowers the price while a correctly built message sits in the mempool
lands it over through no fault of the client, and the treasury keeps
nothing it did not earn. (Through 2026-09-10 the surplus was forfeited on
the premise that it was "a few luna" — which a price cut never is.) A `B`
against an offer stays exact in both directions, because there the amount
selects the leg; a bid's value is the bid; the dust messages carry no fee
to overpay.

### 10.6 Governance

Prices must be changeable after launch — a fee fixed in NIM drifts with the
NIM/USD rate, and a registry priced at $20 or $0.05 is broken either way. The
commission rate travels with them: it is a percentage, so it does not drift
with the NIM price, but it does need to respond to what the market will bear.

**The mechanism is the `P` message, not a config file.** Every parameter that
can change must live on-chain, or independent indexers diverge the moment one
operator edits their deployment. Registrations are validated against the
prices in effect at their own block height, so a change never invalidates
anything in flight.

**Bounds, enforced independently by every indexer:**

| Bound | Value |
|---|---|
| Sender | must be `ADMIN_ADDRESS` |
| `fee_base` | within `PRICE_FLOOR` … `PRICE_CEILING` |
| Commission | 0 … `COMMISSION_CEILING` (10%), moving at most `COMMISSION_MAX_STEP` (250 bp) per adjustment |
| Notice | `effective_height` ≥ **the height of the block the `P` lands in** + `GOVERNANCE_DELAY` (§6 `P`) |

**There is no rate limit, and that is deliberate.** Earlier revisions bounded
each `P` to `PRICE_MAX_FACTOR` (2×) per adjustment and one accepted `P` per
`PRICE_MIN_INTERVAL` (~7 d). Both are removed. A rate limit here has to satisfy
two requirements at once and cannot: **loose enough not to obstruct legitimate
repricing** — NIM can move an order of magnitude in a quarter, and a registry
that cannot follow it is priced at $20 or $0.05 for the months the limit takes
to unwind — **and tight enough to stop an attacker**, who simply walks the
price down one permitted step at a time and arrives at the same place a few
weeks later. There is no setting that both protects and permits, so the honest
move is to stop pretending the limit is a defence and delete it.

**What protects is the notice window.** A `P` cannot take effect for
`GOVERNANCE_DELAY` (~24 h, doubled from ~12 h when the rate limits went), and
in that window it is a public on-chain fact that every indexer, resolver and
integrator can see. The response to a hostile `P` is not a bound that softens
it; it is a **fork** — a spec revision, from a stated height, that ignores the
rogue key. That is the same remedy the rest of §10.6 already relies on, and it
is the only one available: `PROTOCOL_ADDRESS` and `ADMIN_ADDRESS` are §3
constants and cannot be rotated in-band, so a compromised admin key is not a
key the protocol can retire — it is a key the network has to route around. The
rate limits bought hours of delay in front of a remedy that takes days to
coordinate either way; the notice window is the part that was doing the work.

**Why ENS does not have this problem.** ENS prices in USD and reads the rate
from an oracle, so its registration fee follows the market without anyone
sending a governance transaction at all, and the powers that *are* governed can
be timelocked and multisig'd on-chain. Neither half is available here: NNS has
**no smart contracts** (§1), so there is no oracle to read, no timelock
contract to enforce a delay, and no multisig to spread the key — a price is
whatever the last valid `P` said, and a `P` is one signature from one address.
The design that removes the need for a rate limit is a design this chain
cannot host, and a weak imitation of it is worse than its absence, because it
is quoted as a protection in threat models.

**`PRICE_FLOOR` and `PRICE_CEILING` stay, as fat-finger rails.** They catch a
misplaced decimal in a legitimate `P` — the failure that is actually likely,
and unretractable once mined (§6 `P`) — and they keep the parameter space
inside the range the rest of this document reasons about. They are not offered
as attack protection: an attacker holding the admin key sets the price to the
floor in one message, and the floor being 1 NIM rather than 0 changes nothing
about the response.

The `U` award (§6) is the other thing a stolen key reaches, and the same
argument covers it. It can hand out ownerless names — reserved or merely
available — one public transaction at a time, each rejected outright by the
same fork; it cannot award to itself, and it cannot touch a name that has an
owner. Unsold registrations are an asset the key can start spending in
public, not a lever on the registry.

**A `U` carries no notice, since r22.** The day of warning it used to carry was
worth nothing against this attacker and something real against the honest use:
an award has no counterparty to warn, and a release announced a day ahead hands
a frontrunner a scheduled starting gun (§6 `U`). The remedy here was never the
delay — `ADMIN_ADDRESS` cannot be rotated in-band, so the response to a stolen
key is a fork from a stated height, and a fork takes days to coordinate whether
the offending `U` fired on landing or a day later. What the notice bought was
one day of advance warning on a multi-day response, in exchange for arming
every sniper watching the admin wallet. `P` keeps its notice because a `P`
*does* have parties who can act on the warning: every indexer, resolver and
integrator reprices against it, and none of them is racing anybody.

**The bounds themselves are spec constants, not governable.** If NIM's price
regime shifts so far that even the floor or ceiling is wrong — a sustained
100× move — the remedy is a spec revision changing the constant from a
stated height, coordinated like any other out-of-scope change. NNS is an
interpretation layer: parameter obsolescence is recoverable by coordination.
Pretending the constants must survive every future would only stretch
governance into something slower and more dangerous than a visible,
versioned edit.

**In scope:** `FEE_BASE` and `COMMISSION_RATE` (via `P`),
and *releasing* names from `RESERVED_NAMES` — or *awarding* any ownerless
name directly to a named address, which is the same `U` under a different
recipient (§6 `U`), and which since r22 takes effect on landing rather than
under notice.

**Out of scope — requires a new spec version applying from a stated height:**
name validity rules (§4), `FEE_MULTIPLIERS`, `LIFETIME_MULTIPLIER`,
`LIFETIME_TERMS`, ordering, expiry semantics, `TERM_LENGTH`, `BURN_SHARE`, `LISTING_FEE` — no `P` field carries it, which
is why §12 item 3 settled it at 0 rather than inventing one — anything
touching the ownership of a name that *has* an owner, and *adding* to
`RESERVED_NAMES`.

The ownership line is worth stating precisely, because the `U` award crosses
part of it. Governance can give away a name nobody owns — in
`RESERVED_NAMES`, or simply `AVAILABLE` (since 2026-09-11); it can never
move, revoke, shorten, or expire a name somebody holds. An award is a
registration the treasury chose not to sell, not a registry entry being
rewritten, and every one of them is public in the block it binds in.
Changing validity or the multiplier table retroactively would reprice or
invalidate names people already paid for. A commission change binds at the
`B`'s block height, so a seller's open offer can be settled at a rate they
did not see when they listed — bounded by the 250 bp step, and the reason
the step exists.

`TREASURY_ADDRESS` is spent from in normal operation — the burn share (§10.2)
and, since credits were removed, registration refunds via `M` (§6). It is
therefore a working address with a hot key held by the settlement service,
not a cold vault. Keep only an operational balance there and sweep the rest
to cold storage on a schedule; the log makes any shortfall visible either
way (§7.4).

`PROTOCOL_ADDRESS` holds only dust and is never spent from in normal
operation, but its key is **generated and retained in cold storage**, never
imported into a node. Two reasons, neither about the dust: explorers
generally require a signature from an address before attaching a label to it,
so the key is what makes the *NNS Protocol* tag claimable; and over enough
years somebody — a user pasting the wrong address, a misconfigured
integrator — will send real funds there, and returning them requires the key.
Discarding it would buy provable unspendability, except that it is not
provable: "we destroyed the key" is an assertion with exactly the credibility
of "we never spend it".

`ADMIN_ADDRESS` MUST be distinct from `TREASURY_ADDRESS` and held on a cold
key. **OPEN:** admin key rotation — deferred to v2.

---

### 10.7 Ecosystem payouts — deliberately not protocol rules

Two programmes exist, and neither is a consensus rule. Both are computable
from the log, so they are auditable in the same way as the burn share, but an
indexer never validates them and a missed payout can never invalidate a
registration.

**Referral share and buyer rebate.** A percentage of the registration fee
attributable to a `ref` (§6 `G`), paid to the owner of the name that drove
it. This is the one place where a usage-based share is the right instrument:
it rewards distribution, which is exactly what a referrer provides — an
integrating app and a user sharing a link alike, since a `ref` is a
registered name and nothing distinguishes the two.

The same `ref` also pays the **buyer**: a second percentage of the same fee,
returned to the `G`'s effective sender (§7.2) once the registration is final.
It is a rebate after the fact and not a discount at the price because §6 `G`
checks `value` against the band's fee — a referred buyer paying less would be
`INSUFFICIENT_VALUE` and refunded (§7.4). Paying it as a second `M` changes
no rule: the reducer sees a message that discharges nothing, exactly as it
sees the share. The two are one programme with two payees, so the rules below
govern both, and say where they differ.

The rules the treasury's payer follows, stated here so that anyone holding
the log and the published rate table computes the same payouts:

- **Eligibility and payee are read from state at the `G`'s own position in
  canonical order, before the `G` reduces.** The `ref` must name a
  `REGISTERED` name at that position; its `target` then is the share's
  payee. The rebate's payee is the `G`'s effective sender, a fact of the
  transaction that needs no lookup. Anything else — absent, malformed,
  unregistered, in `GRACE` — is what §6 `G` already says: recorded as absent,
  nothing owed. A `G` cannot refer to
  the name it registers, since that name does not exist when it reduces.
- **Payouts are owed only on an `OK` `G`.** A refunded or forfeited `G`
  registered nothing.
- **Each amount is `⌊price × rate⌋`**, `rate` that payout's own basis
  points, `price` the fee in effect at the `G`'s height for the name's band
  (§10.6) — never the value sent, so an overpayment cannot farm a share.
  Nothing is owed on a payout whose floor is zero; there is no refund-floor
  test, since the treasury is paying out its own revenue.
- **The rates are a published table**: a default row and per-`ref`
  overrides, each row with the height it applies from and a column per
  payout — `bp` for the share, `rebateBp` for the rebate. A row with no
  `rebateBp` pays no rebate, which is what every row written before the
  rebate existed meant. The row in effect for a `(ref, height)` is the most
  specific `ref` among rows whose height is at or below the `G`'s, latest
  height winning. Rows are appended with a height and never edited, so a
  recomputation reproduces every past payout. A partner's larger row is a
  contract, published like the rest.
- **The published rates are net of the §10.2 burn share.** The burn base is
  what the treasury *takes in* — value on `OK` `G`/`N`/`O`/`M` lines to
  `TREASURY_ADDRESS` — so an `M` the treasury sends reduces nothing, and a
  gross payout would leave the treasury burning on money that never stayed
  with it. Deducting the burn from each payout instead puts the treasury in
  exactly the position a burn on a net base would: `f(1−b)(1−s−r) =
  f(1−s−r)(1−b)`, for any fee and any rates. §10.2 is therefore unamended,
  and the burn stays a figure any outsider computes from the log alone. A
  headline 5% is published as **400 bp**, and the referrer and the buyer
  each carry the burn on their own portion.
- **The wire is an `M` from `TREASURY_ADDRESS` to the payee, referencing
  the `G`, whose value is that payout** — one `M` per payout, so a referred
  registration owing both sends two, told apart by their recipient. Both are
  issued per registration, past finality, at the same cadence as a refund.
  The reducer creates no leg for either, so under §6 `M` the transaction is
  accepted, `OK`, and discharges nothing: the debt exists only in the payer's
  ledger, which is what keeps this a policy rather than a rule.
  Settled-versus-owed is computable from the log and the table by anyone, and
  disagreeing with the payer never changes a root.

- **Self-referral is priced by the table, not refused.** A `G` whose
  effective sender (§7.2) already controls the `ref` — as its owner, or as
  the `target` the share would be paid to — is a referral that brought
  nobody: the treasury would move money from the payer back to the payer.
  The rate table carries a column, `selfBp`, for exactly that case, and it
  prices **both** payouts; a row without one prices the case at each payout's
  own rate. The launch default is **0 bp**, so nothing is owed. It has to
  zero the rebate as well as the share, or anyone who owns a single name
  holds a standing discount on every registration they ever make, which is
  not a referral programme. It is a rate rather than a switch because it must
  inherit the row's height: a payer recomputing an old log has to reproduce
  the payouts that were actually paid, and a flag flipped today would rewrite
  them.

Farming is bounded independently of those rates. The referring name must
already be registered, so an owner registering junk under their own name
pays the full fee and receives at most the two rates of it back — while they
sum below 100% farming costs more than not registering, and the price floor
that bounds the log (§8.2) holds. Self-referral is priced at nothing because
it is not distribution, not because it is an attack.

**Independent-publisher stipend.** A per-checkpoint payment to operators who
anchor a root matching consensus (§9). The qualifying condition is
self-proving — the root either matches or it does not, and the publication
is on-chain.

Note what this is *not* paying for. Anchoring is an event emission of
roughly 30k gas; on the §9 anchor chain even an hourly cadence would cost a
few dollars a year, and §9's on-change cadence costs less. The cost being
recognised is **operational attention** — running,
monitoring and updating a service — not gas. Cost recovery would be
rounding error, so the stipend should be sized as recognition, alongside
the non-cash incentives in §15 that do most of the work.

The honest weakness: paying for *agreement* invites free-riding, since an
operator can mirror the published root without replaying anything and still
qualify. There is no clean cryptographic fix. The practical mitigation is
that **the stipend is paid to a roster of known parties** — the Nimiq team,
validators, exchanges — whose reputation is the stake, and admission to that
roster is by application and review.

That roster is a **treasury programme, not a contract permission**, and the
distinction is load-bearing. §9's `anchor()` is permissionless: anyone may
publish a root, nobody needs admission to do it, and a client's
`ANCHOR_PUBLISHERS` list decides whose anchors it counts. Being paid is a
third thing again, decided by whoever holds the treasury. Enforcing the
anti-free-riding rule in Solidity would have meant an on-chain allowlist,
which buys nothing here — a mirroring free-rider is a *known party* by
construction, so an allowlist never excluded them anyway — while costing the
property §9 depends on, that no one party controls who is allowed to
disagree. Paying an unwanted publisher nothing is a decision the treasury can
take unilaterally at any time; excluding them from the contract is not, and
should not be. **OPEN:** the stipend amount, and whether it should exist at
all in v1.

---

## 11. Node and operational requirements

### 11.1 What the indexer needs

| Task | Node required |
|---|---|
| Steady-state tailing | Normal (pruning) node — only the latest batch is read |
| Bootstrap replay | `getTransactionsByBatchNumber` over the scan range — history back to the scan floor, **no transaction index, no block bodies** |
| Rebuilding lost state | Same as bootstrap replay |
| Tier 3 verification | Same as bootstrap replay |

Beyond the transaction stream the indexer needs `getBlockNumber`,
`getBatchNumber`, and `getBlockByNumber(h, false)` **near the head only**:
batch calibration is a head-local binary search (~9 calls, once), and the
history-horizon guard's startup bisection (~20 calls) runs on the refusing
path. Block bodies — `getBlockByNumber(h, true)` — are required nowhere
since r27: canonical order (§5.2) is derived from the batch response alone.

~1TB of history suffices; the ~2TB indexed configuration is not required.

### 11.2 Do not co-locate with a validator

An indexing bootstrap is I/O-heavy, and disk contention on a validator host
risks delayed block production — penalties, deactivation, lost rewards. Run
the history node on separate hardware. It needs no public reachability.

### 11.3 Start the history sync early

Sync time grows with chain length. Begin before writing indexer code.

### 11.4 Public fallback

`rpc.nimiqwatch.com` is a free rate-limited public Nimiq RPC endpoint —
default for Tier 2 spot-checks, for tutorial readers without a node, and a
fallback for the mini app.

### 11.5 Sending addresses MUST be balance-checked and alerted on

An address that cannot cover `value` + `fee` fails by silence, not by error
(§5.3). Two of NNS's own addresses sign transactions and have **no income at
all**:

| Address | Sends | Income |
|---|---|---|
| `MARKETPLACE_ADDRESS` | `M` settlements and refunds (§6 `M`) | Buyer value in, but a `B` it must refund arrives *with* its own value — a run of forfeits does not fund it |
| `ADMIN_ADDRESS` | `P`, `U` (§6) | None. Dust from `S`/`X` that happen to name it, and nothing else |

For both, an operator MUST:

1. **Precheck the balance before signing.** Read the sender's balance and
   compare it against `value` + `fee`; refuse to broadcast rather than emit a
   transaction that will be dropped.
2. **Alert on a threshold well above zero**, sized so that topping up is
   routine rather than an incident. Alerting at zero alerts after the failure.

`TREASURY_ADDRESS` also spends — the burn share (§10.2) and registration
refunds — but it takes fee income continuously, so it fails differently and
§10.6 already asks that only an operational balance be kept there. It belongs
under the same monitoring regardless.

This is an operational requirement, not a consensus rule: an undelivered `M`
leaves the obligation standing in the log (§6 `M`), which is exactly how a
shortfall is meant to stay visible. The point of the alert is that the log
records the debt whether or not anyone is watching.

---

## 12. Open questions

Resolved by inspecting `@nimiq/mini-app-sdk@0.1.0`:

- `sendBasicTransactionWithData({ recipient, value, fee?, data,
  validityStartHeight? })` exists. The design is implementable as a mini app.
- `data` is typed `string`, confirming text-safe encoding throughout.
- No `sender` parameter — no longer a hazard now that commit–reveal is gone.

**Nothing blocks the format freeze any more.** The two questions that did —
whether `data` is UTF-8 or hex, and whether `value: 0` is accepted — were
answered empirically on mainnet in r13 (§5.1, §5.4). The wire format can be
frozen once `RESERVED_NAMES` and the addresses below are fixed.

Decisions pending:

1. `LAUNCH_HEIGHT`, `TREASURY_ADDRESS`, `PROTOCOL_ADDRESS`, `ADMIN_ADDRESS`,
   `MARKETPLACE_ADDRESS`
2. `RESERVED_NAMES` contents — the highest-value item on this list (§4.1).
   **Partly answered in r19**: the published half exists and is a §3 constant,
   but it is not complete, and completing it blocks launch exactly as the five
   values above do. Additions are free until `LAUNCH_HEIGHT` and out of
   governance scope afterwards (§10.6), so this is the last moment they cost
   nothing
3. ~~Listing fee structure for `O`~~ — **settled in r19**, by taking this
   item's second option: dropped, `LISTING_FEE` = 0. Commission captures
   marketplace value at the point of sale (§10.3), and folding a fourth field
   into `P` would have bought the smallest revenue line a governance
   mechanism, new §10.6 bounds, and a wire change
4. Whether signed delegate responses (format already fixed, §8.6, §16.5)
   should ever become REQUIRED rather than optional
5. Whether the Mopsus "name your address by burning 1 Luna" feature from the
   PoW chain still exists, and whether to acknowledge it as prior art
6. ~~Two mini-app SDK questions~~ — **answered on device 2026-08-21**: the
   §10.5 probe ran on a post-fork Nimiq Pay build and the confirmation
   sheet honours the app's **value** and **fee** exactly, so every
   fee-bearing message is sendable from the mini app and §16.2's fee-gate
   is viable. The content-hash-pinning half is **closed 2026-08-29,
   dropped without asking**: hard to implement, questionable result, and
   nobody would deploy it — §2.2's remaining mitigations stand on their
   own
7. ~~Integrator share rate and `ref` issuance process~~ — closed 2026-09-10:
   a `ref` is a registered name, the rate is a published table with a 1,000
   bp default, paid per registration as an `M` (§10.7)
8. Whether the publisher stipend exists in v1 at all (§10.7)
9. Whether a Nimiq-side log attestation message (an `L` type carrying the
   CID digest) is worth adding, giving a verification path that never
   touches an EVM chain. It duplicates what the anchor already carries, and
   §1's simplicity principle argues against a message type that buys nothing
   new — but it would make the log addressable to a client with no EVM
   access at all
10. ~~What the client does at launch, when `RESOLVER_QUORUM` independent
    resolvers do not yet exist~~ — **decided 2026-08-14** (decisions.md,
    "Launch quorum is 1, the operator is named, and the path to 2 is
    written down"): launch is quorum 1 with "Verified by 1 resolver" and
    the party named — alarm vocabulary stays reserved for halting
    failures, so no *unverified* banner — and since 2026-08-28 every
    agreeing resolver is named by its endpoint URL. The interim
    same-owner second resolver exists too (weaker: same party, but it
    survives a single-host compromise)

(Resolved in r6: the `0`/`1` boundary clause was adopted, and the
recovery-address mechanism became the `R` message — **undone in r20, which
removed both**. Resolved in r7: buyer
races are refunded through `MARKETPLACE_ADDRESS` rather than forfeited, and
`CANCEL_DELAY` was removed along with the problem it patched. Resolved in
r8: the marketplace takes a governable commission, carried on-chain by `P`.
Resolved in r13, by mainnet measurement: `data` is hex over RPC, the 64-byte
cap is real, `value: 0` is rejected. Resolved in r14: credits replaced by
treasury refunds via `M`; anti-spam machinery deferred whole to §16.)

**Pin the SDK version.** `@nimiq/mini-app-sdk` is at 0.1.0 with three
published versions. Signatures may shift during the competition.

---

## 13. Build order

Cycle II runs 10 Aug – 4 Sep 2026, and the rules require something fully
functional on first use, not a prototype.

0. **Encoding test and indexer-node sync — both done** (r13; §5.1, §11)
1. `G` and resolve
2. `S` and `X` with the transfer timelock
3. NNS log, Merkle roots, proofs, non-inclusion; `P` and `F` alongside
4. Mini app UI: register, resolve, send-by-name
5. `D` and delegated resolution, with the verified/delegated UI distinction
6. Run-your-own-indexer tutorial, both paths
7. EVM anchoring
8. Marketplace (`O` + `B` + the `M` settlement service)
9. Auctions (`A`, bids through `B`, the close as a §7.3 effect) — deferred to
   "v2" until 2026-09-02, then found to lean on nothing step 8 had not
   already built

Step 5 is small in code and large in pitch — it is the piece that makes the
exchange story real, so it should not be cut before step 7 or 8.

---

## 14. Deliverables

- This spec, versioned in the repo
- `RESERVED_NAMES`, taken seriously (§4.1)
- Indexer — MIT, Dockerised, single command:
  `docker run -e NIMIQ_RPC=... nns/indexer`
- Published NNS log and checkpoint roots, pinned on IPFS and addressed
  from every anchor
- **Conformance test vectors**, shipped with the reference implementation and
  runnable against any independent one. The three areas where implementations
  fork silently rather than loudly: the Merkle leaf byte layout (§8.1),
  canonical ordering across a multi-transaction block (§5.2), and name
  validation including the positional-digit and boundary rules (§4.2). Named
  cases include `failed_G_does_not_register_name` — a `G` with
  `executionResult: false` must leave the name `AVAILABLE` (§7.5)
- Burn and settlement dashboard: burned vs. owed (§10.2) and marketplace
  settled vs. owed (§6 `M`)
- Settlement service — watches `B` and `G` verdicts in the log and issues
  `M` payouts, commission forwards, and refunds past finality, from the
  marketplace and treasury addresses respectively
- Resolver API serving proofs
- Mini app
- Integrator guide: the resolver package, sharing a `ref` link, and the
  §2.2 argument for why an app should ship its own client rather than
  iframe someone else's
- **Delegate resolver reference implementation** — a ~100-line service an
  exchange can deploy to answer `GET /<parent>/<label>` (§8.6), plus a one-page
  integration guide. This is what turns the exchange story from a claim into
  something a partner can adopt in an afternoon.
- **Run-your-own-indexer tutorial, two paths:**
  - *You already run a node* — point at your RPC, five minutes, full Tier 3 replay
  - *You don't* — download the log, replay, compare to the anchor, spot-check
    entries against the public endpoint
- README threat model (§2 verbatim), naming the operator risk and the accepted
  front-running trade openly
- Resolver npm package — ~50 lines plus the rendering CSS from §4.3,
  shipping the default resolver and anchor-publisher lists and enforcing
  the §8.5 quorum by default
- Anchoring contract (optional)

---

## 15. Positioning

The registry is MIT by competition rule, so it is forkable. The defence is not
secrecy:

- A **free** registry is a broken registry — and now there is a sharper
  version of the argument: free registration destroys the verifiability that
  makes the registry trustworthy at all (§8.2). Cheap is a feature; free is a
  vulnerability.
- Value lives in **resolution, not registration**. A rival namespace nothing
  resolves is an inert database.
- Every mini app that adopts the resolver package raises the switching cost.
  Shipping the package to other Cycle II entrants is the highest-leverage
  defensive move available.
- **Every exchange that delegates a subdomain is a lock-in point.** Once
  `user.exchange` addresses are in circulation, a fork starts from zero.
- Gifting names to ecosystem figures populates the namespace with exactly the
  entries that make a fork look empty.

### Recruiting independent indexers

Capability is solved — validators and the Nimiq team already run history
nodes, so participation costs a container and an RPC URL. Motivation still
needs engineering:

- **A free premium name** for verified operators
- **A public list of independent indexers** with their published roots. The
  list is itself the trust artifact.
- **Something they want anyway** — pool operators can resolve names in their
  own staker dashboards off their local indexer.
- **A publisher slot.** An independent indexer that anchors its own roots
  (§9) is not just verifying the project's claims, it is a party to the
  trust guarantee — and its users get quorum without depending on us.
- **Pinning the log** (§8.2) — cheap, and it keeps Tier 1 verification
  alive independently of this project's infrastructure.

Approaching the Nimiq team early matters less for endorsement than for
intelligence: the one threat that beats distribution is an official name
service. Ask for something small and concrete — *would you run a verifying
indexer?*, or *would you hold a signer on the anchor multisig?* — rather
than a blessing. Both are cheap for them, and either one materially removes
the project from its own trust model.

---

## 16. Deferred to v2

Everything here was designed, argued through, and deliberately left out of
v1. It is recorded so the analysis survives, and so a later revision starts
from conclusions rather than from scratch. The common thread: each is a rule
that every independent implementation must match exactly, and none of them
defends against something that has happened yet.

### 16.1 Name reveal (anti-MEV registration)

§6.2 accepts front-running on the grounds that prizes are thin and Nimiq's
mempool is quiet. Both premises are contingent, and the trigger conditions
are already written there.

The intended mechanism is a soft commitment rather than full commit–reveal:
`G` carries `keccak256(name ‖ salt)`, and a second message reveals the name.
A 32-byte digest is 43 characters in base64url, so the committing message
fits the 64-byte budget comfortably. Cost: two transactions and a wait, on
the operation that most needs to feel instant — which is exactly why it is
not in v1.

### 16.2 Pricing signalling messages

`G`, `N` and `O` are priced by their own fee. `K`, `D`, `E`, `S` and `X` are
not, so a name owner can emit them repeatedly at dust cost. Three mechanisms
were considered:

- **A `SIGNAL_FEE` in `value`**, for messages addressed to
  `PROTOCOL_ADDRESS`. Works for `K`, `D`, `E`, `P` and a releasing `U`. Does
  **not** work for `S`, `X` — or, since r17, an awarding `U`: their
  recipient is the counterparty — usually the user's own other address — so
  the fee would be money moving between one person's pockets, or in the award's
  case a fee paid to the person being given a name.
- **A fee-field gate — the preferred mechanism.** Network fees go to the
  validators: pooled per batch and paid out at the next macro block (Nimiq
  team, 2026-08-13). The money leaves the system entirely, so nothing
  accumulates at `PROTOCOL_ADDRESS`, there is no periodic burn to run and no
  `F` ceremony to audit. An earlier draft called this blocked by
  size-derived fee tiers topping out around 276 luna — that was the **web
  wallet**, not Nimiq Pay. The mini-app provider's `sendBasicTransaction`
  takes a `fee` parameter, while the native Nimiq Pay UI sets the fee to 0
  and does not let a user edit it — so whether a mini-app-supplied fee
  survives to signing is the open question (§12), answerable with one send
  test once consensus returns.
- **A companion message.** `S` keeps the counterparty as recipient, and a
  second message to `PROTOCOL_ADDRESS` carries the fee plus the `S`
  transaction hash; only paired messages are logged. This is the fallback
  that prices `S` without weakening §5.3's trusted-UI property should the
  fee test fail, at the cost of two signatures per retarget and a
  pending-match set in the indexer.

The signalling fee and the companion message would both make
`PROTOCOL_ADDRESS` accumulate value, which §10.2 would then burn in full.
The fee gate is preferred precisely because it does neither: the fee is out
of the system the moment the transaction lands, with no balance anywhere
the operator has to be trusted to sweep.

### 16.3 Rate limiting and backoff

A per-name window (one logged state change per `CHECKPOINT_INTERVAL`) plus
exponential backoff — the window doubling per change within a trailing day,
resetting after a quiet one — caps a spamming name at roughly ten log lines
a day. Rejected for v1 because it adds a committed per-name counter to
consensus state, and because pricing is strictly better than delay: it never
makes an honest user wait.

**The residual v1 carries**, stated plainly: spam capacity scales with names
owned, each costing a registration fee. Roughly $200 of names sustains about
6.5 GB of log growth a year. It is bounded, paid, and obvious in the log —
and §10.6 can raise `FEE_BASE` within a week, multiplying attacker cost while
barely touching real users. No permissionless append-only log closes this;
anyone may pay to write.

### 16.4 Log compaction

§8.8 segments the log without ever deleting from it. If compaction is added,
one rule keeps it safe: a line may be omitted only when its verdict is
terminal *and* any obligation it created is discharged — a `REFUND` line
stays until its `M` exists — and the uncompacted segment keeps its own CID so
the compaction itself remains checkable.

Note that deleting *invalid* messages, the intuitive move, is the wrong one
twice over: the spam that matters is valid, and rejection lines are what let
an independent replay confirm a rejection was correct rather than infer it
from an absence (§7.4).

### 16.5 Signed delegate responses

The format is already fixed in §8.6 so delegates can opt in without a spec
revision. v1 requires neither producing nor verifying it.

**Amended in r23:** the signed payload gained the `parent`. Fixing a format
early is only worth anything if it is also fixed *correctly*, and the omission
let a signed answer replay between two names one owner holds. It cost nothing
to change because nothing implements it — no signer, no verifier, no delegate
emitting the fields — and it would have cost a revision the moment one did.

**A second gap in this format is still open**, and it is why v1 cannot adopt
the scheme even if it wanted to: the signature is by "the parent's owner key",
the response carries no public key, and NNS state holds only the owner's
*address*, which is a hash of that key. There is nothing to verify against.
Closing it needs either a public key in the response or a key in the record;
that is a v2 design question, not an omission to patch here.

### 16.6 Richer records

Avatars, text records, Nostr keys and similar belong at the delegate
resolver (§8.6), not in transaction data. The 64-byte budget is not the
constraint people assume it is: the owner designates a host, and the host
serves whatever it likes. What v2 would add is a *convention* for those
records, so clients agree on their shape — not new on-chain state.
