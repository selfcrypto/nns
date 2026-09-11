# App UX — navigation, screens, and every flow

The build map for `packages/app`. States and wording are fixed by
`docs/app-states.md`; the NC message convention by `docs/app-chat.md`. This
document fixes the rest: navigation, what each screen contains, and the
exact shape of every flow — including the send flows, specified now so that
when a post-fork Nimiq Pay build ships, enabling them is wiring, not design.

Portrait, one-handed, WebView. Everything reachable from a bottom tab bar;
nothing more than two taps deep.

## 1. Frame

```
┌────────────────────────────┐
│ ······ host chrome ······· │  --chrome-top (env only; 0 where the host insets)
├────────────────────────────┤
│ nns.  names…   ◉ NQ52 … KF8N ▾ │  masthead — wordmark, and the connector
├────────────────────────────┤     in the corner: the only connect UI
│                            │
│         screen             │  one screen at a time, vertical scroll
│                            │
├────────────────────────────┤
│ Buy/Search Pay My Names Inbox Market │  tab bar, thumb row
├────────────────────────────┤
│ ······ host chrome ······· │  --chrome-bottom (live viewport slack)
└────────────────────────────┘
```

**The connector is the one interactive thing in the top strip**, and it is
there because the strip is finally trustworthy: `--chrome-top` was a bogus
48 px reserve, then a grey band, before a device screenshot settled it at
`env(safe-area-inset-top)` outside Pay and **0** inside it. The frame is
`min-height: 100svh` with `--chrome-top` / `--chrome-bottom` as padding and a
tab bar sticky to `bottom: var(--chrome-bottom)`; `lib/chrome.ts` computes both
and argues the numbers. Two earlier attempts to reason about that WebView from a desktop got
both ends wrong in opposite directions — a `position: fixed; inset: 0` frame
pushed the tab bar *further* off the bottom, because a fixed element's
containing block is the layout viewport and Pay reports it taller than `100dvh`
does. The bottom reserve is measured **live** since 2026-08-23 —
`viewportSlack`, the layout viewport's excess over the visual one, re-read
whenever no keyboard is up — because the screenshot-measured 120 was right
for one day and a 120 px dead band the next; the constant survives only as
the fallback where `visualViewport` does not exist. The tab bar hides while
an on-screen keyboard is up (`data-keyboard`, both keyboard modes detected).
`?chrome=<top>,<bottom>` and `?diag=1` remain the on-device instruments.

