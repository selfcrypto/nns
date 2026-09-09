# Integrating NNS

Three ways in, from easiest to lowest level: the resolver library, the HTTP API, and the wire format itself. Everything on this page is MIT, and every rule the library applies comes from one reference implementation, `@nns/core`, so nothing here can drift from the protocol.

## Resolve a name in your app

```sh
npm install @nns/resolver
```

```ts
import { createResolver, DEFAULT_RESOLVERS } from '@nns/resolver'

const nns = createResolver({
  resolvers: [...DEFAULT_RESOLVERS],   // { name, url } pairs, shipped in your bundle
})

const result = await nns.resolve('kike')
result.address        // 'NQ…' — the address to pay
result.verification   // 'PROVEN' | 'PROOF_PENDING' | 'DELEGATED'
result.quorum         // { required, queried, agreed, resolvers: [{ name, url }] }
result.warnings       // [{ code, detail }] — things the user should be told
```

Keep the instance if you resolve more than one name; it carries the subdomain cache.

**The proof is checked before you get an answer, and you cannot turn that off.** Every resolver reply carries a Merkle proof; the library rebuilds the leaf, recombines the path, and compares the result to the resolver's own published checkpoint. A proof that does not hold throws, even when other resolvers agree — dropping the liar and answering from the rest is exactly how someone controlling one resolver would degrade your quorum silently.

**Before you let anyone pay to register**, call `nns.available(name)`. An available answer is backed by a proof of *absence* from the checkpoint, not merely a missing reply.

### The resolver list ships in your bundle

`resolvers` is required and is never fetched at runtime. A list downloaded at runtime can be swapped for one user on one network without a trace; a list compiled into your app can only change by publishing a version everyone can inspect. Spread `DEFAULT_RESOLVERS` so upgrades bring new operators, and only ever **add** to it — never replace, remove, or lower the quorum from a fetched source.

`quorum` defaults to 2 and is how many resolvers must agree. Setting it to 1 is allowed and loud: every result carries `QUORUM_BELOW_SPEC` for as long as you run that way. At launch there is one resolver, so the launch app sets `quorum: 1` explicitly ([Status](status)).

### What `verification` means

| Value | Meaning | Show it as |
|---|---|---|
| `PROVEN` | A proof for this exact answer recombined to a root the quorum stands behind | The normal, good case |
| `PROOF_PENDING` | The name resolves and payments work; no checkpoint commits to this value yet (checkpoints are cut every ~{{dur:CHECKPOINT_INTERVAL}}) | Pending depth. Neutral, never red |
| `DELEGATED` | A subdomain, answered by the parent's host. The parent is proven; this address is not | Visibly different from both |

A proof that verifies for the *previous* address, because the name was repointed since the last checkpoint, comes back as `PROOF_PENDING` with a `TARGET_CHANGED_SINCE_CHECKPOINT` warning. Do not call that "verified on-chain": it would be false about the address the user is about to pay.

### Subdomains

`resolve('alice.exchange')` resolves `exchange` with a proof, then asks the host its owner set. The result carries `verification: 'DELEGATED'` and a `DELEGATED_ANSWER` warning, and must look different in your UI from a proven answer. When the host fails, the `DelegateError` carries `.parent`, the parent's own verified resolution: show it, so a third party's cold server never reads as NNS being down. Attribute the failure to the host, never to the subdomain — a 404, a timeout and a bad reply are indistinguishable, and NNS is not entitled to say a subdomain does not exist.

### Warnings and errors

Warnings ride on `result.warnings` and never stop a resolution. Their tone is fixed: `PROOF_PENDING`, `TARGET_CHANGED_SINCE_CHECKPOINT` and `ANCHOR_QUORUM_NOT_MET` are pending depth; `ROOT_HEIGHTS_DIFFER`, `ANCHOR_UNAVAILABLE` and `ANCHOR_STALE` are "couldn't check"; `QUORUM_BELOW_SPEC`, `DELEGATED_ANSWER`, `DELEGATE_HOST_UNPROVEN` and `ANCHOR_NOT_CHECKED` are informational.

