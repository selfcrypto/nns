# @nns/resolver

Turn an NNS name into a Nimiq address, and check the answer before your users
pay it.

This is the library's own reference. The wider picture — the HTTP API from
any language, verifying proofs without this package, subdomains for an
exchange, writing to the registry, running a resolver — is
`docs/integration.md` at the repository root.

```sh
npm install @nns/resolver
```

```ts
import { createResolver } from '@nns/resolver'

// Zero configuration: the shipped resolver list has two public endpoints and
// the default quorum is 2, so this asks both and requires them to agree.
const nns = createResolver({})

const result = await nns.resolve('kike')
result.address       // 'NQ...' — the address to pay
result.verification  // 'PROVEN'
result.quorum        // { required: 2, queried: 2, agreed: 2, resolvers: [{ name, url }, …] }
result.warnings      // [] — anything the user should be told, see below
```

NNS has **no smart contract**. Names live in Nimiq transaction data, and
independent operators replay the chain into a `name → address` table and serve
it over HTTP. That means an operator's answer is just an operator's word — so
this package does not relay it. Every answer arrives with a Merkle proof
against a published checkpoint root, and this package rebuilds the leaf,
recombines the proof, and compares what several operators say before it returns
an address. **You cannot turn that off**; there is no option for it.

Browser and Node 20+, TypeScript, MIT, two dependencies (`@nns/core`,
`@nns/anchor`), no Node builtins, no font downloads, no telemetry.

**No bundler?** `dist/nns.js` is the same source as one self-contained ES
module — 68 kB, 24 kB over the wire, importing nothing:

```html
<script type="module">
  import { createResolver } from 'https://cdn.jsdelivr.net/npm/@nns/resolver/dist/nns.js'
  const { address } = await createResolver({}).resolve('kike')
</script>
```

---

## Install and construct

```sh
npm install @nns/resolver
```

```ts
const nns = createResolver({
  resolvers,          // required today — see "Who you ask", below
  quorum,             // how many must agree. Default 2
  anchors,            // optional second-chain cross-check. See "Anchors"
  timeoutMs,          // per request. Default 5000
  delegateTimeoutMs,  // for a delegate host. Defaults to timeoutMs, then 5000
  fetch,              // your own fetch. Default: the global one
  onWarning,          // called for every warning, in addition to result.warnings
})
```

Hold on to the instance if you resolve more than one name — it carries the
delegation cache. `resolve(query, options)` is a one-shot convenience that
throws it away.

Two calls:

- `await nns.resolve(name)` → `ResolveResult`, or throws.
- `await nns.available(name)` → `AvailableResult`, or throws. Ask this before
  you let anyone pay a registration fee: an available answer is backed by a
  **non-inclusion** proof, which is a proof that the name is genuinely absent
  from the checkpoint rather than merely missing from one operator's reply.

---

## Who you ask, and how many have to agree

`resolvers` is a list of independent NNS APIs. Each entry has a `name` — not
decoration: when two operators disagree the error has to say *which parties*
said different things, and a URL is not a party. That name is what you show the
user.

`quorum` is how many of them must return the same answer. The default is 2,
which is what the spec asks for, and the reason is simple: one party's proofs
are internally consistent whether or not that party is honest. A resolver that
invents a whole state can serve you a perfectly valid proof of its invention.
Only a second, independent party can catch that.

**Setting `quorum` below 2 is supported and it is loud.** The constructor logs
a warning once, and — more importantly — every single result carries a
`QUORUM_BELOW_SPEC` warning for as long as the client runs that way. Not once
per session: once per answer. If you lower the quorum, your UI has the fact in
its hands on every resolution, and what you do with it is a decision you are
making visibly rather than one this package makes quietly for you.

A `quorum` larger than the list you passed throws from the constructor. A
quorum that cannot be met is a quorum that is not enforced.

### The list ships in the client; it is never fetched

`DEFAULT_RESOLVERS` and `DEFAULT_ANCHOR_PUBLISHERS` are exported so you can
spread them:

