# App states and wording

Every state a name can be in, every resolution outcome, and the required
wording for each. `packages/app` is designed against this document; screens
render these states and no others, and the wording rules in §5 are **already
decided** — in the spec (§8.5, §8.7, §10.4), in `packages/resolver/README.md`
(the launch-quorum and "Verified by N resolvers" decisions of 2026-08-14),
and in `docs/decisions.md`. Nothing here invents; it collects, so a component
author never has to.

Strings live in `src/lib/wording.ts`, keyed by the state names below. A
screen that needs a sentence this document does not define is a screen that
needs this document amended first.

Heights render as approximate dates (`≈`): blocks are ~1 s but not exactly,
so a date computed from a height is an estimate and must read as one.

---

## 1. Name states — what the chain says

Learned from `/name/{name}` (`reserved`, `unreserved`, `record`, `pending`)
plus `available()`/`resolve()` for anything shown as an answer. §7.3 is the
authority; every window is half-open, `[start, end)`.

| State | Recognised by | Required wording / treatment |
|---|---|---|
| **AVAILABLE** | `available()` returns with a non-inclusion proof; not reserved | "Available" with the current band fee from `/params`. Register CTA. The non-inclusion proof is a spec MUST before any registration is offered |
| **REGISTERED** | `record.status = REGISTERED` | The normal case. Detail screen: target + identicon, verification badge (§2), expiry as ≈ date |
| **GRACE** | `record.status = GRACE` | "Expired — in grace until ≈ date." The name does **not** resolve and dotted queries under it fail, but it is **not free**: renewal still works (by anyone) until `expiry + GRACE_PERIOD`, at which height it is AVAILABLE and the record is gone. Never word grace as "gone" or as "available soon" — both invite a mistake |
| **RESERVED** | `/name` `reserved: true`, no record | "Reserved." Not registrable — a `G` forfeits `RESERVED_NAME`. Short names (1–4 chars) are reserved **by rule**, same wording. No register CTA, ever |
| **Released** (fired `U`, no record) | `unreserved: true`, `record: null`, `available()` ok | Ordinary AVAILABLE. The fired-`U` flag is not a user-facing fact |
| **Awarded** (fired `U`, record) | `unreserved: true` + record | Ordinary REGISTERED. Same — no special treatment |

**Half-open arithmetic the UI must get right:** the last block a name
resolves is `expiry - 1`; it is in GRACE **at** `expiry`; it is AVAILABLE at
`expiry + GRACE_PERIOD`, which is the first block a `G` can succeed and the
first at which an `N` earns `NAME_NOT_FOUND`.

### Overlays on REGISTERED

| Overlay | Recognised by | Wording / treatment |
|---|---|---|
| **Pending transfer** | `pending.transfer` | "Transferring to `<newOwner>` ≈ date" (matures at `effectiveHeight` = send height + `XFER_TIMELOCK`, ~12 h). Until maturity the name resolves as before and the current owner retains full control. Cancellable with `K`. A second `X` supersedes and restarts the clock |
| **Open offer** | `pending.offer` | "For sale at `<price>` NIM." Irrevocable until `openedHeight + OFFER_IRREVOCABLE` (~2.4 h) — show that plainly to the seller *before* §4's `O` is sent and while it holds; cancellable with `K` after; auto-expires at `openedHeight + OFFER_MAX_LIFETIME` (~15 d) |
| **Pending fee change** | `/params` `pendingGovernance` | Registration/renewal price display shows the change and its ≈ effective date when one is scheduled. Not a name overlay strictly, but it bites anyone about to pay |

On a transfer taking effect (`X` maturity or a winning `B`): owner and target
both become the new owner, the delegate host is cleared, open offers are
cancelled, any pending `X` is void. On entering GRACE: host cleared, offers
and pending `X` cancelled. The detail screen must not keep showing state the
reset has already destroyed.

---

## 2. Resolution outcomes — what `resolve()` / `available()` return

### `verification` (three values, no fourth)

| Value | Required treatment |
|---|---|
| `PROVEN` | The normal, good case. Carries the §5 "Verified by N resolvers" line |
| `PROOF_PENDING` | **Depth, not alarm.** "Proof pending — checkpoints are cut every ~12 minutes." The name resolves and payments work (§8.7). No red, no warning glyph. This is the expected state of every fresh registration |
| `DELEGATED` | **Visibly different from both.** "Resolved by `<parent>`" — the parent is proven, the address is the host's word. Never rendered identically to a proven answer (§8.5 #6). The identicon still renders (it is honest about the address), with the distinction carried alongside |