Errors halt, and each carries a `code`:

| Class | Codes | Why it stops |
|---|---|---|
| `NameError` | `NAME_INVALID` | Not a valid name or query. Never hit the network |
| `LookupError` | `NOT_FOUND`, `IN_GRACE` | No address. `IN_GRACE`: expired, renewable, not free |
| `QuorumError` | `QUORUM_UNMET`, `QUORUM_DISAGREEMENT`, `QUORUM_ROOT_MISMATCH` | Too few answered, or they said different things (`.replies` says who said what) |
| `ProofError` | `PROOF_INVALID` | A served proof does not hold. Always fatal |
| `AnchorError` | `CHECKPOINT_BINDING_INVALID`, `ANCHOR_MISMATCH`, `ANCHOR_DIVERGENCE` | The operator's state is not the anchored one, or publishers contradict each other |
| `DocumentError` | `DOCUMENT_MALFORMED` | A reply is not the shape it must be |
| `DelegateError` | `PARENT_NOT_DELEGATING`, `DELEGATE_FAILED` | Carries `.parent` |
| `ConfigurationError` | `CONFIGURATION` | From the constructor: a policy that cannot enforce itself |

A `QuorumError` or `AnchorError` in front of a user is the rare event this design exists to surface. Treat it as one.

### The two lines your UI owes the user

**"Verified by N resolvers"**, with each agreeing resolver's name and URL listed under it. `N` is `result.quorum.agreed`, singular at 1, never hidden or greyed. Do not label a quorum-1 answer "unverified": the proof verified, and alarm vocabulary spent on a healthy answer is worthless the day a real divergence arrives wearing the same word. Reserve red for the halting errors above.

**Render names in a face that separates `0`/`o`, `1`/`l` and `rn`/`m`**, and show the Nimiq identicon of `result.address` beside any address a user might pay. The stylesheet ships with the package:

```ts
import '@nns/resolver/rendering.css'   // then class="nns-name" on the element
```

It references fonts and never embeds them, so it adds no third party who learns your users' IPs.

### Anchors

Optional and off by default. Configure the anchor contract, at least two independently operated RPC endpoints, and the publisher list (`DEFAULT_ANCHOR_PUBLISHERS`), and every result is cross-checked against what was anchored on the EVM chain. Publishers not on the list are ignored, never counted. Both defaults ship empty until launch fills them ([Status](status)).

## The HTTP API

Every resolver serves the same read-only API, described by its own `GET /openapi.yaml`. CORS is open to any origin. Until the indexer has written state, every state route answers `503 NOT_SYNCED`.

| Route | Answers |
|---|---|
| `/resolve/{name}` | The address, the record, and its inclusion proof against the latest checkpoint |
| `/available/{name}` | Whether the name can be registered, with a proof of absence |
| `/name/{name}` | Everything known: the record or `null`, `reserved`, `unreserved`, and `pending.transfer` / `.offer` / `.auction` (never both of the last two) |
| `/address/{addr}/names` | Names an address owns |
| `/offers`, `/auctions` | Every open offer; every running auction with its standing bid and the minimum next bid |
| `/params` | The prices in effect, any scheduled change, and what a client needs to build fee-bearing messages — including how deep this resolver's own replay goes |
| `/checkpoints/latest`, `/checkpoints/{height}` | A checkpoint document: the six components and their commitment |
| `/log`, `/log/decoded` | The complete public log through the latest checkpoint; decoded renders the data field as text |
| `/settlements` | Outstanding settlement obligations — what the marketplace and treasury owe |
| `/burn` | Burned so far, owed so far, computed from the log |

The proof in `/resolve` is the product. Anyone can check it against `/checkpoints/latest` with `@nns/core` alone. If a proof reaches you by another route — a cached reply, a QR code — verify it with the library's exported `verifyInclusion` / `verifyNonInclusion` rather than your own code; a second implementation of the check is the one place a divergence could enter.

## The wire format

Every NNS message is an ordinary Nimiq basic transaction whose data field is:

```
NNS1  <one type letter>  <payload>
```