```ts
resolvers: [...DEFAULT_RESOLVERS, { name: 'Ours', url: 'https://nns.ours.example' }]
```

Written that way, the day either default grows an entry you pick it up by
upgrading this package, not by editing your own code.

**`DEFAULT_RESOLVERS` has two entries** (since 2026-09-13) and
`DEFAULT_ANCHOR_PUBLISHERS` is still empty, because no anchor contract exists
on any chain yet. Omitting `resolvers` therefore works and meets the default
quorum; passing an **empty** list still throws a `ConfigurationError`, since
that is a mistake rather than a choice.

Listing the same URL twice does not raise the quorum. The repeat is dropped
and a `DUPLICATE_RESOLVER` warning rides on every result — it warns rather
than throws because the ordinary way to get there is an app that added an
endpoint by hand and then upgraded on the day that endpoint joined the
defaults, and breaking that app would punish the operator who got listed.

If a directory of operators is published somewhere (a `resolvers.json` in a
repo, say), you may use it to **add** endpoints to your list. Never to replace
one, remove one, or lower `quorum`. A fetched list can be substituted for one
user, on one network, leaving no trace anywhere; a list compiled into your
bundle can only be corrupted by publishing a version of it, which is one lie
told to everyone at once and permanently inspectable. Adding endpoints can only
make an answer harder to obtain — quorum here is an AND, never a vote — so
add-only is safe in a way that replace is not.

### Two resolvers, one operator — say which of the two checks you are getting

State it plainly, because your users deserve it stated plainly: **the two
endpoints in `DEFAULT_RESOLVERS` are run by the same operator that publishes
this package.** A client on the defaults alone is trusting one party twice.

That is not the same as trusting one endpoint, and the difference is worth
being precise about, because there are two distinct checks here and this
configuration buys exactly one of them.

- **The determinism check — yes.** The two are separately replayed: their own
  database, their own host, their own provider, each one rebuilding the
  registry from the chain on its own. Agreement means the reducer produced the
  same bytes on two machines and neither one drifted, resynced past its
  history horizon, or took a bad deploy. That is the failure mode this whole
  design rests on not having, and a single endpoint cannot detect it at all.
- **The independence check — no.** They share code and they share an operator,
  so a bug in the shared reducer produces the same wrong answer twice, and a
  deliberate lie can be told twice. A `required: 2` here is not two parties
  corroborating each other.

An earlier version of this file argued that a second box under one operator
was therefore *worse* than one, because it claims corroboration that never
happened. That was right about the claim and wrong about the remedy: the
remedy is to name what the count means, not to withhold a check that catches
the most likely failure. So the resolvers are **named** on every result
(`quorum.resolvers`), and two names under one operator are visible as such to
anyone who looks — rather than a quorum of 1 that silently checks less.

What is still missing is precisely the cross-party comparison: an operator
serving a wholly fabricated state passes the proof check, the checkpoint
binding and the agreement of its own two boxes. The mitigations are the §9
anchor tier — a **different chain, parties who are not the resolver** — and,
above everything, a third endpoint someone else runs.

**When an independent operator appears**, they run their own indexer against
their own Nimiq node on unshared infrastructure and a version of this package
ships with them in `DEFAULT_RESOLVERS`. Apps that spread the defaults pick
them up by upgrading, the count they display moves from 2 to 3, and nothing in
their code changes. If that could be you, `docs/integration.md` §7 is the
whole procedure and it is the most useful thing an integrator can contribute.

---

## What comes back

```ts
interface ResolveResult {
  query         // what you asked, verbatim
  name          // the registered name that carried the answer
  address       // what to pay
  verification  // 'PROVEN' | 'PROOF_PENDING' | 'DELEGATED'
  host          // the delegate host this name designates, '' when none
  checkpoint    // { rootHex, height } the proof was against, or null
  height        // chain height this answer is as of
  delegate      // set only for a dotted query, e.g. 'alice.exchange'
  quorum        // { required, queried, agreed, resolvers: [{ name, url }] } — who agreed
  anchor        // what the second-chain check concluded, or why it did not run
  warnings      // everything the user should be told; see the table
}
```