`TARGET_CHANGED_SINCE_CHECKPOINT` (a proof verified, but for the previous
address): treat as `PROOF_PENDING` — depth wording, and **never** "verified
on-chain", which would be false about the address the user is about to pay.

### Warnings (ride on `result.warnings`; none stop a resolution)

| Code | Tone |
|---|---|
| `QUORUM_BELOW_SPEC` | Informational and permanent while true — covered by the §5 quorum line, which discloses the count on every answer |
| `PROOF_PENDING` | Depth. Neutral |
| `TARGET_CHANGED_SINCE_CHECKPOINT` | Depth. Neutral. Not "verified" |
| `DELEGATE_HOST_UNPROVEN` | Informational |
| `DELEGATED_ANSWER` | The §8.5 #6 distinction above |
| `ROOT_HEIGHTS_DIFFER` | "Couldn't check" — the cross-height comparison did not complete. Names which resolver and why. Not a disagreement (disagreements throw) |
| `ANCHOR_NOT_CHECKED` | **Quiet status, not a warning.** Nothing was found wrong; the check did not run. This is the standing state while `ANCHOR_PUBLISHERS` ships empty |
| `ANCHOR_UNAVAILABLE` | "Couldn't check" |
| `ANCHOR_QUORUM_NOT_MET` | Depth — the standing state for the first hours after every checkpoint |
| `ANCHOR_STALE` | "Couldn't check" — the client cannot tell "nothing changed" from "the publisher stopped" |

### Halting errors