**A browser opens on a landing page first** (`screens/Home.tsx`, since
2026-09-07, Bakar's PR #1): marketing, full-width, the tab bar hidden, and
one way in — its search hands the query to Buy. Inside Nimiq Pay the
person already chose the app, so the front door there is Buy
(`isHostedWebView`, corrected by `detectWallet` if the provider arrived
late). The wordmark returns to the landing page.

**The screen is the URL hash** (`lib/route.ts`, 2026-09-09, Bakar's
suggestion): `#/buy/nns`, `#/pay/rico.nns`, `#/names/nns` (a name handed to
My names), `#/market/indigo` (a listing to open), `#/inbox`, `#/home`. A
reload and a shared link land where the person was; the WebView's back
button has something to pop; Buy and Pay reflect their settled query into
the hash so the card survives a reload. The hash rather than the path
because `deploy/service`'s nginx deliberately 404s an unknown path and
every independent host would need the same rewrite; no router library
(decisions.md, "Routes are the hash, and the hash is one function pair").

Five tabs, and the first two are named for jobs rather than mechanisms:
**Buy/Search** is discovery and acquisition, **Pay** sends NIM to a name —
and, since 2026-08-23, **USDT over Polygon** to the name's §6 `E` record: an
asset switch on the screen, the same verified resolve (`result.evm`, checked
against the proven leaf on the same terms as the target), and the send handed
to whatever EIP-1193 wallet the environment offers as a plain ERC-20
`transfer` — the dApp path, no EVM key or Polygon RPC in the app. A name
without an `E` record says so and is not payable in that mode. The wallet's
returned hash is never called confirmation; the result line names the wallet
as the actor and links Polygonscan.
Management of what you already own is **My Names** and lives nowhere else — a
name you own is never handled from Buy (§2). No hamburger, no settings screen in v1 — the app has no
user-configurable state except the client-side hidden-senders list (managed
inline from a thread). The proof rail (card left edge:
solid green proven · dashed slate depth · dotted indigo delegated · red
alarm) is the one visual device and appears identically everywhere.

## 2. Buy — the front door

Input accepts a name or `label.name`. **The query runs as typed**, one second
after typing stops, and the button only skips that wait — so an answer arrives
without pressing anything, and a name whose fate is chain state (a short name a
`U` may have released) is never refused by the client to save a round trip.

The one-second settle is not cosmetic. It is what keeps a word typed at speed to
a single query — each one verifies a Merkle proof, and `/api/` rate-limits
nothing — and it is also what stops the field hint scolding a half-typed name.
Hints are computed off the settled value for that reason. Outcomes are
`docs/app-states.md` §3, each a card. Beyond what is built today:

**Buy offers acquisition — and one gift.** `register` as a full-width action that
opens the `G` sheet; **Gift a renewal** (`N`, which anyone may send, §6) on a
registered or grace name the viewer does not hold, with a review line saying
the name stays its owner's (Kike, 2026-09-09); and for a name that is for sale or under auction a line
saying so with **Check now.**, which hands the name to Market
(`#/market/<name>`), where the `B` flow lives since the redesign (2026-09-09,
Bakar's PR #2; `buy` and `bid` are never both, because state says which a
`B` is, §6 `A`). A name one of the viewer's addresses owns gets "You own
this" and a **Manage** button that hands off to My names, because acquiring
and managing are different jobs and a screen called Buy offering to transfer
your own name away is a contradiction. The owner's eight (`setTarget`,
`setEvm`, `transfer`, `delegate`, `renew`, `offer`, `auction`, `cancel`) are
not rendered here at all. Legality is unchanged: `actionGates` and
`signerFor` still decide what is possible — this decides what the screen is
*for*.

- **Taken name (resolved card)** gains a **"Message the owner"** button — the
  chat entry point (`docs/app-chat.md`). Opens a bottom sheet
  (`components/MessageModal.tsx`) around the one composer, prefilled with the
  name; not offered when the viewer owns it, which is the handoff instead.