### `verification`

| Value | Means | Show it as |
|---|---|---|
| `PROVEN` | A proof for **this exact answer** recombined to a root the quorum stands behind | The normal, good case |
| `PROOF_PENDING` | The name resolves and payments to it work; no checkpoint commits to this value yet | Pending depth — neutral, not an alarm |
| `DELEGATED` | A delegate host answered (see below). The parent is proven; this address is not | Visibly different from the two above |

`PROOF_PENDING` is a clock, not a fault. Checkpoints are cut every ~720 blocks
(~12 minutes), so a name registered or repointed since the last one has no
proof to serve yet. It carries a `PROOF_PENDING` warning whose wording is
deliberately about depth. Do not put a red badge on it: it is the expected
state of every fresh registration, and a warning users see on every healthy
day is a warning they stop reading.

### A **missing** proof and a **failed** proof are not the same thing

This is the single most important line in the package, and conflating the two
breaks it in one direction or the other.

- **Missing** — the operator served `proof: null`. The checkpoint simply is not
  due. You get a normal result with `PROOF_PENDING`. Nothing is wrong.
- **Failed** — the operator served a proof and it does not recombine. That
  **always throws** `ProofError`, with no degraded mode and no result to
  inspect. It throws even when the other resolvers agree with each other:
  dropping the liar and answering from the honest majority is exactly how
  whoever controls one resolver would degrade your quorum silently.

There is a third state that falls out of two clocks running at once, and it is
worth handling on purpose: a proof that **verifies** but commits to a
*different* address than the live answer, because the name was repointed since
the last checkpoint. That is `PROOF_PENDING` plus a
`TARGET_CHANGED_SINCE_CHECKPOINT` warning. The answer is good — it is the
current one — but calling it "verified on-chain" would be false *about the
address the user is about to pay*, which is the only thing the claim is for.

### Dotted queries and `DELEGATED_ANSWER`

`alice.exchange` means "ask exchange's delegate resolver about alice". This
package resolves `exchange` normally, with a proof, then asks the host that
name designates.

**Proven: the parent, and the fact that it designates this host. Not proven:
the address that comes back.** No cryptography vouches for it at all — you have
an exchange's word about its own deposit address, which is a reasonable thing
to trust and a completely different claim from a verified name. Every such
result carries `DELEGATED_ANSWER` and `verification: 'DELEGATED'`, and it must
look different in your UI from a `PROVEN` answer. This package deliberately
does not let an NNS API proxy these for you, because an unverified answer
served from an endpoint that looks verified is unverifiable by anyone
downstream.

**When the delegate host fails, you still have the parent.** Every
`DelegateError` carries `.parent` — the parent's own resolution, proof and all
— so the failure renders as "`exchange` resolves to NQ…, and the host its owner
runs did not answer", not as NNS being down. Show it. A third party's cold
server should never read as a broken registry.

```ts
try {
  const result = await resolver.resolve('alice.exchange')
} catch (error) {
  if (error instanceof DelegateError) {
    error.parent // ResolveResult for `exchange`, or null — verified, still worth showing
  }
}
```

**You cannot tell why the host failed, and neither can we.** A 404, a timeout,
a DNS failure, a 502 and a reply in the wrong shape all arrive as one
`DELEGATE_FAILED`. That is deliberate: the answer lives in a file on someone
else's server, so "no such subdomain" is indistinguishable from a removal, a
typo or a misconfigured host — and NNS is not entitled to claim the first.
Attribute the failure to the host, never to the subdomain. "exchange's
resolver did not answer" is honest; "alice.exchange does not exist" is not.

The request carries the parent as well as the label (r23), so a host serving
several names can tell the questions apart: `shop.a` and `shop.b` are
different requests and may get different answers. Answers are cached under
host, parent and label together — the same triple the request carries.

