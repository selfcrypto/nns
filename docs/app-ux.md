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
│ nns.  names on Nimiq       │  masthead — HIDDEN inside Pay, whose bar names us
├────────────────────────────┤
│                            │
│         screen             │  one screen at a time, vertical scroll
│                            │
├────────────────────────────┤
│ ◉ NQ52 A3NY … KF8N   Disconnect │  identity row — the only connect UI
├────────────────────────────┤
│ Buy/Search Pay My Names Inbox Market │  tab bar, thumb row
├────────────────────────────┤
│ ······ host chrome ······· │  --chrome-bottom (Android's 48dp nav bar)
└────────────────────────────┘
```

**Nothing interactive goes in the top strip.** The frame is `min-height: 100dvh`
with `--chrome-top` / `--chrome-bottom` as padding and a tab bar sticky to
`bottom: var(--chrome-bottom)`; `lib/chrome.ts` computes both and argues the
numbers. Two earlier attempts to reason about that WebView from a desktop got
both ends wrong in opposite directions — a `position: fixed; inset: 0` frame
pushed the tab bar *further* off the bottom, because a fixed element's
containing block is the layout viewport and Pay reports it taller than `100dvh`
does. Every number in that file is now measured from a device screenshot, and
`?chrome=<top>,<bottom>` and `?diag=1` exist so the next one can be too.

Five tabs, and the first two are named for jobs rather than mechanisms:
**Buy/Search** is discovery and acquisition, **Pay** sends NIM to a name.
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

**Buy offers acquisition only** — `register` and `buy`. A name one of the
viewer's addresses owns gets "You own this name." and a **Manage it** button that
hands off to My names, because acquiring and managing are different jobs and a
screen called Buy offering to transfer your own name away is a contradiction. The
owner's six (`setTarget`, `transfer`, `delegate`, `renew`, `offer`, `cancel`) are
not rendered here at all. Legality is unchanged: `actionGates` and `signerFor`
still decide what is possible — this decides what the screen is *for*.

- **Taken name (resolved card)** gains a **"Message the owner"** row — the
  chat entry point (`docs/app-chat.md`). Opens the composer prefilled with
  the name; not offered when the viewer owns it, which is the handoff instead.
- **Available name** card's Register row becomes the `G` flow (§5) when
  sends enable.

## 3. My names / Pay / Inbox / Market

**My names**: rows sorted soonest-expiry first; urgency badges (renew-due
from 60 days, grace with grace-end date). **Row → that name's card in place**,
with a back link to the list — it does not change tab, because this is where
management happens. The card is the same component Buy renders
(`components/NameCard.tsx`), given the owner action list instead of the
acquisition one. When sends enable, a *Renew* shortcut rides on due/grace rows.

Identity does **not** live on this screen. It is one row above the tab bar
(`components/IdentityBar.tsx`), on every tab: the acting address with its
identicon, **Disconnect** beside it, and — tapping the address — the rest of the
set plus *Add another address* on the Hub. It was in the masthead and at the
foot of this screen at once, which is two copies of one control; it is at the
bottom now because that is the row a thumb reaches and it is nowhere near a
host's chrome (Kike, 2026-08-22).

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

**Market**: offer rows (name, price, seller identicon+address, expiry).
Row → detail card. *Buy* enters the `B` flow (§5); until then the custodial
disclosure rides on the listing, as now.

### Pay — one payment to a name

Type a name, it resolves on the same settle as Buy, enter an amount in NIM, the
wallet signs. Nothing else: no NNS message, no registry effect.

```
name → resolve() → pin check → amount → wallet signs → confirm by tx hash
```

Four things are specific to it, and three are refusals:

- **The address comes from `search()`**, so `resolver().resolve()` remains the
  only producer of an address in the app. Every non-resolved outcome renders the
  shared card, which already words reserved, available, grace, delegate failure
  and alarm — none of which is payable.
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
  one of the relay's four methods) before saying anything negative:

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

| Flow | Compose needs | Review must say | Effect that confirms it |
|---|---|---|---|
| `G` register | `/params` fee (exact §10.5), availability with non-inclusion proof | Price and term as ≈ date; race possibility; pending fee change if scheduled | `/name` shows the record, owner = me |
| `N` renew | `/params` fee | New expiry = current + 1 y (from expiry, not from now — early renewal never penalised) | `/name` expiry moved |
| `S` set target | Target address (or "point back at me" → `PROTOCOL_ADDRESS` sentinel) | Where payments will go; pin note if target was pinned by others | `/resolve` answers the new target |
| `X` transfer | Recipient address | ~12 h timelock as ≈ date; cancellable with `K` until then; a second `X` restarts; **not** anti-theft wording | `/name` pending.transfer set |
| `D` delegate | Host (`validateHost`; name+host ≤ 52) or empty to clear | What subdomains will do; that the host answers unproven | `/name` host set/cleared |
| `K` cancel | Non-empty cancellable set | **Lists everything** it will cancel — one `K` cancels all of it | `/name` pending cleared |
| `O` offer | Price ≥ `minPrice` from `/params` | Irrevocable ~2.4 h; auto-expiry ~15 d; commission on sale | `/name` pending.offer set |
| `B` buy | Open offer; value = price exactly | Name, price, seller (the sheet won't); **custodial warning, explicit confirm, every time** | `/name` owner = me |
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
