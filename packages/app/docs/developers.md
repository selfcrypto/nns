# Integrating NNS

Three ways in, from easiest to lowest level: the resolver library, [the HTTP API](api), and [the wire format](wire-format). Everything is MIT, and every rule the library applies comes from one reference implementation, `@nimiqnames/core`.

The exhaustive guide is `docs/integration.md` in the repository, [github.com/selfcrypto/nns](https://github.com/selfcrypto/nns): every route with live examples, verifying a proof in Python or Solidity, deposit subdomains for an exchange, and sending every message from the Hub, from Nimiq Pay and from your own node.

## Resolve a name in your app

```sh
npm install @nimiqnames/resolver
```

```ts
import { createResolver } from '@nimiqnames/resolver'

const nns = createResolver({})   // DEFAULT_RESOLVERS, quorum 2

const result = await nns.resolve('kike')
result.address        // 'NQ…', the address to pay
result.verification   // 'PROVEN' | 'PROOF_PENDING' | 'DELEGATED'
result.quorum         // { required, queried, agreed, resolvers: [{ name, url, ms }] }
result.warnings       // [{ code, detail }], things the user should be told
```

Keep the instance if you resolve more than one name. It carries the subdomain cache.

**The proof is checked before you get an answer, and you cannot turn that off.** A proof that does not hold throws, even when other resolvers agree.

**Before you let anyone pay to register**, call `nns.available(name)`. An available answer is backed by a proof of absence, not merely a missing reply.

## The resolver list ships in your bundle

`resolvers` is never fetched at runtime. Omit the option to take `DEFAULT_RESOLVERS`, or spread it and add your own:

```ts
createResolver({ resolvers: [...DEFAULT_RESOLVERS, { name: 'Mine', url: 'https://nns.example.org' }] })
```

Only ever **add**. Never replace, remove, or lower the quorum from a fetched source. A URL that appears twice is counted once, with `DUPLICATE_RESOLVER` on the result.

`quorum` defaults to 2. Setting it to 1 is allowed, and every result then carries `QUORUM_BELOW_SPEC`.

Both default endpoints are run by the same operator on two separately replayed boxes. That catches a bug or a bad deploy on one of them, not the operator ([Pre-launch status](status)).

## What `verification` means

| Value | Meaning | Show it as |
|---|---|---|
| `PROVEN` | A proof for this exact answer recombined to a root the quorum agrees on | The normal case |
| `PROOF_PENDING` | The name resolves and payments work. No checkpoint commits to this value yet (checkpoints are cut every ~{{dur:CHECKPOINT_INTERVAL}}) | Pending depth. Neutral, never red |
| `DELEGATED` | A subdomain, answered by the parent's host. The parent is proven, this address is not | Visibly different from both |

A name repointed since the last checkpoint comes back as `PROOF_PENDING` with a `TARGET_CHANGED_SINCE_CHECKPOINT` warning. Do not call that "verified": the proof covers the previous address.

## Subdomains

`resolve('alice.exchange')` resolves `exchange` with a proof, then asks the host its owner set. The result carries `verification: 'DELEGATED'` and a `DELEGATED_ANSWER` warning, and must look different in your UI from a proven answer. When the host fails, the `DelegateError` carries `.parent`, the parent's own verified resolution. Show it, and attribute the failure to the host, never to the subdomain: NNS cannot know whether a subdomain exists.

## Warnings and errors

Warnings ride on `result.warnings` and never stop a resolution.

| Tone | Codes |
|---|---|
| Pending depth | `PROOF_PENDING`, `TARGET_CHANGED_SINCE_CHECKPOINT`, `ANCHOR_QUORUM_NOT_MET` |
| Couldn't check | `ROOT_HEIGHTS_DIFFER`, `ANCHOR_UNAVAILABLE`, `ANCHOR_STALE` |
| Informational | `QUORUM_BELOW_SPEC`, `DELEGATED_ANSWER`, `DELEGATE_HOST_UNPROVEN`, `ANCHOR_NOT_CHECKED` |

Errors halt, and each carries a `code`.

| Class | Codes | Why it stops |
|---|---|---|
| `NameError` | `NAME_INVALID` | Not a valid name or query. Never hits the network |
| `LookupError` | `NOT_FOUND`, `IN_GRACE` | No address. `IN_GRACE` is expired, renewable, not free |
| `QuorumError` | `QUORUM_UNMET`, `QUORUM_DISAGREEMENT`, `QUORUM_ROOT_MISMATCH` | Too few answered, or they said different things (`.replies` says who said what) |
| `ProofError` | `PROOF_INVALID` | A served proof does not hold. Always fatal |
| `AnchorError` | `CHECKPOINT_BINDING_INVALID`, `ANCHOR_MISMATCH`, `ANCHOR_DIVERGENCE` | The operator's state is not the anchored one, or publishers contradict each other |
| `DocumentError` | `DOCUMENT_MALFORMED` | A reply is not the shape it must be |
| `DelegateError` | `PARENT_NOT_DELEGATING`, `DELEGATE_FAILED` | Carries `.parent` |
| `ConfigurationError` | `CONFIGURATION` | From the constructor |

A `QuorumError` or `AnchorError` in front of a user is the rare event that the proofs exist to catch. Show it as one.

## What your UI owes the user

**"Verified by N resolvers"**, with each agreeing resolver under it: its endpoint, the configured name where the URL does not already carry it, and the round trip. `N` is `result.quorum.agreed`, singular at 1. Do not label a healthy answer "unverified" because the count is small. Reserve red for the halting errors above.

**Render names in a face that separates `0`/`o`, `1`/`l` and `rn`/`m`**, and show the Nimiq identicon of `result.address` beside any address a user might pay. The stylesheet ships with the package:

```ts
import '@nimiqnames/resolver/rendering.css'   // then class="nns-name" on the element
```

## Anchors

Optional and off by default. Configure the anchor contract, at least two independently operated RPC endpoints, and the publisher list (`DEFAULT_ANCHOR_PUBLISHERS`), and every result is cross-checked against what was anchored on the EVM chain. Both defaults ship empty until launch fills them ([Pre-launch status](status)).