---

## Anchors: the checkpoint, cross-checked on another chain

Optional, off unless you configure it, and **zero requests when it is off**.

```ts
anchors: {
  contract: '0x…',                        // the anchor contract
  rpcs: ['https://…', 'https://…'],       // at least two, independently operated
  publishers: [...DEFAULT_ANCHOR_PUBLISHERS],
}
```

Publishers post each NNS checkpoint's commitment to a contract on another
chain. The client reads it back and requires the checkpoint its answer was
proven against to be the one that was published. Two RPC endpoints is a refusal
rather than a suggestion: the provider is chosen by your app, so a single
endpoint feeding you a false anchor cannot be caught by anything.

An address not in `publishers` is ignored — never counted, never a mismatch —
so the list is the whole of publisher admission, and a typo in it silently
lowers the protection you actually have. The constructor rejects malformed
entries for that reason.

`result.anchor.status`:

| Status | Meaning | Hard stop? |
|---|---|---|
| `verified` | Enough listed publishers anchored this exact checkpoint | No — the good case, and it warns about nothing unless the anchor is stale |
| `not-checked` | The check did not run. `result.anchor.reason` says why (no policy, no proof to anchor, or the operator could not supply the checkpoint document) — except with no publishers listed, where the reader itself declined and says so at `result.anchor.check.reason` | No |
| `unavailable` | Fewer than two RPC endpoints answered | No |
| `rpc-disagreement` | The endpoints contradict each other about what is on chain, so nothing was confirmed | No |
| `quorum-not-met` | Fewer publishers have anchored this checkpoint than required, so far | No — pending depth |
| `divergence` | Listed publishers anchored **conflicting** values at this height | **Yes** — throws `AnchorError` |

Three outcomes halt with an `AnchorError` and never reach you as a status:

- `ANCHOR_DIVERGENCE` — the parties you trust to agree do not, and the client
  has no basis to pick.
- `ANCHOR_MISMATCH` — publishers anchored something other than what this
  operator served. Its state is not the state that was anchored.
- `CHECKPOINT_BINDING_INVALID` — the operator's own checkpoint document
  contradicts the proof it served, or itself. One party, two states.

Everything else is "couldn't check", and must be worded that way. An absent or
contradicted anchor is **never** read as confirmation, and an anchor that
passes says nothing at all.

---

## Warnings, and what each one means for your UI

Every warning rides on `result.warnings` as `{ code, detail }`; `detail` is a
sentence you can show or log. None of them stop a resolution. Pass `onWarning`
if you also want them pushed to you as they happen.

| Code | What it means | Tone |
|---|---|---|
| `QUORUM_BELOW_SPEC` | Fewer than 2 resolvers are configured to agree | Informational, and permanent while true. Disclose it — see the wording section |
| `PROOF_PENDING` | No checkpoint commits to this answer yet | Pending depth. Neutral |
| `TARGET_CHANGED_SINCE_CHECKPOINT` | A proof verified, but for the previous address — this one is newer | Pending depth. Neutral. Do **not** call it verified |
| `DELEGATE_HOST_UNPROVEN` | The delegate host came from the live record, not a proven one | Informational |
| `DELEGATED_ANSWER` | This address came from a delegate host and nothing vouches for it | Must be visually distinct from a proven answer |
| `ROOT_HEIGHTS_DIFFER` | Resolvers were at different checkpoints and the cross-height comparison **could not complete** | "Couldn't check". `detail` names which resolver and why |
| `ANCHOR_NOT_CHECKED` | The second-chain check did not run | Informational. Nothing was found wrong |
| `ANCHOR_UNAVAILABLE` | It ran and could not conclude | "Couldn't check" |
| `ANCHOR_QUORUM_NOT_MET` | Not enough publishers have anchored yet | Pending depth. This is the standing state for the first hours after every checkpoint |
| `ANCHOR_STALE` | The newest anchor is older than 48 h, or the scanned window held none | "Couldn't check" — the client cannot tell "nothing changed" from "the publisher stopped" |

