# Integrating NNS

How to put Nimiq names into a webpage, a wallet, an exchange, a checkout, a
bot, a contract — anything that would rather show `alice` than
`NQ88 XL24 NHPU MYVX 67AC TXLX NQX1 R471 EGM9`. It is written for someone who
has never read the spec, and every code example is checked against the code
in this repository as of 2026-09-12.

Pick the depth you need and skip the rest:

| You want to… | Read | Effort |
|---|---|---|
| Show a name's address, from any language | [§2 The HTTP API](#2-the-http-api-any-language) | one GET |
| Resolve names in a JS/TS app, verified the way the protocol requires | [§3 The `@nimiqnames/resolver` library](#3-the-nnsresolver-library-javascript--typescript) | one dependency |
| Check the proofs yourself, in your own language | [§4 Verify proofs yourself](#4-verify-a-proof-yourself) | ~100 lines |
| Give your users `deposit.yourexchange` style subdomains | [§5 Exchanges and services](#5-exchanges-and-services) | a JSON file and TLS |
| Register, renew, repoint, sell names from your own software | [§6 Writing to the registry](#6-writing-to-the-registry) | a transaction builder |
| Stop depending on anyone's server | [§7 Run your own resolver](#7-run-your-own-resolver) | a history node + Docker |
| Use a name from a Solidity contract | [§8 Names on EVM chains](#8-names-on-evm-chains) | a keccak and an event |
| Link to the app from an invoice or a referral | [§9 Links](#9-links-that-need-no-code) | a URL |

The two things to know before any of it are in §1, and the reference tables
(endpoints, error codes, warnings, constants, live URLs) are in §10.

---

## 1. The mental model

### 1.1 There are no contracts

NNS is a name registry on Nimiq with **no smart contract**. A name is
registered, repointed, transferred or sold by an ordinary Nimiq transaction
whose *data field* carries a short message — `NNS1Galice` registers `alice`;
`NNS1Salice` sent to an address repoints it there. Every message is at most 64
bytes.

An **indexer** reads the chain from a fixed height (`LAUNCH_HEIGHT`) and
replays those messages through one deterministic set of rules into a table of
`name → owner, target, expiry, …`. Anybody can run one, and two honest
indexers derive **byte-identical** state — that is the whole design. Every
`CHECKPOINT_INTERVAL` blocks, an indexer hashes its state into a Merkle root
and publishes it as a **checkpoint**.

A **resolver** is an indexer with a read-only HTTP API in front. Ask it for a
name and it answers with the address **and a Merkle proof** that the answer is
in its checkpoint. A client that checks the proof, and asks more than one
resolver, needs to trust none of them.

So the parties, from least to most work:

```
  you (any language)  ──GET──▶  a resolver's API      (§2)
  you (JS/TS)         ──lib──▶  N resolvers, proofs verified, quorum   (§3)
  you (any language)  ──────▶  the same, verifying proofs yourself     (§4)
  you (an operator)   ──────▶  your own indexer + API                  (§7)
```

Nothing you can run holds a key. Nothing writes to the chain except a
user's wallet.

### 1.2 What is guaranteed, and what is not

**Guaranteed by the protocol** (anyone can check it from the chain alone):

- who owns a name, where it points, when it expires — as of a checkpoint;
- that a name is *absent* (a non-inclusion proof), so "available" is a
  proven claim, not one server's opinion;
- that the registry can be reconstituted without the operator: the rules
  are public, the input is the chain, the output is deterministic.

**Not guaranteed, and your UI must say so:**

- the address behind a **subdomain** (`shop.alice`). NNS proves only that
  `alice` exists and that its owner designated a host; the host's answer is
  the owner's word (§5, §3.4);
- anything about a name in the seconds after a change: state is *live*
  ahead of the last checkpoint, so the newest changes come without a proof
  until the next boundary (§3.3, "PROOF_PENDING");
- that the operator's servers are up. Run your own (§7) if that matters.

### 1.3 Three clocks

Every answer carries three heights, and confusing them is the most common
integration bug:

| Clock | Where | Meaning |
|---|---|---|
| `height` | every state response | the block this indexer's state is as of. Live. |
| `proof.nimiq_height` | `/resolve`, `/available` | the checkpoint boundary the proof is against. Lags `height` by up to `CHECKPOINT_INTERVAL` |
| `expiry` | a name record | the first block at which the name **stops** resolving (the term is half-open: it resolves at `expiry − 1`, not at `expiry`) |

A name **works as soon as its registration is final** on chain — you do not
wait for a checkpoint to pay it. The checkpoint is what lets you *verify* it.

### 1.4 The name rules, in one paragraph

Lowercase `a–z`, `0–9` and `-`; 1–24 characters; must contain a letter; no
leading or trailing `-`, no `--`; digits only as a leading or trailing run
(`web3` and `4chan` yes, `a1b` no), and neither `0` nor `1` at either end.
Names of 1–4 characters are **reserved**
(the operator releases them over time; they are not invalid). A query with
one dot, `label.name`, is a **subdomain**: the part before the dot is the
label (1–24 chars, same alphabet), the part after is a registered name.
There is never more than one dot. Do not restate these rules in your code:
`@nimiqnames/core` exports `validateName`, `validateLabel` and `parseQuery`, and the
API returns the exact reason code when a name fails.

---

## 2. The HTTP API (any language)

Every resolver serves the same fourteen `GET` routes, JSON, CORS `*`, no
authentication. The full contract is `packages/api/openapi.yaml` and every
resolver serves its own copy at `/openapi.yaml`. Base URL of the operator's
resolver today: `https://api.nimiqnames.com` (§10.5 for the others).

Rules that apply to every route:

- **Amounts are luna, as decimal strings** (`"400000"` = 4 NIM;
  1 NIM = 100,000 luna). Parse to an integer type; never to a float.
- Every state response carries `height` — the block it is as of.
- Until the indexer has state, every route answers `503 {"error":"NOT_SYNCED"}`.
- Errors are `{"error":"<CODE>", …}` with a stable code (§10.2).
- `/log` carries two headers, `x-nns-checkpoint-height` and `x-nns-log-hash`,
  so a client can hash the body and compare without a second request.

### 2.1 Resolve a name

```sh
curl -s https://api.nimiqnames.com/resolve/ricochet
```

```json
{
  "name": "ricochet",
  "target": "NQ88 XL24 NHPU MYVX 67AC TXLX NQX1 R471 EGM9",
  "evm": "",
  "status": "REGISTERED",
  "expiry": 62025774,
  "host": "",
  "proof": {
    "name": "ricochet",
    "owner": "NQ88 XL24 NHPU MYVX 67AC TXLX NQX1 R471 EGM9",
    "target": "NQ88 XL24 NHPU MYVX 67AC TXLX NQX1 R471 EGM9",
    "evm": "",
    "expiry": 62025774,
    "status": "REGISTERED",
    "delegate": "",
    "leaf_index": 50,
    "proof": [ { "hash": "0xc7a5c50c…", "side": "right" }, "… 6 steps in all" ],
    "root": "0x997c9d03…f34f",
    "nimiq_height": 61441200,
    "anchor": null
  },
  "height": 61441200
}
```

- The top-level fields are the **live** state at `height`: `target` is
  where to pay, `evm` the owner's declared EVM address (lowercase `0x…`, or
  `""`), `host` the delegate answering for subdomains (or `""`). The owner
  is not at the top level; it is in the proof, and on `/name`.
- `proof` is the §8.3 inclusion document: the full leaf as of the checkpoint
  at `nimiq_height` (`owner`, `target`, `evm`, `expiry`, `status`,
  `delegate`), the sibling path in `proof.proof`, and the `root` — the
  checkpoint's `nameRoot`. `anchor` is reserved for a future EVM reference.
- `proof` is `null` when the newest checkpoint predates this record — the
  name is live and payable, just not yet provable. See §3.3. When the leaf's
  `target` differs from the top-level one, the owner repointed the name
  since the boundary; the proven address is the leaf's.
- A name in grace (expired, still renewable by its owner) is `404 IN_GRACE`
  with `expiry`. A name nobody holds is `404 NOT_FOUND`. A dotted query is
  `400 DOTTED_QUERY` — the API deliberately refuses to answer for subdomains
  (§5), and tells you which parent to resolve instead.

**From JavaScript** (browser or Node 18+, no library):

```js
const res = await fetch('https://api.nimiqnames.com/resolve/ricochet')
if (res.status === 404) { /* NOT_FOUND or IN_GRACE — see body.error */ }
const record = await res.json()
console.log(record.target)   // 'NQ88 XL24 NHPU MYVX 67AC TXLX NQX1 R471 EGM9'
```

**From Python:**

```python
import requests

r = requests.get("https://api.nimiqnames.com/resolve/ricochet", timeout=5)
if r.status_code == 404:
    raise LookupError(r.json()["error"])       # NOT_FOUND | IN_GRACE
r.raise_for_status()
target = r.json()["target"]
```

**From a shell script, with `jq`:**

```sh
curl -sf https://api.nimiqnames.com/resolve/ricochet | jq -r .target
```

> **This is the "trust one server" tier.** A plain GET takes the resolver's
> word; nothing here checks the proof. For a wallet, an exchange withdrawal
> form, or anything that turns a name into money, use §3 or §4 — and at the
> very least show the user the address you resolved, not only the name.

### 2.2 Is a name available?

```sh
curl -s https://api.nimiqnames.com/available/zzq-free-name-test
```

```json
{
  "name": "zzq-free-name-test",
  "available": true,
  "proof": {
    "kind": "AFTER_LAST",
    "previous": { "name": "zwf", "owner": "NQ87 …", "target": "NQ87 …", "evm": "", "expiry": 61974427,
                  "status": "REGISTERED", "delegate": "", "leaf_index": 57, "proof": [ "… 4 steps" ] },
    "next": null,
    "root": "0x997c9d03…f34f",
    "nimiq_height": 61441200,
    "anchor": null
  },
  "height": 61441200
}
```

When `available` is `false`, `reason` says why: `TAKEN` (registered or in
grace), `RESERVED` (a 1–4 character name or one on the published list, not
yet released), or a syntax reason (`TOO_SHORT`, `TOO_LONG`, `BAD_CHARACTER`,
`NO_LETTER`, `LEADING_HYPHEN`, `TRAILING_HYPHEN`, `DOUBLE_HYPHEN`,
`INTERIOR_DIGIT`, `BOUNDARY_DIGIT`).
Ask this before letting anyone pay a registration fee; the `proof` is a
*non-inclusion* proof (§4.3).

### 2.3 Everything about a name

```sh
curl -s https://api.nimiqnames.com/name/nns
```

`/name/{name}` answers for any valid name, registered or not: `reserved`,
`unreserved`, `record` (null when nobody holds it), and `pending` —
`{transfer, offer, auction}`, each null or the pending thing. Use it for
"show me the state" screens; use `/resolve` for "where do I pay".

### 2.4 The other routes

| Route | Returns | Typical use |
|---|---|---|
| `/address/{addr}/names` | every name whose owner is `addr` (registered and in grace) | "my names", reverse lookup |
| `/params` | prices in effect, the seven fee bands (`fees`), `minPrice`, pending governance, verification span | build any `G`/`N`/`O`; show prices |
| `/offers` | open fixed-price listings | a marketplace view |
| `/auctions` | open auctions with `minimumBid` | a marketplace view; build a bid |
| `/checkpoints/latest` | the newest checkpoint: `height`, `layout`, six roots, `commitment` | verification, anchoring |
| `/checkpoints/{height}` | one checkpoint by boundary height | comparing two resolvers at the same height |
| `/log` | the canonical §8.2 log, `text/plain`, through the latest checkpoint; `keccak256(body)` = `x-nns-log-hash` | seed a resolver, audit |
| `/log/decoded` | the same lines decoded as JSON (`?format=text` for a table) — a reading aid, never an artifact | humans |
| `/settlements` | what the treasury/marketplace owe and have paid (refunds, proceeds) | find your refund |
| `/burn` | `revenue`, `owed`, `burned` — the §10.2 commitment, auditable | show the burn |
| `/referrals/{name}` | registrations that named `name` as referrer | a referrer's dashboard |
| `/openapi.yaml` | the contract this server implements | code generation |

A live `/params` (beta era, 2026-09-12):

```json
{
  "prices": { "feeBase": "400000", "commissionBp": "250" },
  "minPrice": "400000",
  "fees": [
    { "upTo": 2,  "times": "200", "yearly": "80000000", "lifetime": "800000000" },
    { "upTo": 3,  "times": "100", "yearly": "40000000", "lifetime": "400000000" },
    { "upTo": 4,  "times": "50",  "yearly": "20000000", "lifetime": "200000000" },
    { "upTo": 5,  "times": "25",  "yearly": "10000000", "lifetime": "100000000" },
    { "upTo": 6,  "times": "10",  "yearly": "4000000",  "lifetime": "40000000"  },
    { "upTo": 11, "times": "5",   "yearly": "2000000",  "lifetime": "20000000"  },
    { "upTo": 24, "times": "1",   "yearly": "400000",   "lifetime": "4000000"   }
  ],
  "listingFee": "0",
  "lastGovernanceHeight": 61379066,
  "pendingGovernance": null,
  "verification": { "verifiedFrom": 61344720, "bootstrap": null },
  "height": 61440420
}
```

The fee for a name is the first row whose `upTo` ≥ its length — `yearly` for
a one-year term, `lifetime` for a hundred-year term. **Read the fee off this
table; never multiply `feeBase` yourself.** A `pendingGovernance` object, when
present, carries the same table at the prices that take effect at its
`effectiveHeight`; a registration that lands after that height is checked
against the new table.

### 2.5 Resolving a subdomain over plain HTTP

`/resolve/shop.alice` is refused (`DOTTED_QUERY`). Do it in two steps — this
is exactly what the library does for you:

```sh
# 1. the parent, proven
curl -s https://api.nimiqnames.com/resolve/alice | jq -r .host
#    → delegated.example.com      (empty string = no subdomains)

# 2. the delegate host, *not* proven — the request carries the parent
curl -s https://delegated.example.com/alice/shop
#    → {"address":"NQ42 …","ttl":300}     or  404 {"error":"NO_ANSWER"}
```

Cache the answer for at most `ttl` seconds (and never more than 3600,
whatever the host says), keyed by host + parent + label. Render it as
**unverified** (§3.5). The reference host is live to test a client against:
`GET https://delegated.nimiqnames.com/nns/rico` answers
`{"address":"NQ42 5QRF L5AV J6K3 BQHQ FAE8 XXHR TS8Y 9YRA","ttl":300}` and an
unknown label answers `404 {"error":"NO_ANSWER"}`. (In the public beta `nns`
is still a reserved, unregistered name, so step 1 fails for it today; the
endpoint exercises step 2 alone.)

---

## 3. The `@nimiqnames/resolver` library (JavaScript / TypeScript)

The client the app itself uses. It asks several resolvers, verifies every
proof against the checkpoint root, requires agreement, handles subdomains,
and hands you a result whose `verification` field tells you what you are
allowed to claim. Browser and Node 20+; no Node built-ins, no network access
it does not tell you about.

Its own README (`packages/resolver/README.md`) is the long form; this section
is the integration path.

### 3.1 Getting it

Two ways in, and the second one exists because most of the pages that should
resolve a name — a checkout on a CMS, a static site, a donate button — have
no build step at all, and "install a bundler first" is how an integration
gets postponed forever.

**With a bundler:**

```sh
npm install @nimiqnames/resolver          # and @nimiqnames/core if you build transactions (§6)
```

**Without one** — one self-contained ES module, nothing to install, nothing
fetched at runtime beyond the resolvers themselves:

```html
<script type="module">
  import { createResolver } from 'https://nimiqnames.com/nns.js'

  const nns = createResolver({})
  const { address, verification } = await nns.resolve('ricochet')
  console.log(address, verification)   // NQ88…EGM9  PROVEN
</script>
```

68 kB, 24 kB over the wire. It is the *same source* as the npm package, built
twice — not a cut-down copy, so everything in this section applies to it
unchanged, and `https://cdn.jsdelivr.net/npm/@nimiqnames/resolver/dist/nns.js` is
the same file from a CDN if you prefer one that is not ours.

> **Status, 2026-09-14.** The `https://nimiqnames.com/nns.js` URL is live.
> The three packages (`@nimiqnames/core`, `@nimiqnames/anchor`,
> `@nimiqnames/resolver`) are release-ready but not yet on the registry —
> publishing is one command in `docs/runbooks/release.md`. Until it runs,
> `npm install @nimiqnames/resolver` will 404 and the script tag above is the
> working path. Nothing else in this guide changes when it does.

Either way `dist/` is what ships: ESM, typed, plus `dist/rendering.css`
(§4.3's type face) and `dist/nns.js` (the bundle above).

### 3.2 Construct one, resolve one

```ts
import { createResolver } from '@nimiqnames/resolver'

// Zero configuration is the supported path: the shipped resolver list has two
// public endpoints and the default quorum is 2, so this asks both and requires
// them to agree.
const nns = createResolver({})

const r = await nns.resolve('ricochet')
r.address        // 'NQ88XL24NHPUMYVX67ACTXLXNQX1R471EGM9' — pay here. Canonical compact form;
                 //   formatAddress() from @nimiqnames/core gives the spaced display form
r.evm            // '' or '0x…'                                     — the owner's EVM address, if declared
r.verification   // 'PROVEN' | 'PROOF_PENDING' | 'DELEGATED'
r.quorum         // { required: 2, queried: 2, agreed: 2, resolvers: [{ name, url }, …] }
r.warnings       // [] or [{ code, detail }, …]
```

Keep the instance; it carries the delegation cache. `resolve(query, options)`
is a one-shot form that throws the cache away.

Before letting anyone pay a registration:

```ts
const a = await nns.available('zzq-free-name-test')
a.available      // true — backed by a non-inclusion proof
a.reason         // null, or 'TAKEN' | 'RESERVED' | a syntax reason
```

All options:

| Option | Default | What it does |
|---|---|---|
| `resolvers` | `DEFAULT_RESOLVERS` (two entries) | `{ name, url }[]`. The name is what you show the user. **Add**, never replace: `[...DEFAULT_RESOLVERS, mine]` |
| `quorum` | `2` | how many resolvers must agree. Below 2 warns on every result |
| `timeoutMs` | `5000` | per resolver request |
| `delegateTimeoutMs` | `timeoutMs` | per delegate request. Do not shorten it — a cold host handshaking legitimately takes seconds |
| `fetch` | global `fetch` | inject your own (proxies, tests) |
| `onWarning` | – | called for every warning as it happens |
| `anchors` | off | the EVM cross-check, §3.7 |

### 3.3 What `verification` means

| Value | What is true | What to show |
|---|---|---|
| `PROVEN` | the address is in a checkpoint every agreeing resolver signed off on, and the proof recombined to that root on your machine | "Verified by N resolvers" |
| `PROOF_PENDING` | the name resolves and is payable, but the newest checkpoint predates the record, or the target changed since the boundary (`TARGET_CHANGED_SINCE_CHECKPOINT`) | "Verified by N resolvers · proof pending" — **depth, not alarm** |
| `DELEGATED` | a subdomain: the parent is proven, the address is the owner's server's word | "Address provided by the owner's server" — **visibly different** from the two above |

Anything worse than these **throws**; there is no degraded success. A proof
that fails to recombine is `ProofError` and halts the call even if the other
resolvers agree — dropping the liar silently would let one compromised
resolver degrade the quorum unnoticed.

### 3.4 Subdomains

```ts
const s = await nns.resolve('shop.alice')
s.name           // 'alice'       — the parent (proven)
s.query          // 'shop.alice'  — what you asked
s.host           // 'delegated.example.com' — from alice's proven record
s.address        // the host's answer for 'shop'
s.verification   // 'DELEGATED'
s.delegate       // { host, ttl, … } — cache metadata
```

(No name in the public beta carries a delegate host yet, so there is no live
dotted query to paste; the reference host itself is up — §2.5.)

If the host does not answer, the call throws `DelegateError` with
`code: 'DELEGATE_FAILED'` — and `error.parent` carries the parent's proven
resolution, so the UI can say "`alice` is verified; its owner's server did
not answer for `shop`" instead of "NNS is down". Every failure at or beyond the
host is that one code: NNS is never entitled to say a subdomain does not
exist.

### 3.5 The two lines your UI owes the user

These are not style suggestions; the protocol requires clients to do them
(spec §8.5), and the library's result shape is built so they are cheap.

1. **Say who verified it, by name, every time.** `Verified by 2 resolvers`
   with both names on the shipped defaults; a third party joining raises it to
   3 with no code change in your app, because the count is `r.quorum.agreed`
   and the names are `r.quorum.resolvers`. Naming them is what keeps the count
   honest — today both are run by one operator (§7), and a user who can read
   the two URLs can see that for themselves. Do **not** label a healthy answer
   "unverified" because the count is small: that spends the word before the
   case it is for arrives.
2. **Render `DELEGATED` differently.** Different colour, different sentence,
   no checkmark. A user must never be told an unverified address is verified.

Two more that cost one line each:

3. **Show the address you resolved**, not only the name, wherever money is
   about to move. An identicon of the *address* (`@nimiq/identicons`) is the
   picture of what will actually be paid.
4. **Draw names in the shipped CSS**: `import '@nimiqnames/resolver/rendering.css'`
   and put `class="nns-name"` on the element (or
   `injectRenderingCss(document)` without a bundler). It selects a face that
   keeps `0`/`o`, `1`/`l` and `rn`/`m` apart, which is the whole of the
   anti-homoglyph defence a name registry can offer.

Warnings you will see and what they mean:

| `warnings[].code` | Meaning | Show it? |
|---|---|---|
| `QUORUM_BELOW_SPEC` | you configured `quorum < 2` | no — it is for you, not the user |
| `PROOF_PENDING` | checkpoint not yet due for this record | as "proof pending", quietly |
| `TARGET_CHANGED_SINCE_CHECKPOINT` | the owner repointed the name after the last boundary | as "proof pending" |
| `DELEGATED_ANSWER` | this is a subdomain answer | yes — see line 2 above |
| `DELEGATE_HOST_UNPROVEN` | the parent's own record is `PROOF_PENDING` | as "proof pending" |
| `ROOT_HEIGHTS_DIFFER` | two resolvers sit at different checkpoints and the cross-height comparison could not complete | no; it carries which resolver and why, for your logs |
| `ANCHOR_*` | the EVM cross-check was not run / unavailable / stale / under quorum | no, unless you turned anchors on |

### 3.6 Errors

Every throw is a `ResolverError` subclass with a stable `code`:

| Class | `code` | Meaning | User-facing? |
|---|---|---|---|
| `NameError` | `NAME_INVALID` | the query fails the name rules; `detail` says which | yes: fix the input |
| `LookupError` | `NOT_FOUND` / `IN_GRACE` | nobody holds it / it expired and its owner can still renew | yes |
| `QuorumError` | `QUORUM_UNMET` | fewer than `quorum` resolvers answered | "could not verify — try again" |
| `QuorumError` | `QUORUM_LAGGING` | resolvers answered at *different heights* with different answers — one has a block the other has not | ask again in a few seconds; **not** an alarm |
| `QuorumError` | `QUORUM_DISAGREEMENT` / `QUORUM_ROOT_MISMATCH` | resolvers at the **same** height disagree | the alarm case: halt, say resolvers disagree, name them |
| `ProofError` | `PROOF_INVALID` | a served proof does not recombine | halt; name the resolver |
| `DocumentError` | `DOCUMENT_MALFORMED` | a resolver served something that is not the contract | halt; name the resolver |
| `DelegateError` | `DELEGATE_FAILED` | the owner's host did not answer usefully; `error.parent` is the proven parent | "owner's server did not answer" |
| `AnchorError` | `CHECKPOINT_BINDING_INVALID` / `ANCHOR_MISMATCH` / `ANCHOR_DIVERGENCE` | the EVM cross-check contradicts the resolver | halt |
| `ConfigurationError` | – | e.g. no resolvers, or `anchors` with fewer than two RPCs | your bug |

Reserve the alarm vocabulary for the halting failures. `QUORUM_LAGGING` looks
like disagreement and is not: the first registration of the beta era was
rendered as "resolvers disagree" for exactly that reason, and the fix was
telling the two apart.

### 3.7 Anchors (optional, and off by default)

Checkpoint commitments can be notarised on an EVM chain by publishers you
list, so a resolver cannot quietly rewrite history. Turn it on with:

```ts
createResolver({
  resolvers: [...],
  anchors: {
    contract: '0x…',                       // the NnsAnchor contract on that chain
    rpcs: ['https://rpc-a…', 'https://rpc-b…'],   // at least two independent endpoints
    publishers: ['0x…', '0x…'],            // whose Anchored events count
    quorum: 2,                             // publishers that must agree
    lookbackBlocks: 40_000n,               // how far back to scan for events
  },
})
```

The library fetches `/checkpoints/{height}` *from the resolver whose proof it
used*, checks the proof's root is that checkpoint's `nameRoot`, **recomputes
the commitment** from the six components, and only then asks the chain
whether the listed publishers anchored that commitment. `r.anchor.status` is
`not-checked` / `unavailable` / `verified` / `divergence` /
`rpc-disagreement` / `quorum-not-met`. No contract is deployed on mainnet yet
and `DEFAULT_ANCHOR_PUBLISHERS` is empty; unconfigured, the tier costs zero
requests.

### 3.8 A complete example: a checkout page

This is a complete, working page. Save it as `.html`, open it, resolve a
name — there is no build step and nothing to install.

```html
<input id="q" placeholder="name or address"> <button id="go">Resolve</button>
<div id="out"></div>

<script type="module">
import {
  createResolver, ResolverError, formatAddress, injectRenderingCss,
} from 'https://nimiqnames.com/nns.js'

// §4.3: names must be drawn in a face that separates 0/o, 1/l and rn/m.
// Ignoring it produces no error — only a name that reads as another name.
injectRenderingCss(document)

// No bundler, no install, and still the full quorum: two resolvers must agree
// and the §8.3 proof must recombine before `address` is handed back.
const nns = createResolver({})

const out = document.getElementById('out')
document.getElementById('go').onclick = async () => {
  const q = document.getElementById('q').value.trim().toLowerCase()
  out.textContent = '…'
  try {
    const r = await nns.resolve(q)
    const who = r.quorum.resolvers.map((x) => x.name).join(', ')
    const line =
      r.verification === 'DELEGATED'
        ? `Address provided by the owner of ${r.name} — not verified by NNS`
        : `Verified by ${r.quorum.agreed} resolver${r.quorum.agreed === 1 ? '' : 's'} · ${who}` +
          (r.verification === 'PROOF_PENDING' ? ' · proof pending' : '')
    out.innerHTML = `
      <span class="nns-name">${r.query}</span> →
      <code>${formatAddress(r.address)}</code>
      <div class="${r.verification === 'DELEGATED' ? 'unverified' : 'verified'}">${line}</div>`
  } catch (e) {
    if (e instanceof ResolverError) out.textContent = `${e.code}: ${e.message}`
    else throw e
  }
}
</script>
```

Pin what you resolve: the first time a user pays `alice`, remember
`alice → NQ88 …` locally, and if it ever changes, stop and make them
confirm. Owners do repoint names legitimately, so it is a confirmation, not
a refusal — but a silent change is exactly what a compromised resolver or a
stolen name looks like.

### 3.9 In Node, on a server

Same code. `fetch` is global on Node 18+; there is no DOM requirement. A
withdrawal service typically resolves once at request time, pins the result
against the user's previous withdrawals to the same name, and shows both the
name and the address on the confirmation screen.

---

## 4. Verify a proof yourself

For an integrator in Go, Rust, Python, Swift, or a language with no NNS
library yet. Everything you need is one keccak-256 and a sort order. The
JavaScript names below are `@nimiqnames/core`'s; a port of them is about a hundred
lines.

### 4.1 The leaf

A name record hashes as `keccak256(0x00 ‖ enc)`, where

```
enc = len(name):u8 ‖ name ‖ owner:20B ‖ target:20B ‖ evm:20B ‖ expiry:u64-BE ‖ status:u8 ‖ len(host):u8 ‖ host
```

- `name`, `host`: ASCII bytes as served (`host` is the `delegate` field,
  `""` → one zero length byte and nothing else).
- `owner`, `target`: the **20 raw bytes** of the Nimiq address, not the
  `NQ…` string. Decoding: strip spaces, drop `NQ` and the two check digits,
  then base-32 decode the remaining 32 characters with the alphabet
  `0123456789ABCDEFGHJKLMNPQRSTUVXY`.
- `evm`: the 20 bytes of the `0x` hex, or 20 zero bytes when `""`.
- `expiry`: unsigned 64-bit big-endian.
- `status`: `0x00` for `REGISTERED`, `0x01` for `GRACE`.

### 4.2 The path

An internal node is `keccak256(0x01 ‖ left ‖ right)`. The leaves are sorted
by name, bytewise. When a level has an odd count, the last node is
**promoted** unchanged to the next level (not duplicated). Each proof step is
`{ hash, side }`: `side: "left"` means the sibling is on the left, so
`current = H(0x01 ‖ sibling ‖ current)`; `"right"` means
`current = H(0x01 ‖ current ‖ sibling)`.

```python
from Crypto.Hash import keccak   # pip install pycryptodome

def keccak256(b: bytes) -> bytes:
    h = keccak.new(digest_bits=256); h.update(b); return h.digest()

ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVXY"

def address_bytes(nq: str) -> bytes:
    s = nq.replace(" ", "")[4:]                      # drop 'NQ' + 2 check digits
    bits, value, out = 0, 0, bytearray()
    for ch in s:
        value = (value << 5) | ALPHABET.index(ch); bits += 5
        if bits >= 8:
            bits -= 8; out.append((value >> bits) & 0xFF)
    return bytes(out)                                # 20 bytes

def leaf_hash(leaf: dict) -> bytes:              # leaf = the proof document itself
    evm = bytes.fromhex(leaf["evm"][2:]) if leaf["evm"] else bytes(20)
    host = leaf["delegate"].encode()
    enc = (bytes([len(leaf["name"])]) + leaf["name"].encode()
           + address_bytes(leaf["owner"]) + address_bytes(leaf["target"]) + evm
           + leaf["expiry"].to_bytes(8, "big")
           + bytes([0 if leaf["status"] == "REGISTERED" else 1])
           + bytes([len(host)]) + host)
    return keccak256(b"\x00" + enc)

def verify(leaf: dict, steps: list, root_hex: str) -> bool:
    cur = leaf_hash(leaf)
    for s in steps:
        sib = bytes.fromhex(s["hash"][2:])
        cur = keccak256(b"\x01" + (sib + cur if s["side"] == "left" else cur + sib))
    return cur == bytes.fromhex(root_hex[2:])

doc = requests.get("https://api.nimiqnames.com/resolve/ricochet").json()
p = doc["proof"]                                   # None until the first checkpoint after the record
assert p and verify(p, p["proof"], p["root"])
cp = requests.get(f'https://api.nimiqnames.com/checkpoints/{p["nimiq_height"]}').json()
assert cp["checkpoint"]["nameRoot"] == p["root"]   # the root is a published checkpoint's
```

Then **use the leaf, not the top-level fields**: the address you pay is
`proof.target`, because that is what the root vouches for. If the top-level
`target` differs from `proof.target`, the owner repointed the name after the
checkpoint — that is `PROOF_PENDING`, and you show it as such. For a second
opinion, fetch `/checkpoints/{nimiq_height}` from another resolver and
compare its `nameRoot` to `proof.root`.

In TypeScript, all of that is:

```ts
import { leafHash, verifyProof } from '@nimiqnames/core'
import { verifyInclusion, readResolveResponse } from '@nimiqnames/resolver'

// the low-level pair: a NameRecord (addresses through parseAddress), the steps, the root — as bytes
const ok = verifyProof(leafHash(record), steps, root)
// or the whole document, throwing ProofError / DocumentError on anything wrong
const doc = readResolveResponse(json)
const proven = doc.proof ? verifyInclusion(doc.proof, 'ricochet') : null   // null = PROOF_PENDING
```

### 4.3 Non-inclusion ("available" is proven too)

`/available` returns a proof of one of four kinds:

| `kind` | Carries | Proves |
|---|---|---|
| `EMPTY_TREE` | nothing | the tree has no leaves |
| `BEFORE_FIRST` | `next` | the queried name sorts before the first leaf, and `next` *is* the first (every step `right`) |
| `AFTER_LAST` | `previous` | it sorts after the last leaf, and `previous` *is* the last (every step `left`) |
| `BETWEEN` | `previous`, `next` | it sorts strictly between two **adjacent** leaves |

Verify each bracketing leaf against the root, check the bracketing order
bytewise, and — the check people forget — check the two are *adjacent*:
`next.leaf_index == previous.leaf_index + 1`. The index travels with the
proof and is not taken on faith: an odd index always has a sibling on its
left, so the first step's `side` pins its parity. Without adjacency the
"proof" is compatible with the name sitting between them.
`verifyNonInclusion(document, name)` in `@nimiqnames/resolver` does all three.

### 4.4 Binding to the checkpoint

The proof root is the `nameRoot` of the checkpoint at `proof.nimiq_height`
(`/checkpoints/{height}`). The checkpoint's `commitment` is
`keccak256` over its six components in layout order (`layout` is `6` today;
`@nimiqnames/core`'s `commitmentFrom` is the reference), which is what an EVM anchor
notarises. To compare two resolvers, fetch `/checkpoints/{height}` from both
at the same boundary and compare `nameRoot`; two honest indexers produce the
same bytes.

---

## 5. Exchanges and services

An exchange has three integration points, in order of value.

### 5.1 Withdrawals: accept a name where you accept an address

Resolve it with §3 (or §2 + §4). Show the user **both** the name and the
resolved address on the confirmation screen, and pin the pair to their
account: a later withdrawal to the same name that resolves elsewhere gets a
"the address behind `alice` has changed" interstitial rather than a silent
send. Treat `PROOF_PENDING` as payable; treat `DELEGATED` as "this address
comes from `alice`'s owner, not from NNS". Never accept a `QUORUM_*` or
`ProofError` failure as "resolve anyway".

### 5.2 Deposits: give every user `<user>.yourexchange`

NNS stores nothing per subdomain and charges nothing per subdomain. You
register **one** name, point it at a host you run, and answer for as many
labels as you like from a JSON file. A customer tells a friend "send it to
`maria.yourexchange`", and every NNS client asks your host what `maria`
means.

**What is proven:** that `yourexchange` is yours and that you designated the
host. **What is not:** the address your host returns — it is your word, and
clients show it as such. Your host's security is your deposit addresses'
security.

Steps:

1. **Register the parent name** — from the app at `nimiqnames.com`, or
   programmatically (§6). A 12+ character name costs the base fee; shorter
   ones cost more (§2.4).
2. **Run the reference delegate** (`packages/delegate`, one container, no
   node, no database, no key), or implement the one route yourself:

   ```
   GET https://<host>/<parent>/<label>
   200 {"address":"NQ…","ttl":300}      application/json, CORS *
   404 {"error":"NO_ANSWER"}            for any label you do not hold — and for any parent you do not serve, identically
   ```

   Rules a client will hold you to: publicly trusted TLS (the scheme is
   fixed to `https`, no downgrade); the parent and label are the **last two
   path segments** (so you may mount it under a path); `ttl` in seconds,
   clients cap it at 3600; never distinguish "unknown parent" from "unknown
   label" (a client must not be able to enumerate which names you serve).

   The reference host's labels file:

   ```json
   {
     "defaultTtl": 300,
     "names": {
       "yourexchange": {
         "maria": "NQ12 3456 789A BCDE FGHJ KLMN PQRS TUVX YZ01",
         "jose":  { "address": "NQ98 7654 321Z YXVU TSRQ PNML KJHG FEDC BA98", "ttl": 60 }
       }
     }
   }
   ```

   It reloads on change, rejects the whole file on one bad entry (naming
   the key), and a `docker compose up` in `deploy/delegate` runs it on port
   8636 behind whatever TLS terminator you already have — the README there
   has Caddy, nginx+certbot and Cloudflare Tunnel recipes. For a dynamic
   backend (one deposit address per user, minted on demand), a route in
   your own API that returns the same JSON is a fine delegate; the file is
   only the reference.

3. **Point the name at the host** with one `D` message from the owner's
   wallet: `NNS1Dyourexchange|deposits.yourexchange.com` (§6.3). The host
   is `a-z 0-9 . - /`, at most 30 characters, no scheme; a path is allowed
   (`example.com/nns`), and the name plus host must fit in 52 bytes. In the
   app it is the owner's *Subdomains* tile.
4. **Check from outside**:

   ```sh
   curl -s https://deposits.yourexchange.com/yourexchange/maria
   ```

   and then resolve `maria.yourexchange` with the library (§3.4).

Two operational notes. Clients cache by `ttl`, so a deposit address you
retire keeps receiving for up to that long — use short TTLs for rotating
addresses. And because the request names the parent, one host serves every
name you own with separate namespaces: `maria.yourexchange` and
`maria.yourbrand` are different questions.

### 5.3 Naming your own hot wallets

Register `yourexchange` and point it (`S`) at the deposit hot wallet; users
who withdraw *to* you from another NNS-aware wallet then type a name. Pin
that pair in your own docs, and put the name on your website drawn in the
rendering CSS, so a homoglyph `yourexchanqe` is visibly not you.

### 5.4 Display rules, summarised for a compliance reviewer

- A verified name shows *Verified by N resolvers* with the resolvers named.
- A subdomain shows *provided by the owner's server*, never a checkmark.
- The resolved address is always visible beside the name before money moves.
- A changed name → address pair for a returning user is a hard interstitial.
- The name is drawn in a face that separates `0/o`, `1/l`, `rn/m`.

---

## 6. Writing to the registry

Everything an owner can do is one transaction from the owner's wallet with a
short ASCII payload. There is no API to call: you build the transaction and
your user signs it. The builders in `@nimiqnames/core` produce the three fields a
Nimiq transaction needs — `recipient`, `value`, `data` — and refuse anything
that would be dropped silently on chain.

### 6.1 The messages

| Letter | Does | Payload | Sent to | Value |
|---|---|---|---|---|
| `G` | register | `NNS1G<name>[\|<ref>][\|L]` | `TREASURY_ADDRESS` | the fee (§2.4) |
| `N` | renew | `NNS1N<name>[\|L]` | `TREASURY_ADDRESS` | the fee |
| `S` | set target | `NNS1S<name>` | **the new target** (or `PROTOCOL_ADDRESS` to reset to the owner) | dust |
| `E` | set EVM address | `NNS1E<name>\|<base64url 27 chars>` (empty field clears) | `PROTOCOL_ADDRESS` | dust |
| `D` | set delegate host | `NNS1D<name>\|<host>` (empty host clears) | `PROTOCOL_ADDRESS` | dust |
| `X` | transfer | `NNS1X<name>` | **the new owner** | dust |
| `K` | cancel a pending transfer / listing | `NNS1K<name>` | `PROTOCOL_ADDRESS` | dust |
| `O` | list for sale | `NNS1O<name>\|<price>` | `TREASURY_ADDRESS` | dust (the listing fee is 0, and 0 cannot be sent) |
| `B` | buy — or bid, if an auction is open | `NNS1B<name>` | `MARKETPLACE_ADDRESS` | the price / the bid |
| `A` | open an auction | `NNS1A<name>\|<start>\|<end_height>` | `PROTOCOL_ADDRESS` | dust |

`M` (settlement), `P` (prices), `U` (release/award), `F` (burn) are the
operator's and never yours. `L` on a `G`/`N` buys a hundred-year term for
ten yearly fees. `<ref>` on a `G` is a referrer's name (§9). Dust is
`DUST_VALUE`, 1 luna — `value: 0` is rejected by the network.

A transfer (`X`) does not complete at once: it matures after
`XFER_TIMELOCK` blocks, during which the sender can `K` it. A `B` on an
open listing pays the marketplace, which then settles to the seller with an
`M` — that is custodial for the duration, and a client must say so before
sending it.

### 6.2 Build the transaction

```ts
import { encodeRegister, encodeSetTarget, encodeDelegate, encodeRenew, CONSTANTS } from '@nimiqnames/core'

// the fee comes from the resolver, never from arithmetic in your code
const params = await (await fetch('https://api.nimiqnames.com/params')).json()
const band = (name: string, lifetime = false) => {
  const row = params.fees.find((f: { upTo: number }) => name.length <= f.upTo)
  return BigInt(lifetime ? row.lifetime : row.yearly)          // luna
}

const tx = encodeRegister({ name: 'mycoolshop', fee: band('mycoolshop') })
// tx.recipient  → CONSTANTS.TREASURY_ADDRESS
// tx.value      → 2000000n           (20 NIM in the beta era: ten characters is the 7–11 band, 5 × FEE_BASE)
// tx.data       → '4e4e5331476d79636f6f6c73686f70'   = hex of 'NNS1Gmycoolshop'

encodeRegister({ name: 'mycoolshop', fee: band('mycoolshop', true), lifetime: true, ref: 'ricochet' })
encodeRenew({ name: 'mycoolshop', fee: band('mycoolshop') })
encodeSetTarget({ name: 'mycoolshop', target: 'NQ42 …' as Address })        // repoint payments
encodeSetTarget({ name: 'mycoolshop', target: null })                        // back to the owner
encodeDelegate({ name: 'mycoolshop', host: 'deposits.mycoolshop.com' })     // subdomains
encodeDelegate({ name: 'mycoolshop', host: '' })                             // no subdomains
```

Every builder validates the name, the byte ceiling (64), a positive value
and, if you pass `sender`, that it differs from the recipient — the three
things the network drops **silently**. Pass `sender` whenever you know it.
`feeFor(name, prices, lifetime)` exists in `@nimiqnames/core` too, but it takes the
`Prices` object; reading the served `fees` table is what the app does, and it
keeps a `pendingGovernance` from surprising you.

Without the library, the payload is ASCII → hex:

```python
payload = f"NNS1G{name}".encode()          # add b"|L" for lifetime
assert len(payload) <= 64 and name_is_valid(name)
data_hex = payload.hex()
```

### 6.3 Send it — three wallets, one rule

**The rule:** a returned transaction hash is *not* confirmation. Three
things (too long, self-send, unfunded) are accepted by the node and dropped
by the network. Confirm by **effect**: poll `/resolve/<name>` (or `/name`)
until the state shows your change, then read the transaction's
`executionResult` if you want the failure reason. The app polls for 210 s.

**a) Nimiq Hub (web wallet, desktop browsers).** The Hub *signs*; you
*broadcast*. `extraData` must be **bytes** — a string is treated as UTF-8
text and double-encodes your hex.

```ts
import HubApi from '@nimiq/hub-api'

const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)))
const hub = new HubApi('https://hub.nimiq.com')
const height = await rpc('getBlockNumber', [])                    // the helper in (c), against any node or a relay
const signed = await hub.signTransaction({
  appName: 'My Shop',
  sender: ownerAddress,
  recipient: tx.recipient,
  value: Number(tx.value),                                        // luna, as number at this boundary
  fee: 0,
  extraData: hexToBytes(tx.data),                                 // Uint8Array, never a string
  validityStartHeight: height,
})
await rpc('sendRawTransaction', [signed.serializedTx])
```

**b) Nimiq Pay mini app (the wallet's in-app browser).** The SDK sends and
returns a hash. Its `data` is **text** (the wallet UTF-8-encodes it), so pass
the ASCII payload, not the hex; `value` and `fee` are honoured exactly
(measured). Omit `validityStartHeight`; the wallet uses its own node.

```ts
import { init } from '@nimiq/mini-app-sdk'

const provider = await init({ timeout: 5_000 })                  // throws outside Nimiq Pay
const hash = await provider.sendBasicTransactionWithData({
  recipient: tx.recipient,
  value: Number(tx.value),
  fee: 0,
  data: new TextDecoder().decode(hexToBytes(tx.data)),           // 'NNS1Gmycoolshop'
})
```

**c) Your own node (services, bots, an exchange registering its name).**
JSON-RPC over HTTP with Basic auth; every result is wrapped in
`result.data`; data is **hex** in both directions.

```ts
const rpc = async (method: string, params: unknown[]) => {
  const res = await fetch(NODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + btoa(`${USER}:${PASS}`) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await res.json()
  if (body.error) throw new Error(body.error.message)
  return body.result?.data                                        // unwrap, always
}

const height = await rpc('getBlockNumber', [])
const hash = await rpc('sendBasicTransactionWithData', [
  OWNER_ADDRESS,            // must be a wallet the node holds (unlocked)
  tx.recipient,
  tx.data,                  // hex
  Number(tx.value),         // luna
  0,                        // fee
  height,                   // validityStartHeight
])
```

Whatever you build for (c), make it dry-run by default: print the payload it
built and where the fee figure came from, and require an explicit flag before
anything is broadcast. A fee read from the wrong era is silent otherwise.

**Confirm by effect**, for all three:

```ts
const deadline = Date.now() + 210_000
while (Date.now() < deadline) {
  const r = await fetch(`${API}/resolve/mycoolshop`)
  if (r.ok) { /* registered */ break }
  await new Promise((f) => setTimeout(f, 3_000))
}
```

### 6.4 What happens to a wrong message

Nothing you send is lost silently *by the protocol* — only by the network's
three drops above. A message that reaches the chain and fails a rule gets a
**verdict** in the public log. Fee-bearing verdicts split in two:

- **Refunded** (`INSUFFICIENT_VALUE`, `LOST_REGISTRATION_RACE`,
  `OFFER_NOT_OPEN`, `WRONG_PRICE`): the payee owes the full value back; you
  find it in `/settlements` and receive an `M`, provided the value was at
  least `REFUND_FLOOR` (1 NIM).
- **Forfeited** (`INVALID_NAME`, a `G` for a still-reserved name, a
  malformed payload, …): the value stays with the treasury. Every one of
  these is a check your client should have made before enabling the button;
  `@nimiqnames/core`'s builders and `/available` cover all of them.

The full 28-token vocabulary is in the spec, §7.4. `/log/decoded?format=text`
shows every verdict ever issued.

---

## 7. Run your own resolver

You do not have to. A wallet that asks two independent resolvers and verifies
proofs (§3) already trusts nobody. But an exchange that wants zero
dependency on anyone's uptime, or a party that wants to *be* one of the
independent resolvers everyone else asks, runs one. It is three containers
— Postgres, the indexer, the read-only API — and only the API is published.
No keys, no wallet, no chain writes.

**The one prerequisite:** a Nimiq **history node** whose retention covers
`LAUNCH_HEIGHT`. A node synced by state, or one that has pruned, answers a
batch below its horizon with an empty list — indistinguishable from an empty
batch — so a resolver pointed at one would scan everything, find nothing, and
report success with an empty registry. The indexer checks the horizon and
refuses to start instead, naming the earliest block the node holds. That
refusal is the good outcome; get a node with the history, and start its sync
early (it takes days). Do not run it on validator hardware.

```sh
cd deploy/resolver
cp .env.example .env            # NNS_RPC_URL, the node's credentials, NNS_START_MODE
docker compose up -d --build
docker compose logs -f indexer
curl -s localhost:8635/params
```

- `NNS_START_MODE=scratch` replays the chain from `LAUNCH_HEIGHT`. Hours.
- `snapshot` seeds from another resolver's `/log`, verified against the
  checkpoint that resolver published, then tails. Minutes — at the cost of
  independence over the seeded range, which `/params.verification` discloses
  (`bootstrap`) rather than hides.
- `hybrid` seeds like `snapshot` and re-derives the range from the chain in
  the background; needs the full history like `scratch`.

Put any TLS terminator in front of port 8635 (Caddy: `nns.example.org {
reverse_proxy 127.0.0.1:8635 }`); do not strip the API's CORS headers. Then
check from a machine that is not the server:

```sh
curl -s https://nns.example.org/checkpoints/latest
curl -s https://api.nimiqnames.com/checkpoints/latest
# same height → same nameRoot. That equality is the product.
```

There is nothing to back up; `docker compose down -v && docker compose up`
rebuilds everything from the chain. Two cases need a rebuild rather than a
resume: a protocol revision that changes the rules or constants (release
notes say so; roots under old rules are not comparable), and a resynced node
that no longer covers `LAUNCH_HEIGHT`.

**Join the quorum, and this is the part that matters.** Being runnable is not
being asked. Clients query the resolvers in their shipped list,
`DEFAULT_RESOLVERS` in `@nimiqnames/resolver`, and today that list is two endpoints
**run by the same operator that publishes the package**. They are separately
replayed — their own database, their own host, their own provider — so their
agreement does prove the reducer was deterministic and neither box drifted.
What it cannot prove is the stronger thing §8.5 is actually after: a client
checking only those two is trusting one party twice. You running a third
endpoint is what closes that, and it is the single most useful thing an
integrator can contribute to this protocol. Each entry is a URL and a **name**
(what a client shows when resolvers disagree). Open an issue with both once
your endpoint answers publicly from outside. `deploy/collaborator/` runs a resolver and a
delegate on one box. `deploy/README.md` maps all the roles.

---

## 8. Names on EVM chains

Two building blocks; nothing is deployed on a mainnet EVM chain yet.

**The `evm` field.** An owner binds one 20-byte EVM address to their name
(`E` message). It is in the leaf, so an inclusion proof binds it exactly as it
binds `target`. That is what lets a Solidity contract accept `alice` and
verify, on chain, that `msg.sender` is the address `alice`'s owner declared:

```solidity
// sketch — the leaf encoding of §4.1, the path of §4.2
function leafHash(bytes memory name, bytes20 owner, bytes20 target, bytes20 evm,
                  uint64 expiry, uint8 status, bytes memory host) internal pure returns (bytes32) {
    return keccak256(abi.encodePacked(
        bytes1(0x00), uint8(name.length), name, owner, target, evm, expiry, status, uint8(host.length), host));
}
function verify(bytes32 leaf, bytes32[] memory hashes, bool[] memory siblingOnLeft, bytes32 root)
    internal pure returns (bool) {
    bytes32 cur = leaf;
    for (uint i = 0; i < hashes.length; i++)
        cur = siblingOnLeft[i] ? keccak256(abi.encodePacked(bytes1(0x01), hashes[i], cur))
                               : keccak256(abi.encodePacked(bytes1(0x01), cur, hashes[i]));
    return cur == root;
}
```

**The anchor contract** (`packages/anchor/contracts/NnsAnchor.sol`) is how a
contract learns a trustworthy `root`. It is permissionless — one function,
one event, no owner:

```solidity
event Anchored(bytes32 indexed root, address indexed publisher, uint64 nimiqHeight, uint64 timestamp, bytes32 logDigest);
function anchor(bytes32 root, uint64 nimiqHeight, bytes32 logDigest) external;
```

Anyone can anchor; a contract (or the library's `anchors` policy, §3.7)
decides **which publishers count**. What is anchored is the checkpoint's
`commitment` — so a contract holds `commitment`, and a caller supplies the
six components, the contract recomputes the commitment, and only then uses
the `nameRoot` among them for the Merkle check. Skipping the recomputation
lets anyone pair a real commitment with a root of their choosing.
`scripts/resolve-check.mjs` shows the client-side reading against a Sepolia
deployment. A publisher is a cron that reads a resolver's `/log` and
`/checkpoints/{height}` at the height that response stamped, pins the log
snapshot to IPFS via two independent importers, and calls `anchor` — see
`deploy/anchor`.

**Payments in USDT.** The app's Pay screen can send an ERC-20 transfer on
Polygon to a name's `evm` address through whatever EIP-1193 wallet is
present (`asset=usdt` in a payment link, §9). For your own integration:
resolve the name (§3), read `r.evm`, refuse if `""`, show the user the
address, send with the wallet of your choice. There is no message on an
ERC-20 transfer.

---

## 9. Links that need no code

The hosted app at `https://nimiqnames.com` understands two URL shapes. Any
independent host of the app (it is MIT and domain-agnostic) understands the
same ones.

| Link | Shape | What it does |
|---|---|---|
| **Payment link** | `https://nimiqnames.com/#/pay/<name>?amount=<NIM>&message=<text>[&asset=usdt]` | opens Pay with recipient, amount and reference filled in. Every field stays editable; nothing is sent until the payer presses Pay |
| **Referral link** | `https://nimiqnames.com/?ref=<name>` | records who introduced a visitor (7 days, first wins); their next registration carries it as `G`'s `ref` and the referrer is paid a published share by the treasury |

A payment link is what an invoice or a checkout emits: it needs no
integration beyond building the URL. The `message` becomes the transaction's
data field, so it is bound by the two silent-failure rules — **64 bytes**,
and never the prefix `NNS1` — which the app checks before sending.
`asset=usdt` asks for the name's EVM address instead, and carries no message.

```js
const pay = (name, nim, ref) =>
  `https://nimiqnames.com/#/pay/${name}?amount=${nim}&message=${encodeURIComponent(ref)}`
pay('mycoolshop', '25', 'INV-42')
```

A payment link is a request, not an obligation: it commits nobody, proves
nothing, and the payer's app resolves and verifies the name exactly as if
they had typed it.

**Messaging an owner** is a convention the app implements, not protocol: a
dust transaction to the **owner's** address carrying `NC1<name>|<text>`
(≤ 64 bytes, never `NNS1`). `packages/chat` is the one parser;
`docs/app-chat.md` is the spec. It is invisible to every indexer by design.

---

## 10. Reference

### 10.1 Endpoints

All `GET`. `{name}` is a §1.4 name; `{addr}` a Nimiq address, spaces
optional.

```
/resolve/{name}          /available/{name}        /name/{name}
/address/{addr}/names    /offers                  /auctions
/params                  /checkpoints/latest      /checkpoints/{height}
/log                     /log/decoded             /settlements
/burn                    /referrals/{name}        /openapi.yaml
```

### 10.2 API error codes

| Status | `error` | Route | Meaning |
|---|---|---|---|
| 400 | `INVALID_NAME` | name routes | fails the rules; `reason` says which |
| 400 | `DOTTED_QUERY` | `/resolve` | subdomains are the client's job; `parent` names what to resolve |
| 400 | `INVALID_ADDRESS` | `/address`, `/settlements` | not a Nimiq address |
| 400 | `INVALID_HEIGHT` / `NOT_A_CHECKPOINT_HEIGHT` | `/checkpoints/{h}` | fix the request; checkpoints exist only on boundaries |
| 404 | `NOT_FOUND` | `/resolve`, `/name` | nobody holds it |
| 404 | `IN_GRACE` | `/resolve` | expired; owner can still renew; `expiry` given |
| 404 | `CHECKPOINT_PENDING` | `/checkpoints/{h}` | boundary not reached yet; `latest` given — wait |
| 404 | `CHECKPOINT_MISSING` | `/checkpoints/{h}` | inside the range, no row — this server has a gap |
| 404 | `NO_CHECKPOINT` | `/checkpoints/latest`, `/log` | none written yet |
| 404 | `UNKNOWN_ROUTE` | – | – |
| 405 | `METHOD_NOT_ALLOWED` | – | only `GET` |
| 410 | `CHECKPOINT_NOT_RETAINED` | `/checkpoints/{h}` | older than this server keeps; `oldest` given — ask a deeper server |
| 503 | `NOT_SYNCED` | every route | the indexer has no state yet; treat as "did not answer" |
| 500 | `INTERNAL` | – | – |

### 10.3 Library outcomes

Verification: `PROVEN` · `PROOF_PENDING` · `DELEGATED`.
Warnings: `QUORUM_BELOW_SPEC` · `ROOT_HEIGHTS_DIFFER` · `PROOF_PENDING` ·
`TARGET_CHANGED_SINCE_CHECKPOINT` · `DELEGATE_HOST_UNPROVEN` ·
`DELEGATED_ANSWER` · `ANCHOR_NOT_CHECKED` · `ANCHOR_UNAVAILABLE` ·
`ANCHOR_QUORUM_NOT_MET` · `ANCHOR_STALE`.
Errors: `NAME_INVALID` · `NOT_FOUND` · `IN_GRACE` · `QUORUM_UNMET` ·
`QUORUM_LAGGING` · `QUORUM_DISAGREEMENT` · `QUORUM_ROOT_MISMATCH` ·
`PROOF_INVALID` · `DOCUMENT_MALFORMED` · `DELEGATE_FAILED` ·
`CHECKPOINT_BINDING_INVALID` · `ANCHOR_MISMATCH` · `ANCHOR_DIVERGENCE`.

### 10.4 Constants

Read them from `@nimiqnames/core`'s `CONSTANTS`, never from this table, which is
here so a reader in another language knows the shape. The **public beta**
(era `tempo/2026-09-11`, live on the URLs below) runs compressed values so a
year passes in a week; **mainnet** values are what `main` compiles and what
launch will run. Everything registered in the beta is discarded at the launch
freeze.

| Constant | Mainnet (`main`) | Public beta | Meaning |
|---|---|---|---|
| `LAUNCH_HEIGHT` | 58,842,720 | 61,344,720 | first block an indexer reads |
| `FEE_BASE` | 400 NIM | 4 NIM | the 12+ character yearly fee; bands multiply it ×200/100/50/25/10/5/1 for lengths ≤2/3/4/5/6/7–11/12–24 |
| `LIFETIME_MULTIPLIER` / `LIFETIME_TERMS` | 10 / 100 | same | a lifetime is a hundred terms for ten fees |
| `TERM_LENGTH` | 31,536,000 (~1 y) | 604,800 (~1 w) | blocks per term |
| `GRACE_PERIOD` | 2,592,000 (30 d) | 86,400 (~1 d) | renewable after expiry |
| `CHECKPOINT_INTERVAL` | 720 | 60 | blocks between proofs |
| `XFER_TIMELOCK` | 43,200 | 600 | a transfer matures after this |
| `GOVERNANCE_DELAY` | 86,400 | 1,200 | a `P` takes effect after this |
| `REFUND_FLOOR` | 1 NIM | same | refunds below it are not owed |
| `DUST_VALUE` | 1 luna | same | value of a signalling message |
| `MAX_DATA_BYTES` | 64 | same | the network's data ceiling |
| `MAX_HOST_LEN` | 30 | same | delegate host length |
| `TREASURY_ADDRESS` | `NQ28 TKBF …` | same | `G`/`N` go here |
| `PROTOCOL_ADDRESS` | `NQ38 NKD4 …` | same | dust signalling goes here |
| `MARKETPLACE_ADDRESS` | `NQ71 TPMV …` | same | `B` goes here |

The four addresses in full are `CONSTANTS.TREASURY_ADDRESS` and friends in
`packages/core/src/constants.ts`; a client should read them from there or
from the recipient a `@nimiqnames/core` builder returns, never retype them.

### 10.5 Live URLs (2026-09-12)

| What | URL | Notes |
|---|---|---|
| The app | `https://nimiqnames.com` | Nimiq Pay mini app and web; docs at `#/docs/intro` |
| Resolver 1 | `https://api.nimiqnames.com` | in `DEFAULT_RESOLVERS` |
| Resolver 2 | `https://nns.sonartech.pro` | in `DEFAULT_RESOLVERS`. Same operator, separate box and separately replayed database — two indexes, not one mirrored twice |
| The browser bundle | `https://nimiqnames.com/nns.js` | `@nimiqnames/resolver` as one self-contained ES module (§3.1) |
| The reference delegate | `https://delegated.nimiqnames.com` | `GET /nns/rico` answers; a client can test its delegate step against it |
| Repository | `https://github.com/selfcrypto/nns` | `packages/`, `deploy/`, `docs/nns-spec-v1.md` |

The shipped default meets `RESOLVER_QUORUM` (2) with no configuration, so a
client that passes no `resolvers` at all still requires two agreeing answers
and a verified proof. Both entries are ours, which is the gap §7 asks you to
help close: the day a third, independently operated endpoint is listed, every
client that spread the defaults picks it up by upgrading the package — no code
change, and the count on screen goes up on its own.

### 10.6 Where to read more

- `packages/resolver/README.md` — the library, in full, with the UI wording.
- `packages/api/openapi.yaml` — every route and schema.
- `packages/delegate/README.md`, `deploy/delegate/README.md` — the host, the TLS recipes.
- `deploy/README.md`, `deploy/resolver/README.md` — running the roles.
- `docs/nns-spec-v1.md` — the protocol. §4 names, §5 wire, §6 messages, §7 rules, §8 checkpoints/proofs/clients, §9 anchoring, §10 economics.
