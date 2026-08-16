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
│ nns.  names on Nimiq       │  masthead (wordmark; no menu hidden behind it)
├────────────────────────────┤
│                            │
│         screen             │  one screen at a time, vertical scroll
│                            │
├────────────────────────────┤
│ Search  My names  Inbox  Market │  tab bar, thumb row
└────────────────────────────┘
```

Four tabs. No hamburger, no settings screen in v1 — the app has no
user-configurable state except the client-side hidden-senders list (managed
inline from a thread). The proof rail (card left edge:
solid green proven · dashed slate depth · dotted indigo delegated · red
alarm) is the one visual device and appears identically everywhere.

## 2. Search — the front door

Input accepts a name or `label.name`; validated as typed (field-level §4.1
wording); submit resolves. Outcomes are `docs/app-states.md` §3, each a
card. Beyond what is built today:

- **Taken name (resolved card)** gains a **"Message the owner"** row — the
  chat entry point (`docs/app-chat.md`). Opens the composer prefilled with
  the name; refused with "this name is yours" when the viewer owns it.
- **Available name** card's Register row becomes the `G` flow (§5) when
  sends enable.
- Owner actions on a name the viewer owns lead to their flows (§5); each
  row disabled with its gate reason otherwise, exactly as now.

## 3. My names / Inbox / Market

**My names**: rows sorted soonest-expiry first; urgency badges (renew-due
from 60 days, grace with grace-end date). Row → the name's detail card in
Search. When sends enable, a *Renew* shortcut rides on due/grace rows.

**Inbox** (new tab): thread list → thread → composer.

- Thread list: one row per (peer, name) — peer identicon, peer address
  (spaced, ellipsized), the name (mono), last message preview (plain text),
  timestamp. Owned-name threads first; "other messages" (name not owned at
  this address) collapsed below, muted. Footer states the honest window:
  "messages since ≈ <date>".
- Thread: bubbles by direction, timestamps, the name pinned in the header
  beside the peer. Sender is always an **address with identicon**, never a
  reverse-resolved name (app-chat §5). Per-thread action: hide sender
  (local).
- Composer: byte counter counting **UTF-8 bytes** against
  `64 − 4 − len(name)`; the public-forever notice on first use; send
  disabled behind the same gate as every send.
- No history endpoint configured (`VITE_NNS_HISTORY` unset): a setup
  empty-state naming the variable, same pattern as the resolver setup
  screen.

**Market**: offer rows (name, price, seller identicon+address, expiry).
Row → detail card. *Buy* enters the `B` flow (§5); until then the custodial
disclosure rides on the listing, as now.

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
  routes, §5.3). Poll the API (or history, for NC) until the effect
  appears: "Sent — confirming…" → "Done" with the effect named, or after
  ~90 s the honest failure: "Not confirmed — the network did not include
  this transaction." Never "sent ✓" from a hash.

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