Note what `ROOT_HEIGHTS_DIFFER` does *not* mean. Independent resolvers sit a
checkpoint apart routinely, and that alone is lag rather than conflict — so
when heights differ, the ahead resolver is asked what root it had at the
behind one's boundary, and a successful comparison emits nothing at all. You
only see this warning when that comparison could not run. A disagreement, at
the same height or across heights, is not a warning: it throws.

### Errors that halt

Everything below is a subclass of `ResolverError` and carries a `code`.

| Class | Codes | Why it stops |
|---|---|---|
| `NameError` | `NAME_INVALID` | Not a valid name or dotted query. Never hit the network |
| `LookupError` | `NOT_FOUND`, `IN_GRACE` | The name resolves to nothing. `IN_GRACE` means it expired and is in its 30-day grace period, where resolution is off but the name is not yet free |
| `QuorumError` | `QUORUM_UNMET`, `QUORUM_LAGGING`, `QUORUM_DISAGREEMENT`, `QUORUM_ROOT_MISMATCH` | Too few answered, or they said different things. Carries `.replies`, so you can show which party said what. **Two of these are not alarms**: `QUORUM_UNMET` is "couldn't reach enough of them", and `QUORUM_LAGGING` is "they answered as of different heights and differ" — the seconds after a change lands, when one resolver has the block and another does not. Ask again in a few seconds; say the change is still propagating, never that the resolvers disagree. A disagreement is measured **at one height**, exactly as a root mismatch is |
| `ProofError` | `PROOF_INVALID` | A served proof does not hold. Always fatal |
| `AnchorError` | `CHECKPOINT_BINDING_INVALID`, `ANCHOR_MISMATCH`, `ANCHOR_DIVERGENCE` | See above. Carries `.check` |
| `DocumentError` | `DOCUMENT_MALFORMED` | A reply is not the shape it must be. `.path` points at the field |
| `DelegateError` | `PARENT_NOT_DELEGATING`, `DELEGATE_FAILED` | A dotted query whose parent delegates nowhere, or whose host failed. Carries `.parent`, the parent's own verified resolution — show it |
| `ConfigurationError` | `CONFIGURATION` | Thrown from the constructor: a policy that cannot enforce itself |

A `QuorumError` or an `AnchorError` in front of a user is the rare event this
whole design exists to surface. Treat it as one.

---

## Telling the user: "Verified by N resolvers"

One neutral line, always present on a successful resolution, with the parties
that agreed listed under it:

> **Verified by 2 resolvers**
> Example Labs — https://nns.example.org
> Second Operator — https://nns.other.example

`N` is `result.quorum.agreed`. Singular at 1. There is no variant of this line
that is hidden, greyed, or apologetic — hiding the count while it is 1 hides the
one number worth knowing, and showing nothing reads as "fine".

**Name every resolver that agreed, by name and by API URL.** The count says how
many parties an answer rests on and nothing about which, so at `N` = 2 a user
who wants to check one has nowhere to go; and the `name` is a label the host app
chose, which identifies a party only to whoever wrote the config. `quorum.resolvers`
therefore carries the endpoint — `{ name, url }` — and the client shows both.

The list may sit behind a **disclosure on the count line, closed by default**,
and on a phone it should: a quorum of eight is longer than the answer it
supports. What this rule forbids is a client where the list is *absent* — a
count with nowhere to go — or where the count itself is hidden.

**Do not label an answer "unverified" because the quorum is small.** It is
factually wrong: the proof verified, the checkpoint binding held, and — with
publishers configured — another chain agrees. Every check the client ran
passed. What is thin is the number of parties that corroborate it, which is a
different sentence, and `quorum.resolvers` is where that sentence belongs.
This is the rule at `required: 2` with the shipped defaults, and it is the same
rule for an operator who deliberately configures a single endpoint of their own.