| Error | Rendering |
|---|---|
| `NameError` `NAME_INVALID` | Field-level, before any network call, with the §4.1 reason in plain words (§3 below) |
| `LookupError` `NOT_FOUND` | The name has no record — offer the availability check / register path |
| `LookupError` `IN_GRACE` | The GRACE wording of §1 |
| `QuorumError` (`QUORUM_UNMET`, `QUORUM_DISAGREEMENT`, `QUORUM_ROOT_MISMATCH`) | **Alarm tier** for the disagreement forms — resolvers said different things; show which party said what (`.replies`) and do not answer. `QUORUM_UNMET` (too few answered) is an availability failure: "couldn't reach enough resolvers", retry, no alarm vocabulary |
| `ProofError` | **Alarm tier.** A served proof did not hold. Do not show an address |
| `AnchorError` (`CHECKPOINT_BINDING_INVALID`, `ANCHOR_MISMATCH`, `ANCHOR_DIVERGENCE`) | **Alarm tier.** Surface the conflict and stop resolving (§8.5 #7) |
| `DocumentError` | A resolver served a malformed reply — an operator fault, worded as one. Retryable |
| `DelegateError` `PARENT_NOT_DELEGATING` | "`<parent>` doesn't delegate subdomains." The parent's own resolution (`.parent`) is verified — show it |
| `DelegateError` `DELEGATE_FAILED` | **Attribute to the host, never to the subdomain**: "`<parent>`'s resolver did not answer." Show `.parent` — the proven half survives — so the failure renders beside a verified base name, never as NNS being down. *"`label.parent` does not exist" is forbidden wording*: a 404, a timeout, DNS, TLS and a wrong-shaped body all arrive as this one code, and NNS is never entitled to say whether a subdomain exists |

### Pinning states (§8.5 — `lib/pinning.ts` + `PinCheck`)

| State | Treatment |
|---|---|
| First use | Pin `query → address` silently — the full query string, so a dotted query pins its delegated answer too. A quiet "first time you've used this name" note |
| Pin match | Nothing. Silence is the feature |
| **Pin mismatch** | **Alarm tier, hard stop.** "`<name>` pointed to a different address when you last used it." Show both addresses with both identicons. No payment path proceeds without an explicit, deliberate override — a legitimate `S` by the owner is possible, which is why the override exists, and why it must be effortful |

---

## 3. Buy outcomes (the search field)

The search field accepts a name or a dotted query; `core.parseQuery` decides
which. The query itself runs **as typed**, once typing settles; the button only
skips the wait (app-ux §2).

Field-level messages come from `lib/search.ts`'s `queryFault`, never from core's
first failing reason code — that code is `TOO_SHORT` for *any* string under the
floor that also fails rules 2–5, so reading it literally told a user that `??`
and `sud0` were reserved five-character names. Two tones, and the difference is
load-bearing: **red** is "this string can never be a name", **grey** is "this is
a real name, and here is the rule that governs it". Only the second is ever said
about a name a `U` could open.

| Input | Outcome |
|---|---|
| Invalid syntax | Field-level error naming the rule that **actually** failed: too long (> 24), bad character, no letter, leading/trailing/double `-`, a digit between letters, `0`/`1` at either end (§4.2's r6 clause — *not* "digits can only lead or trail"), more than one dot |
| A dot with an empty side (`.`, `.shop`, `shop.`) | Format guidance — `label.name` with an example. Never a rule about the empty half, which is a string the user never typed |
| Under 5 characters, well formed | **Grey note, not an error**: reserved by default, registrable only if deliberately released. The lookup still runs, because a released short name is an ordinary name (§1) |
| Under 5 characters, malformed (`sud0`, `l1do`, `??`) | The broken rule, and **never the word "reserved"** — failing rules 2–5 puts a name on neither membership route, so no `U` can free it: verified, the reducer forfeits `INVALID_NAME` and `encodeUnreserve` refuses to build the message |
| Invalid label (before the dot) | Label wording, which is not name wording: labels floor at **1** character, need no letter, have no digit rule and are never reserved |
| Valid name | One of §1's states, via `resolve()` (falling back to `available()` on `NOT_FOUND`) plus `/name` for the overlays |
| Valid name **the viewer owns** | "You own this name." and a *Manage it* handoff to My names — never the owner actions. Buy offers `register` and `buy`; the owner's six live in My names alone (app-ux §2) |
| Dotted query, parent not registered | The parent's own §1 state, worded about the parent |
| Dotted query, parent has no host | `PARENT_NOT_DELEGATING` wording |
| Dotted query, host answered | `DELEGATED` result, §2 treatment |
| Dotted query, host failed | `DELEGATE_FAILED` wording — host's fault, parent shown verified |

Labels are validated locally too (`core.validateLabel`, 1–24 chars, no
positional digit rule) before any request leaves the device.

---

## 4. Owner-action legality matrix

Gating is **by state, never by owner-equality alone**. "Owner" below means
`record.owner` equals the `listAccounts()` address. Every action is also
gated by `core` validation of its inputs, byte-ceiling preflight, and
consensus being established. `M`, `P`, `U`, `F` never appear in the app.

| Action | Who | Legal when | Never when | Notes |
|---|---|---|---|---|
| `G` register | Anyone | Name AVAILABLE (incl. released-by-`U`) | REGISTERED (`LOST_REGISTRATION_RACE` — a refund, but the UI never offers it), GRACE (`NAME_IN_GRACE`), reserved (`RESERVED_NAME`) | Value = the band fee from `/params` **exactly** (§10.5). A same-block race is possible even after an availability check (`LOST_REGISTRATION_RACE` refunds) |
| `S` set target | Owner | REGISTERED | GRACE, absent (`NAME_NOT_REGISTERED`) | Legal with a pending `X` — the owner retains control until maturity. Reset-to-self routes to `PROTOCOL_ADDRESS` (§5.3 sentinel); the UI offers it as "point back at my address" |
| `X` transfer | Owner | REGISTERED | GRACE, absent | Matures at height + `XFER_TIMELOCK` (~12 h). A second `X` supersedes the first and restarts the clock. The timelock guards a mistyped recipient, not a thief — never describe it as security against a stolen key |
| `D` delegate | Owner | REGISTERED | GRACE, absent | Host per §6 `D` (`core.validateHost`); name + host ≤ 52 chars combined. Empty host clears delegation |
| `K` cancel | Owner | Cancellable set non-empty: a pending `X`, or an offer past `OFFER_IRREVOCABLE` | Nothing cancellable (`NOTHING_TO_CANCEL`) — incl. all of GRACE, whose entry already cancelled everything | One `K` cancels **everything** currently cancellable; the confirm step lists what will go |
| `N` renew | **Anyone** | REGISTERED or GRACE | AVAILABLE (`NAME_NOT_FOUND` — the record is gone) | Extends from current expiry, not from now — early renewal is never penalised; say so. Value = band fee exactly |
| `O` offer | Owner | REGISTERED, no open offer | GRACE, absent | Price ≥ `minPrice` (`FEE_LONG` at the current height, from `/params` — never a constant). Carries `DUST_VALUE` (listing fee is 0). Disclose the irrevocable window **before** sending |
| `B` buy | Anyone (the buyer) | Offer open | No open offer / expired (`OFFER_NOT_OPEN`) | Value = offer price **exactly**. Custodial warning (§8.5 #10) with explicit confirmation, every time. The wallet dialog shows the marketplace address, so the app itself presents name, price and seller (§5.3) |

**Cross-cutting:** a returned hash is not confirmation — three silent-drop
routes (§5.3). Every send is followed by polling the API until the effect
appears; the honest failure wording is "not confirmed — the network did not
include this transaction", never "sent".

---

## 5. Standing wording rules

1. **"Verified by N resolvers"** — one neutral line, always present on a
   successful proven resolution. `N` is `result.quorum.agreed`; singular at
   1; **name the operator when N = 1**. Never hidden, greyed or apologetic.
2. **Never label a quorum-1 answer "unverified".** The proof verified; what
   is absent is corroboration by a second party, which is a different
   sentence. Alarm vocabulary spends down to zero the first time it is used
   on a non-alarm.
3. **Alarm vocabulary** (red, warning glyphs, "do not pay", "divergence") is
   reserved for the halting failures: a proof that did not verify, quorum
   disagreement/root mismatch, `CHECKPOINT_BINDING_INVALID`,
   `ANCHOR_MISMATCH`, `ANCHOR_DIVERGENCE`, and a pin mismatch. Everything
   else is "couldn't check" or pending depth — never "wrong".
4. **NNS never reports whether a subdomain exists.** Delegate failures are
   attributed to the host, beside the parent's verified resolution.
5. **Delegated answers are never rendered identically to proven ones.**
6. **`ANCHOR_NOT_CHECKED` is a quiet status**, not a warning — the standing
   state while the publisher list ships empty.
7. **Depth is depth** (§8.7): a fresh name works at finality; the checkpoint
   (~12 min) and anchor (~1 h) clocks add verification depth to a name that
   already functions. A user who just paid must never be told something is
   wrong with their name.
8. **Renewal reminder** (§10.4, non-deferrable): approaching expiry surfaces
   prominently, in-app, from `GRACE_PERIOD` × 2 — 60 days — before the date.
9. **Names render in the §4.3 CSS** (`@nns/resolver/rendering.css`,
   `nns-name` class) wherever shown or typed, with the **Nimiq identicon of
   the resolved address** beside any address a user might pay — it is a
   picture of what will actually be paid.
10. **Grace is neither gone nor free** — see §1's GRACE wording.

---

## 6. Screens × states

| Screen | Must render |
|---|---|
| **Buy** | Every §3 outcome; every §2 verification value, warning tone and halting error; §1 states with overlays. Acquisition actions only — a name the viewer owns is the handoff, not the toolbox |
| **Name detail** (in My names; one component, shared with Buy) | §1 REGISTERED/GRACE with all overlays; §2 badges; expiry ≈ date; renewal reminder from 60 d; owner actions gated per §4 (visible but disabled states carry the *reason* they are disabled) |
| **My names** | `/address/{addr}/names` (REGISTERED and GRACE); expiry sort; the 60-day reminder; empty state ("no names yet") and the no-wallet state; a row opens that name's detail **in place**; Connect Wallet / Add another address / Disconnect |
| **Pay** | §7 |
| **Inbox** (NC chat, `docs/app-chat.md`) | Threads keyed (peer, name), owned-name threads first and the rest muted; messages as plain text from an **address**, never a reverse-resolved name; the honest history window ("since ≈ date"); the composer with byte budget, the public-forever notice, and the "this name is yours" refusal; setup states for no wallet / no history endpoint |
| **Marketplace** | `/offers`; each offer's name, price, seller (with identicon); the custodial nature disclosed on the buy path (§4 `B`) |

Send flows (`G S X D K N O B` confirmations and the post-send confirm loop)
are specified by §4 and §5 but blocked on the value/fee probe — see
`packages/app/CLAUDE.md`, "Open".

## 7. Pay states (app-ux §3)

Paying is the one send that never passes through `core`'s `build()`, so two of
its refusals exist nowhere else in the app and both failures are silent on-chain.

| State | Wording / behaviour |
|---|---|
| Nothing typed | "Pay a name" empty state |
| Resolving | spinner; the query settles first, as in Buy |
| Not a resolvable name | the §3 card for whatever it is — reserved, available, in grace, delegate failure, alarm. None is payable, and no amount field is shown |
| Resolved | the name, the pin check, the address, an amount field, and a Pay button that names the amount |
| **Pin mismatch** | the §2 alarm card, **and the Pay button is disabled** until the two-step override is taken. "Do not pay until you know which" is the existing wording; the button has to mean it |
| Amount not a NIM decimal | the field's own reason (five decimals is the floor — below luna) |
| Amount zero | "Enter an amount above zero." The network rejects a zero value outright (§5.4) |
| The name points at the payer | refused before the wallet opens: Nimiq accepts a self-transaction at the RPC, returns a hash, and drops it — nothing downstream would ever report it |
| Sending | the §4 send machine's lines, unchanged; confirmation is the transaction by hash, since a payment leaves no registry effect |
| Nimiq Pay | probe-gated (§10.5): `payProbeGatedLine()`. Hub sends today |