- **At most 64 bytes**, the network's data limit. Sixty-five bytes is accepted by the RPC, returns a hash, and never lands in a block.
- **Hex over RPC**, both directions.
- **Routed by recipient.** Fee-bearing messages go to the treasury; signalling messages go to the protocol address with a value of 1 luna (the network rejects a value of zero); a target change and a transfer put the counterparty in the recipient, so the wallet's own sheet shows it; purchases go to the marketplace address.
- **Sender and recipient must differ.** Nimiq silently drops a self-transaction. That is why "point my name back at myself" is sent to the protocol address as a sentinel.
- **Failed transactions are still in blocks.** The indexer ignores anything whose `executionResult` is false.

The fourteen messages:

| Letter | Message | Payload | Sent by | To | Value |
|---|---|---|---|---|---|
| `G` | Register | `<name>` or `<name>\|<ref>` | anyone | treasury | ≥ the band price |
| `N` | Renew | `<name>` | anyone | treasury | ≥ the band price |
| `S` | Set target | `<name>` | owner | the new target | 1 luna |
| `E` | Set EVM address | `<name>\|<base64url 27 chars>` (empty clears) | owner | protocol | 1 luna |
| `X` | Transfer | `<name>` | owner | the new owner | 1 luna |
| `D` | Set subdomain host | `<name>\|<host>` (empty clears) | owner | protocol | 1 luna |
| `K` | Cancel | `<name>` | owner | protocol | 1 luna |
| `O` | Offer | `<name>\|<price in luna>` | owner | treasury | 1 luna |
| `B` | Buy, or bid | `<name>` | anyone | marketplace | the price exactly, or the bid |
| `A` | Auction | `<name>\|<starting price>\|<end height>` | owner, or admin for a reserved name | protocol | 1 luna |
| `M` | Settlement | `<height>\|<tx index>` | marketplace or treasury | the party paid | the amount owed |
| `P` | Governance | prices, commission, effective height | admin | protocol | 1 luna |
| `U` | Unreserve | `<name>` | admin | protocol (release) or the awardee (award) | 1 luna |
| `F` | Burn attestation | — | treasury | burn address | the amount burned |

Build payloads with `@nns/core` — `encodeRegister`, `encodeSetTarget`, `encodeSetEvm`, `encodeTransfer`, `encodeDelegate`, `encodeCancel`, `encodeRenew`, `encodeOffer`, `encodeBuy`, `encodeAuction` — which validate inputs and refuse anything the reducer would refuse. Every encoder checks the byte ceiling, because an over-length message fails silently.

**The `ref` field on a registration** is up to {{n:MAX_REF_LEN}} characters (`a–z 0–9 -`) naming the application that drove the registration, so an integrator share can be paid. It has no effect on validity, price or ownership: a malformed or unknown `ref` is ignored and the registration proceeds. Revenue sharing is an operator policy, not a protocol rule.

Same-block order is by transaction hash, ascending. A message that is refused still occupies its position.

## Names on EVM chains

The owner can bind one 20-byte EVM address to a name. It sits inside the Merkle leaf, and the tree is keccak256, so **an EVM contract can verify an NNS proof directly and bind a name to `msg.sender`** with no oracle. One record covers every EVM chain, because multicoin wallets derive the same address on all of them. Anything further — per-chain records, other chains — composes on the EVM side, authorised through this one record; the protocol deliberately holds nothing else.

The record is self-declared: NNS verifies that the owner said it, not that the owner controls the EVM key. Control is demonstrated on the EVM side by transacting. The record clears on transfer and on the fall to available, and survives grace.

## Messaging (not protocol)

The app's Inbox is a client convention, not part of NNS: a dust transaction to a name's **owner** whose data begins `NC1` and carries a short text. The one rule that keeps it harmless is that the prefix is **not** `NNS1`, so no indexer parses, logs or commits it. Messages go to the owner, not to the address the name pays, because the owner is who can act on the name. A message about a subdomain goes to the address the host answered with, since a subdomain has no owner of record. Details are in the repository under `docs/app-chat.md`.

## Running your own resolver

The library asks resolvers; nothing stops you being one. [Running your own](operators).