- Every resolved card — Buy's included — carries the verification line
  (§8.5 #6): who verified, by name and URL, or that a delegate answered.

## 3. My names / Pay / Inbox / Market

**My names**: rows sorted soonest-expiry first; urgency badges (renew-due
from 60 days, grace with grace-end date). **Row → that name's card in place**,
with a back link to the list — it does not change tab, because this is where
management happens. The card is the same component Buy renders
(`components/NameCard.tsx`), given the owner action list instead of the
acquisition one: since the redesign the eight are tiles in three groups
(routing & records, ownership & renewal, marketplace), each showing the
current value, and a tile opens its sheet as a bottom sheet over the page.
A tile the legality matrix gates stays on screen with its reason; only a
missing wallet turns a tile into *connect*.

Identity does **not** live on this screen. It is one control
(`components/IdentityBar.tsx`), on every tab, in the masthead's right corner:
the acting address with its identicon, and — tapping it — the rest of the set,
*Add another address* on the Hub, and **Disconnect**. It was in the masthead
and at the foot of this screen at once, which is two copies of one control, and
that is what stopped; where the surviving copy sits is its `placement` prop.
It spent one build above the tab bar, on the argument that the top strip was
the part of the screen we had been wrong about three times — and moved back to
the corner once the chrome reserves were measured rather than reasoned about
(Kike, 2026-08-22). In the corner the collapsed control is the address alone:
there is room for one thing up there, and the address is the one that has to
stay legible.

**Both adapters connect and disconnect.** The Pay path shipped with neither, on
the reasoning that the host's account set is unconditional. What that produced
was a user who had accepted Pay's prompt and could find no way back out, and a
*declined* prompt that fell through to the **Hub** connector — a desktop web
wallet, offered inside Pay's own WebView. So `detectWallet` only falls back to
the Hub outside a hosted WebView, and Pay's `disconnect` is device-local: it
stops this app using the accounts and says exactly that, because Pay offers no
revocation to wrap.

**Inbox** (new tab): thread list → thread → composer.

- Conversation list: **one row per peer** — identicon, the names that address
  holds (reverse-resolved from `/address/{addr}/names`, `REGISTERED` only,
  shortest first, overflow as "+N more"), the address beneath, last message
  preview (plain text), date. No buckets. Hidden senders collapse into
  "Hidden (n)" at the foot. Footer states the honest window: "messages since
  ≈ <date>".
- Conversation: bubbles by direction — theirs left on card white, yours right
  on the accent tint (never the proof rail's green or grey, which mean
  "proven" and "pending depth" everywhere else). The subject is announced
  inside the conversation as "about <name>", once and again wherever it
  changes; a reply carries the newest subject. The header is the peer's names
  **over their own address**, never the subject name — that pairing reads as
  "this address is that name" and was exactly the bug the redesign fixed. An
  incoming message whose name is not one of yours carries a muted note; an
  outgoing one never does. Per-conversation action: hide sender (local).
- Composer: byte counter counting **UTF-8 bytes** against
  `64 − 4 − len(name)`; the public-forever notice on first use; send
  disabled behind the same gate as every send.
- No history endpoint configured (`VITE_NNS_HISTORY` unset): a setup
  empty-state naming the variable, same pattern as the resolver setup
  screen.

**Market**: offer rows (name, price, seller identicon+address, expiry) and,
since r28, auction rows (name with an *Auction* badge, the standing bid or
the starting price, "No bids yet" or the highest bid, the minimum next bid, seller,
"ends ≈ date") in one list — a buyer is looking for a name, not a mechanism.
*Buy* or *Bid* opens the `B` sheet (§5) under the listing — never both,
because state decides which a `B` is — with the name's proof above it: the
address, the verification line and the pin check, the same three the Buy
card shows, so nobody pays for a name they have not seen verified. The
custodial disclosure rides on the listing as well, and the §10.2 burn
figures (`components/BurnFigures.tsx`) sit under it — Market is the app
path's home for them, because Pay never opens the landing page.

### Pay — one payment to a name

Type a name, it resolves on the same settle as Buy, enter an amount — NIM by
default, or **USDT over Polygon** via the asset switch (since 2026-08-23; the
mechanism is §1's intro: `result.evm`, the dApp path, a plain ERC-20
`transfer`) — and the wallet signs. Nothing else: no NNS message, no registry
effect. The USDT mode changes none of this section's shape: same resolve,
same pin check, a different asset and signer.

```
name → resolve() → pin check → amount → wallet signs → confirm by tx hash
```

Four things are specific to it, and three are refusals:

- **The address comes from `search()`**, so `resolver().resolve()` remains the
  only producer of an address in the app. Every non-resolved outcome renders the
  shared card, which already words reserved, available, grace, delegate failure
  and alarm — none of which is payable.
  An **available** name gets the same Register button Buy shows, running the
  same `G` flow in the same card (2026-09-10): "Available" with nothing to do
  about it was a dead end, and a handoff to Buy would have landed on a second
  Register button. Only `register` — a listing or a gifted renewal stays Buy's.
- **A pin mismatch stops the button** until the user overrides it. §8.5 requires
  the check on any screen paying a resolved address and CLAUDE.md requires a hard
  stop when a known mapping changes; `pinMismatchBody` already says "do not pay
  until you know which", so the button must honour it. `PinCheck` reports this
  through `onBlocking`.
- **Sender ≠ recipient**, checked here because a payment is the one send that
  never passes through `core`'s `build()`, which enforces it for all eight
  actions. Nimiq accepts a self-transaction at the RPC, answers with a hash, and
  the network drops it — so this screen is the only place it can be reported.
- **Value > 0**, for the same reason: the network rejects a zero value outright.

Confirmation is `getTransactionByHash`, as for chat, because a payment leaves no
registry effect to poll for — and both adapters can now reach it: Pay returns a
32-byte hash to poll with, Hub a hash from the signature it broadcasts. The
§10.5 gate came off on 2026-08-21 (`docs/rpc-reference.md` §8.1).

## 4. The one send state machine

Every send — the eight NNS actions and NC chat — goes through the same four
stages, one implementation:

```
compose ──▶ review (in-app) ──▶ Pay sheet (wallet UI) ──▶ confirm loop
```

- **Compose**: inputs validated by `core` before the button enables
  (builders throw as backstop; byte ceiling preflighted — over-length is a
  silent drop, never a sendable).
- **Review (in-app)**: everything the Pay sheet will *not* show — the name,
  what the action does, the window arithmetic as ≈ dates, and the §5-column
  from the table below. This screen is load-bearing for `B` (the sheet
  shows only the marketplace address) and for every dust send (the sheet
  shows a 1-luna transfer, which explains nothing).
- **Pay sheet**: the wallet's own trusted UI — recipient, identicon, value.
  For `S`/`X` the counterparty is the recipient *so that* this sheet shows
  it (§5.3); the review screen says "check the address on the next screen".
- **Confirm loop**: a returned hash is not confirmation (three silent-drop
  routes, §5.3). What the SDK returns is a 32-byte **hash** — measured
  2026-08-21; the declarations say "serialized transaction" and are wrong —
  or an `ErrorResponse` *value* when the user declines the sheet (never a
  throw). Poll the API (or history, for NC) until the effect appears:
  "Sent — confirming…" → "Done" with the effect named. Never "sent ✓" from
  anything the wallet returned.

  **Running out of poll rounds is not a failure, and must never be phrased
  as one.** The API is served by a batch-scanning indexer, so a registry
  effect becomes visible up to a full batch behind the chain — measured
  2026-08-21, the API's height advances in exact 60-block steps, ~60 s, on
  top of the scan's own poll interval. The window is therefore ~210 s, and
  when it runs out the machine **asks the chain** (`getTransactionByHash`,
  one of the relay's five methods) before saying anything negative:

  | On chain | Ending | What it says |
  |---|---|---|
  | included, executed | `settling` | Confirmed on chain, the registry is catching up. Not a failure |
  | included, did not execute | `rejected` | Included and ineffective; the fee is spent |
  | not found | `unconfirmed` | Hasn't appeared — it may still arrive |
  | could not ask | `unchecked` | Couldn't check; says nothing about the send |

  The old ending said "the network did not include this transaction" on
  nothing but an unanswered effect poll, and said it about a registration
  that was already registered and already listed in "My names". The app
  never observes the network refusing anything — a lagging checker is not a
  negative result any more than a broken one is.

## 5. Per-action flow table

**A sheet opens showing what it is about to change** (2026-08-23): `S` the
current target, `E` the currently linked address (or that none is), `D` the
current host (or that none is set), `N` and `A` the current expiry as `≈ date`
on the ~1 block/s clock (for `A`, because the end has to fall before it), a
bid the standing bid and the minimum next one. Before any input, from the record — the review lines below
still describe the *new* state once inputs are typed.

| Flow | Compose needs | Review must say | Effect that confirms it |
|---|---|---|---|
| `G` register | `/params.fees` figure (exact §10.5) for the chosen term — a year or a lifetime, side by side with their prices — availability with non-inclusion proof | Price and term; a lifetime as the ≈ date it reaches; race possibility; pending fee change if scheduled | `/name` shows the record, owner = me |
| `N` renew | `/params.fees` figure for the chosen term, a year or a lifetime | New expiry as ≈ date = current + the chosen term (from expiry, not from now — early renewal never penalised) | `/name` expiry moved |
| `S` set target | Target address (or "point back at me" → `PROTOCOL_ADDRESS` sentinel) | Where payments will go; pin note if target was pinned by others | `/resolve` answers the new target |
| `E` link EVM address | `0x` address (EIP-55 if mixed-case) or clear; a button fills it from the wallet (silent `eth_accounts` pre-fill, else the `eth_requestAccounts` connect sheet) — the field stays editable and paste always works | The declared address, that it covers every EVM chain, and that the registry records what you declare | `/name` evm set/cleared |
| `X` transfer | Recipient address | ~12 h timelock as ≈ date; cancellable with `K` until then; a second `X` restarts; **not** anti-theft wording | `/name` pending.transfer set |
| `D` delegate | Host (`validateHost`; name+host ≤ 52) or empty to clear | What subdomains will do; that the host answers unproven | `/name` host set/cleared |
| `K` cancel | Non-empty cancellable set | **Lists everything** it will cancel — one `K` cancels all of it — and says what it will **not**: an offer still inside `OFFER_IRREVOCABLE` stays, with the time left on it | The cancelled pendings cleared at `/name` — not the offer the `K` never claimed |
| `O` offer | Price ≥ `minPrice` from `/params` | Irrevocable ~2.4 h; auto-expiry ~15 d; commission on sale | `/name` pending.offer set |
| `B` buy | Open offer; value = price exactly | Name, price, seller (the sheet won't); **custodial warning, explicit confirm, every time** | `/name` owner = me |
| `A` auction (r28) | Starting price ≥ `minPrice` from `/params`; duration in days ≥ ~1 d, the ~1 h landing margin added on top (`states.ts`, `AUCTION_LANDING_MARGIN`) | Starting price and end as ≈ date; neither the auction nor a bid can be withdrawn, a late bid extends it ~10 min; commission on sale; what opening voids (pending `X`, open `O`); **the expiry warning when the end is at or past it** | `/name` pending.auction set |
| `B` bid (r28) | Open auction; value ≥ its `minimumBid` (the API's `core.requiredBid`) | Bid, that escrow holds it until the end (≈ date), extension, the refund reading of a low or outbid bid, seller; **custodial warning in its bid form, explicit confirm, every time** | `/name` pending.auction.bidder = me at my bid |
| NC message | Owner ≠ me; message fits budget | Public-forever notice; dust cost | Own message appears in history |

## 6. Pinning (§8.5) — the remaining read-side piece

IndexedDB, `name → address`, written on first successful resolution shown.
Match: silence. Mismatch: **alarm tier, hard stop** — both addresses, both
identicons, the payment path blocked; the override is explicit and
effortful (states doc §2). Pin check runs on every resolved card and on
every review screen that pays a resolved name.

## 7. Order of work when a Pay build ships

**Superseded in part, 2026-08-16: the Hub adapter went first.** Pay stalled
in store review, and the Nimiq Hub path (desktop web wallet) has no §10.5
probe question — `signTransaction` exists so apps control `value` and
`extraData` exactly, the Hub signs, and the app broadcasts through the
operator RPC endpoint. All eight flows plus NC chat are live on the Hub
adapter behind the one send machine. What remains gated is **Pay's** send
path, and for it the list below stands unchanged.

1. Run `docs/miniapp-probe.html` button 3 (does the sheet honour `value`?).
2. **NC chat send** — immune to the probe's answer (dust; nothing forfeits
   on overpay): enable first, exercise the whole send state machine on the
   cheapest possible message.
3. If the probe says `value` is honoured: dust actions (`S`, `X`, `D`,
   `K`), then fee-bearing (`G`, `N`, `O`), then `B` with the custodial
   confirm.
4. If it says substituted: fee-bearing sends are impossible from the mini
   app — escalate upstream with the probe transcript; dust actions may
   still be viable if the substituted value is only ever ≥ the app's.

Until then: pinning store, the history endpoint deployment, and the Inbox
against it via the `?address=` dev override — none of which wait on Pay.