And the cost of saying it anyway is the thing this design exists to prevent. If
the normal, healthy, everyday answer is labelled "unverified", users learn
within a week that the word is decoration — and then a real divergence arrives
wearing the same word and gets dismissed as normal. **Alarm vocabulary spends
down to zero the first time you use it on a non-alarm.**

So reserve red, warning glyphs, "unverified", "do not pay" and "divergence"
for the halting failures: a proof that did not verify, `QUORUM_ROOT_MISMATCH`,
`CHECKPOINT_BINDING_INVALID`, `ANCHOR_MISMATCH`, `ANCHOR_DIVERGENCE`. Phrase
every non-halting status as "couldn't check" or as pending depth, never as
"wrong". A count also refuses to overstate in the other direction: "Verified ✓"
would say the same thing at N = 1 and at N = 5.

---

## Rendering a name

Two failure modes are visual rather than cryptographic, and both end with a
user paying the wrong person while every check passes.

### The typeface (ships as CSS, because advice does not get followed)

`0` and `o`, `1` and `l`, and `rn` and `m` are the same shape in most
proportional faces. A name drawn in one of those faces produces no error and no
warning — just a name that reads as a different name. So the rule ships as a
stylesheet you adopt by adopting the package.

With a bundler or a `<link>`:

```ts
import '@nns/resolver/rendering.css'
```

With no build step:

```ts
import { injectRenderingCss } from '@nns/resolver'
injectRenderingCss(document)   // idempotent; call it wherever you need it
```

Then put the class on **the element that shows or accepts a name, and nothing
else**:

```html
<span class="nns-name">nimiq-foundation</span>
<input class="nns-name" … />
```

`NNS_NAME_CLASS` is exported if you build class names programmatically, and
`RENDERING_CSS` is the stylesheet as a string.

The stylesheet is scoped to that one class plus a rule for form controls (which
do not inherit font size, and an input rendering smaller than its surroundings
is the worst possible place for that). There is no `:root`, no element
selector, and no `@layer`, so it drops into any design system without touching
it.

It **references** fonts and never embeds them: no `@font-face`, no binary, no
third-party request, because a stylesheet that fetched a font would add a party
who learns every user's IP to a package whose entire argument is fewer parties.
Load JetBrains Mono, IBM Plex Mono or Inter yourself for the best case; if you
load nothing, the stack lands on the platform monospace, which already
separates the confusable pairs. Two variables let you substitute your own face:

```css
.nns-name {
  --nns-name-font-family: "Your Mono", monospace;  /* keep a monospace last */
  --nns-name-font-features: "ss02" 1, "zero" 1;
}
```

Keep a monospace at the end of whatever you put there. That last entry is the
load-bearing one — it is what an app loading no webfont actually gets, and a
proportional sans in that slot is the silent failure this file exists to
prevent.

### The identicon

Show the **Nimiq identicon of the resolved address** next to the name.

It closes the gap the typeface cannot. Two names can be visually confusable in
ways no font fixes — different scripts, a hyphen in a plausible place, a name
the user half-remembers. The identicon is derived from the address, so it is a
picture of *what will actually be paid*: a user who has sent to a name before
recognises the wrong one immediately, without reading 36 characters. Show it at
the moment of confirmation, beside the name, from `result.address` — and where
possible let the wallet render it again in its own trusted UI before signing.

Do not render an identicon for a `DELEGATED` answer without also carrying the
distinction through: the picture is honest about the address, but the address
itself is only the delegate host's word.

---

## Verifying documents you obtained some other way

`readResolveResponse`, `readInclusionDocument`, `readNonInclusionDocument`,
`readAvailableResponse`, `verifyInclusion` and `verifyNonInclusion` are all
exported. If a proof reaches you by another route — a cached response, a QR
code, another implementation's output — run these against it rather than
writing your own check. A second implementation of the verification is the one
place a divergence could enter.

Every protocol rule this package applies is `@nns/core`'s: name syntax, leaf
encoding, proof recombination, ordering. Nothing is restated here, so there is
nothing here that can drift from it.

---

MIT.
