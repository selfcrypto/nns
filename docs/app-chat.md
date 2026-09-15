# NC — name-to-owner messages ("NNS Chat")

A client-layer convention for messaging the owner of a registered name:
a dust transaction to the owner's address whose data carries a short text.
Searched a name and found it taken? Message whoever holds it. Own names?
An inbox lists what arrived for them.

**This is not protocol.** Nothing here touches `packages/core`, the reducer,
the log, or any root, and nothing about it goes in the spec. It lives in
this document, `packages/app`, and an operator-run history endpoint.

## 1. The one rule that keeps it harmless

**The payload starts `NC1`, and must never start `NNS1`.** §7.5 makes the
`NNS1` prefix the ignore boundary — everything outside it is invisible to
every NNS indexer: no parse, no verdict, no log line, no byte in any root
(ratified in r23's E6 closure). An `NNS1`-prefixed chat would be the
opposite: `NNS1C…` parses as `UNKNOWN_TYPE`, takes a §7.4 forfeit, and earns
a §8.2 log line — every message would spam the permanent, hash-committed
NNS log of every indexer on earth. `NC` is chosen precisely because it is
not `NNS1`; the `1` after it is a version digit, same convention, so the
format can move without a new prefix.

## 2. Wire format

```
NC1<message>
```

| Field | Rule |
|---|---|
| `NC1` | 3 ASCII bytes, exact |
| `message` | UTF-8, ≥ 1 byte, no C0 control characters |

**Total ≤ 64 bytes, hard.** The network's cap is the measured silent-drop
boundary: 65+ bytes returns a hash and never lands (docs/rpc-reference.md
§4). The message budget is therefore a flat **61 bytes**, and the composer
counts UTF-8 bytes, not characters, because an emoji costs four.

**There is no subject field.** The payload carried `<name>|` until
2026-09-15 — the name the sender said the message was about. It cost 4 +
`len(name)` of the budget, leaving 57 bytes for a message about a 5-character
name and **11** for the longest dotted subject, and it bought a name that
could not be trusted on arrival. Kike: *"That var on the payload doesn't makes
sense at all. Name should be retrieved (if any) by the app with on-chain data
against the address that sent the message, and that's all."* What a name in
this app means is settled by the registry, so the only names shown are the
peer's, reverse-resolved from `/address/{addr}/names` (§5). Nothing is
asserted on the wire, so nothing has to be disclaimed.

**No message predates the registry it talks about.** `CHAT_MIN_HEIGHT` is
`CONSTANTS.LAUNCH_HEIGHT`, and a transaction below it is not an NC message:
`chatMessages` drops it, and an index configured to start below it is refused
(`packages/chat-index/src/env.ts`). Without that floor the inbox showed
threads from before the era, headed by names whose ownership had since moved —
which is how `nns` appeared in a stranger's inbox (Kike, 2026-09-15). An
operator may start an index **later** than the floor and says so in its
declared window; the client clamps that window to the floor so it never
promises blocks it drops.

**The `NC1` prefix survived the change.** The digit is a version and a bump
was the alternative; keeping it means a payload written in the old shape still
parses, as the literal text `name|message` it now is. The height floor is what
makes that harmless: such a payload can only reach a reader if it was sent in
this era, before the change.

Transaction fields:

- **To:** the name's **owner** address (not the target — §3 below)
- **Value:** `DUST_VALUE` (1 luna); `value: 0` is rejected by the network
- **Fee:** 0
- **Data:** the payload above, hex-encoded (the RPC accepts nothing else)

The name is in the payload because one owner address usually holds several
names — all registered from the same Pay account — so the message has to say
which one it is about. It is the message's **subject**, not its thread key:
conversations group by peer (§4). A received `NC1` naming a name the recipient
does not own at that address is kept but marked, not trusted: the payload is
sender-asserted.

**The sender's own name is deliberately not in the payload.** It would spend
scarce bytes on a claim anyone could forge, and it is unnecessary: the
transaction carries the sender's address, and the names that address holds are
a registry lookup away (§5).

## 3. Owner, not target

`S` splits a name's owner from where it pays. The **target** may be a
donation address, an exchange deposit, a cold vault — a message there
reaches a party who cannot act on the name. The **owner** is who can sell,
renew, delegate, reply. So messages go to `record.owner` from
`/name/{name}`.

That address is display-grade today (one API's answer, not proof-checked).
Acceptable **for this feature only**: a chat message carries dust and text,
so a wrong owner address wastes a message — unlike a payment, where the
proof-verified path is mandatory and stays so. The upgrade path is real:
the §8.1 leaf commits `owner` and `packages/api`'s proof documents already
carry every leaf field, so `@nimiqnames/resolver` can expose a verified owner
without new protocol. Do that before chat ever grows anything more valuable
than text.

**A subdomain has no owner.** §8.6 gives `label.parent` no record, so §3's
owner does not exist for it and there is nothing to look up: the only party the
query designates is the address the parent's delegate host answered with. A
message about `rico.nns` therefore goes **there**. The parent's owner is not a
stand-in — they run the host, and the address they hand out may belong to
anyone (Kike, 2026-08-28). Two things follow, and the app says both beside the
composer: that address is the host's word and no proof covers it, and it is a
*target*, so it may be a deposit address nobody reads.

Since 2026-09-15 the payload carries no subject, so a message about
`rico.nns` arrives as text at that address with no machine-readable note of
which label it concerns. That is the accepted cost of the change: a sender who
needs to say it writes it in the message, out of a budget that grew by the
bytes the field used to take.

**Messaging your own name is impossible, not forbidden**: sender = owner
would be a self-transaction, which the network drops silently (§5.3). The
composer refuses with "this name is yours" wording rather than letting the
drop eat the message.

## 4. The inbox — where history can come from

The wallet cannot supply it: the mini-app SDK has **no history methods**
(measured; docs/rpc-reference.md §8). The chain can: one
`getTransactionsByAddress(myAddress)` call returns both directions with
`recipientData`, `from`, `to`, `executionResult` and a **millisecond
timestamp** (probed 2026-08-16). But a browser cannot call a node directly —
basic auth plus no CORS (same probe) — so the app reads through an
**operator-run history endpoint**: a thin proxy that allowlists this one
read-only method, holds the node credentials upstream, and serves CORS.
App-side it is one URL (`VITE_NNS_HISTORY`), and the Inbox is a setup
empty-state without it.

The transport inside Pay is the SDK's own channel: `setRPCUrl(endpoint)`
then `provider.request({method: 'getTransactionsByAddress', …})` — the SDK
forwards every non-wallet method there and unwraps `result.data` itself
(read from the shipped bundle; docs/rpc-reference.md §3). That call is
still a WebView `fetch`, so it changes nothing about the endpoint's
requirements — CORS-open, unauthenticated, allowlisted — it only removes a
hand-rolled client. Outside Pay (desktop dev), a plain `fetch` speaks the
same JSON-RPC to the same URL.

Inbox pipeline, entirely client-side:

1. Fetch history for the Pay address: **one call, 500 transactions,
   descending**. There is no `startAt` paging loop — see the window note below.
2. Keep `executionResult: true`, data starting `NC1`, well-formed payload, and
   **at or above `CHAT_MIN_HEIGHT`** (§2).
3. Attribute the sender: `from` is read through §7.2's **effective sender**
   (`attributedFrom` in `@nns/chat`, over core's parser) — the account,
   unless it is an HTLC whose proof names its authorizing key. Nimiq Pay
   signs every send from an HTLC it routinely destroys; the raw `from` is an
   address that holds no names, cannot receive a reply, and stops existing.
   The registry attributes ownership to the authorizing key (r25), so the
   inbox must too, or a Pay user appears as their contract: no names beside
   the identicon, and replies mailed to a doomed address.
4. Direction from the attributed sender and `to`; the conversation key is the
   **peer address**.
5. Order by `timestamp`.
6. Mark, per **incoming** message, whether its name is one this address owns.
   A message naming a name that was never yours is noise or spoofing, shown
   muted, never dropped silently.

**One conversation per person, and the name lives inside it.** Until
2026-08-19 the key was (peer, name) and the list was split into names you own
and a collapsed "other" bucket. Both were wrong in the same way: the test
"is this name mine?" assumes an incoming message, so a conversation the reader
*started* — messaging the owner of a name that is by definition not theirs —
was filed under a spoofing warning, and the same person appeared once per name
they were written about. The split was never a spam filter either: spam naming
a name you do own always landed in the main list. So the doubt moved onto the
single incoming message it was true of, and the bucket became a real
**hide-by-sender** list. That per-message doubt is itself gone since
2026-09-15: with no name on the wire there is nothing to doubt, and the
hide-by-sender list is all that remains of the split.

**The window is honest, and it is one page deep.** A node below its history
horizon answers `[]` exactly like an empty history (the indexer's own trap, §2
of the RPC reference), and one call caps at 500 transactions. The inbox states
"since ≈ <date>" from the deepest transaction it actually saw, never "no
messages" as if that were provable.

Those 500 are *all* transactions — payments, rewards, NNS messages — so on a
busy address chat can be pushed out of the window entirely. **The fix is an
index, not a paging loop**: paging the raw history would spend more relay
calls on every inbox open to postpone the same limit.

**That index exists: `packages/chat-index`** (built 2026-08-20). It walks
batches, keeps the `NC1` rows, and serves
them by address, so a page is 500 *messages* rather than 500 mixed
transactions. When `VITE_NNS_CHAT` is set the Inbox reads it; unset, the
fallback above is what runs, and both paths hand the app the payload exactly
as it appeared on chain — the client parses with `@nns/chat` either way and
never trusts a server's parse. The service is **independent of the protocol's
code**: its own scan, database and RPC client, importing nothing from the
indexer, the API or `core`. It states the window it was built with, for the
same reason this section states one.

**For a Pay sender, the index is the complete path, not just the cheap one.**
`getTransactionsByAddress` indexes **senders and recipients only** — a
`relatedAddresses` member is not returned (measured; rpc-reference §8.1) —
so a message signed by the HTLC never appears in the durable wallet's own
history, and once Pay destroys that HTLC and drops it from `listAccounts`,
the direct path cannot find the user's past sends at all. The index stores
each row's **attributed** sender (step 3's rule, applied at scan time —
served rows carry no proof, so attribution happens there or nowhere), which
makes querying the durable address sufficient. The direct path stays an
honest best effort, exactly like its 500-transaction window.

## 5. Threat model and required wording

| Threat | Treatment |
|---|---|
| **Everything is public, forever** | The composer says so before the first send, plainly: on-chain, unencrypted, permanent, attached to your address. Not fine print |
| **Phishing text in a payments app** | Messages render as plain text, full stop. No linkification, no markdown, no address auto-detection. A message asking you to pay somewhere is just text — and the reply path is the only in-app action a message can offer |
| **Spam at dust cost** | Client-side hide-by-sender: a device-local address list (`packages/app/src/lib/hidden.ts`), no global machinery. Hidden conversations collapse into a `Hidden (n)` disclosure rather than vanishing — a reader can always see what they silenced |
| **Impersonation of the app's voice** | A message is never rendered with the app's own chrome, and the sender's **address is always shown** — identicon plus spaced form, in the list and in the header. Beside it the app shows the names that address **holds**, reverse-resolved from `/address/{addr}/names`. This row said the opposite until 2026-08-19, on the grounds that reverse resolution "presents an unverified claim as identity"; that conflated the payload's name field, which was a claim, with an owner → names lookup, which is a registry fact. Without it a recipient cannot tell who wrote to them at all. Only `REGISTERED` names are shown — a name in `GRACE` has stopped resolving |

**"Spoofed name field" was a row here until 2026-09-15.** The payload no longer
has a name field, so the threat does not exist and neither does the marking it
called for. That marking was the app's worst line: red, in the alarm palette,
on a message that attacked nobody, two lines under a hint saying names on this
screen come from the registry. Both statements were true — of two different
names — and nothing on the screen distinguished them, so it read as the app
contradicting itself (Kike: *"both estatements say the opposite"*). Deleting
the field deleted the line.

**Every message links to its own transaction** (2026-09-15). The Inbox renders
a message as a bubble, which is the app asserting that a transaction exists and
said this; an explorer link is how a reader checks that without trusting the
assertion. It is per message, because each message *is* a transaction, and it
goes to an independent site — `VITE_NNS_EXPLORER`, a `{hash}` template
defaulting to nimiq.watch. Both Nimiq explorers decode the payload and show it
under a field called *Message*, which is the only reason the link is worth
having; one that showed a transaction without its data would confirm nothing
about the text. The cost, as with any outbound link: the explorer learns that
someone looked at that transaction. The data is public either way.

**Encryption is a v2 note, not a v1 gap to paper over.** NNS state holds
only the owner's address — a hash of the key — so there is nothing to
encrypt to, the same gap that blocks §16.5 signed delegate responses. (Once
an owner has any outgoing transaction, the key is recoverable from its
proof; an "encrypt when possible" upgrade exists. Write it down when it is
built, not before.)

## 6. What Pay's stall does and does not block

**Since 2026-08-16, chat sends work today through the Nimiq Hub adapter**
(desktop): the Hub signs the dust transaction with the `NC1` payload as
`extraData`, the app broadcasts it via the RPC endpoint, and confirmation
is the transaction found executed (`getTransactionByHash`), keyed on the
Hub's hash.

On the **Pay** path, sending stays blocked until the post-fork build ships
— but chat remains immune to the §10.5 probe question that gates Pay's
fee-bearing NNS messages: the value is dust, and no rule forfeits an
overpay of nothing. So chat is the first Pay send to enable when a build
arrives, probe answered or not.

The inbox half needs no wallet at all: it reads across the whole identity
set, and is testable with the `?address=` dev override against the RPC
endpoint.
