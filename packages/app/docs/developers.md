# Integrating NNS

Three ways in, from easiest to lowest level: the resolver library, [the HTTP API](api), and [the wire format](wire-format) itself. Everything is MIT, and every rule the library applies comes from one reference implementation, `@nimiqnames/core`, so nothing here can drift from the protocol.

This page is the short form. The exhaustive guide is `docs/integration.md` in the repository, `github.com/selfcrypto/nns`: every route with live examples, the library's full result and error shapes, verifying a proof in Python or Solidity, deposit subdomains for an exchange, sending every message from the Hub, from Nimiq Pay and from your own node.

## Resolve a name in your app

```sh
npm install @nimiqnames/resolver
```

```ts
import { createResolver } from '@nimiqnames/resolver'

const nns = createResolver({})   // DEFAULT_RESOLVERS, quorum 2. Nothing to configure

const result = await nns.resolve('kike')
result.address        // 'NQ…', the address to pay
result.verification   // 'PROVEN' | 'PROOF_PENDING' | 'DELEGATED'
result.quorum         // { required, queried, agreed, resolvers: [{ name, url, ms }] }
result.warnings       // [{ code, detail }], things the user should be told
```

Keep the instance if you resolve more than one name. It carries the subdomain cache.

**The proof is checked before you get an answer, and you cannot turn that off.** Every resolver reply carries a Merkle proof. The library rebuilds the leaf, recombines the path, and compares the result to the resolver's own published checkpoint. A proof that does not hold throws, even when other resolvers agree. Dropping the liar and answering from the rest is exactly how someone controlling one resolver would degrade your quorum silently.

**Before you let anyone pay to register**, call `nns.available(name)`. An available answer is backed by a proof of *absence* from the checkpoint, not merely a missing reply.

## The resolver list ships in your bundle

`resolvers` is never fetched at runtime. A list downloaded at runtime can be swapped for one user on one network without a trace. A list compiled into your app can only change by publishing a version everyone can inspect. Omit the option to take `DEFAULT_RESOLVERS`, or spread it and add your own, so upgrades bring new operators. Only ever **add**: never replace, remove, or lower the quorum from a fetched source. A URL that appears twice is counted once, with `DUPLICATE_RESOLVER` on the result.

`quorum` defaults to 2 and is how many resolvers must agree, which the shipped list satisfies on its own. Setting it to 1 is allowed and loud: every result carries `QUORUM_BELOW_SPEC` for as long as you run that way.

Both default endpoints are run by the same operator on two separately replayed boxes. That catches a bug or a bad deploy on one of them. It does not catch the operator. The names and URLs are in `result.quorum.resolvers` so a user can see which they are getting ([Pre-launch status](status)).

## What `verification` means

| Value | Meaning | Show it as |
|---|---|---|
| `PROVEN` | A proof for this exact answer recombined to a root the quorum stands behind | The normal, good case |
| `PROOF_PENDING` | The name resolves and payments work. No checkpoint commits to this value yet (checkpoints are cut every ~{{dur:CHECKPOINT_INTERVAL}}) | Pending depth. Neutral, never red |
| `DELEGATED` | A subdomain, answered by the parent's host. The parent is proven, this address is not | Visibly different from both |

A proof that verifies for the *previous* address, because the name was repointed since the last checkpoint, comes back as `PROOF_PENDING` with a `TARGET_CHANGED_SINCE_CHECKPOINT` warning. Do not call that "verified on chain": it would be false about the address the user is about to pay.

## Subdomains

`resolve('alice.exchange')` resolves `exchange` with a proof, then asks the host its owner set. The result carries `verification: 'DELEGATED'` and a `DELEGATED_ANSWER` warning, and must look different in your UI from a proven answer. When the host fails, the `DelegateError` carries `.parent`, the parent's own verified resolution. Show it, so a third party's cold server never reads as NNS being down. Attribute the failure to the host, never to the subdomain: a 404, a timeout and a bad reply are indistinguishable, and NNS is not entitled to say a subdomain does not exist.

## Warnings and errors

Warnings ride on `result.warnings` and never stop a resolution. Their tone is fixed.

| Tone | Codes |
|---|---|
| Pending depth | `PROOF_PENDING`, `TARGET_CHANGED_SINCE_CHECKPOINT`, `ANCHOR_QUORUM_NOT_MET` |
| Couldn't check | `ROOT_HEIGHTS_DIFFER`, `ANCHOR_UNAVAILABLE`, `ANCHOR_STALE` |
| Informational | `QUORUM_BELOW_SPEC`, `DELEGATED_ANSWER`, `DELEGATE_HOST_UNPROVEN`, `ANCHOR_NOT_CHECKED` |

Errors halt, and each carries a `code`.

| Class | Codes | Why it stops |
|---|---|---|
| `NameError` | `NAME_INVALID` | Not a valid name or query. Never hit the network |
| `LookupError` | `NOT_FOUND`, `IN_GRACE` | No address. `IN_GRACE` is expired, renewable, not free |
| `QuorumError` | `QUORUM_UNMET`, `QUORUM_DISAGREEMENT`, `QUORUM_ROOT_MISMATCH` | Too few answered, or they said different things (`.replies` says who said what) |
| `ProofError` | `PROOF_INVALID` | A served proof does not hold. Always fatal |
| `AnchorError` | `CHECKPOINT_BINDING_INVALID`, `ANCHOR_MISMATCH`, `ANCHOR_DIVERGENCE` | The operator's state is not the anchored one, or publishers contradict each other |
| `DocumentError` | `DOCUMENT_MALFORMED` | A reply is not the shape it must be |
| `DelegateError` | `PARENT_NOT_DELEGATING`, `DELEGATE_FAILED` | Carries `.parent` |
| `ConfigurationError` | `CONFIGURATION` | From the constructor: a policy that cannot enforce itself |

A `QuorumError` or `AnchorError` in front of a user is the rare event this design exists to surface. Treat it as one.

## The two lines your UI owes the user

**"Verified by N resolvers"**, with each agreeing resolver listed under it on one line: the endpoint it answered at, the configured name where the URL does not already carry it, and the round trip in milliseconds. `N` is `result.quorum.agreed`, singular at 1, never hidden or greyed. Do not label a healthy answer "unverified" because the count is small. The proof verified, and alarm vocabulary spent on a healthy answer is worthless the day a real divergence arrives wearing the same word. Reserve red for the halting errors above.

**Render names in a face that separates `0`/`o`, `1`/`l` and `rn`/`m`**, and show the Nimiq identicon of `result.address` beside any address a user might pay. The stylesheet ships with the package:

```ts
import '@nimiqnames/resolver/rendering.css'   // then class="nns-name" on the element
```

It references fonts and never embeds them, so it adds no third party who learns your users' IPs.

## Anchors

Optional and off by default. Configure the anchor contract, at least two independently operated RPC endpoints, and the publisher list (`DEFAULT_ANCHOR_PUBLISHERS`), and every result is cross-checked against what was anchored on the EVM chain. Publishers not on the list are ignored, never counted. Both defaults ship empty until launch fills them ([Pre-launch status](status)).

## Running your own resolver

The library asks resolvers, and nothing stops you being one ([Running your own](operators)).
