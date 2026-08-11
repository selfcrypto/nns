<div align="center">

<img src="/assets/nns-lockup-2048.png" alt="NNS — Nimiq Name Service" width="460">

### Human-readable names on Nimiq. No smart contracts.

[![Spec](https://img.shields.io/badge/spec-v1%20draft%20r14-0582CA?style=flat-square)](docs/nns-spec-v1.md)
[![Status](https://img.shields.io/badge/status-in%20development-EC991C?style=flat-square)](docs/status.md)
[![License](https://img.shields.io/badge/license-MIT-1F2348?style=flat-square)](LICENSE)
[![Nimiq](https://img.shields.io/badge/chain-Nimiq%20Albatross-0582CA?style=flat-square)](https://nimiq.com)

**`kike`** &nbsp;→&nbsp; `NQ64 VFXQ TPAS 5Q7S ADEX 072S CR2M QCQ4 8P8M`

</div>

---

## What this is

A name registry for Nimiq built without a virtual machine, without contracts,
and without changing consensus. Registrations travel inside ordinary
transaction data. A deterministic indexer replays them into a
`name → address` mapping. A Nimiq Pay mini app is the client.

The chain is used as what it already is — an ordered, finalised message bus.
Everything else is interpretation, and the interpretation rules are published
so anyone can run them.

## Why it might interest you

| | |
|---|---|
| **No contracts required** | Works on Nimiq as it exists today. Nothing to deploy, nothing to upgrade |
| **Independently verifiable** | Anyone with a Nimiq node can replay the same history and derive the same state. Not "trust our API" |
| **Anchored** | Checkpoint roots are published hourly to an EVM L2 and monthly to Ethereum, so past claims cannot be quietly rewritten |
| **Delegated subdomains** | An exchange registers one name and issues `user.exchange` addresses for free, with zero on-chain state |
| **Cheap** | Two pricing bands, floored and governed within published bounds |

## How it works

```
   Nimiq chain                Indexer                  Clients
┌────────────────┐      ┌────────────────┐      ┌──────────────────┐
│ NNS1Gkike      │      │  replay rules  │      │ resolve("kike")  │
│ NNS1Sfoo       │ ───▶ │  §4 validity   │ ───▶ │ + Merkle proof   │
│ NNS1Xbar       │      │  §7 reducer    │      │ + quorum check   │
│ (64-byte data) │      │  §8 Merkle     │      │ + anchor check   │
└────────────────┘      └───────┬────────┘      └──────────────────┘
                                │
                                ▼
                     root → Ethereum L2 (hourly)
                     log  → IPFS (content-addressed)
```

Three clocks, and only the first decides whether a name works:

| Clock | Interval | Gates |
|---|---|---|
| Finality | ~minutes | **The name is registered and resolves** |
| Checkpoint | ~12 min | A Merkle proof exists for it |
| Anchor | ~1 h | The root is notarised on Ethereum |

## Verification, in three tiers

1. **Anyone, no node, seconds** — fetch the log by its CID, replay it, compare
   the root to the anchor.
2. **Any Nimiq node** — verify proofs against a checkpoint root.
3. **Any history node** — recompute the entire state from the chain itself.
   This is the tier that catches a dishonest operator, and the one the project
   actively wants other people running.

The spec is deliberately blunt about what this does *not* guarantee — see
[§2.1](docs/nns-spec-v1.md) and [§2.2](docs/nns-spec-v1.md). Proofs and
anchoring stop equivocation and retroactive rewriting; they do not stop a sole
operator who is also the sole publisher. What defeats that is independent
replay, client quorum, and multi-publisher anchoring.

## Message types

Everything is a `NNS1` prefix, one type character, and a payload — inside
Nimiq's 64-byte transaction data limit.

| | | | |
|---|---|---|---|
| `G` register | `S` set target | `X` transfer | `R` recovery |
| `D` delegate | `K` cancel | `N` renew | `O` offer |
| `B` buy | `A` auction | `M` settlement | `P` governance |
| `U` unreserve | `F` burn attestation | | |

## Repository

| Path | |
|---|---|
| `docs/nns-spec-v1.md` | **The protocol specification.** Authoritative |
| `docs/rpc-reference.md` | What Nimiq's RPC actually does, measured not assumed |
| `packages/core` | Rules: encoding, validation, reducer, Merkle. Pure |
| `packages/indexer` | RPC tail → reducer → Postgres → checkpoints |
| `packages/api` | Read-only resolver, proofs |
| `packages/app` | Nimiq Pay mini app |
| `packages/resolver` | npm package other apps embed |
| `packages/settlement` · `anchor` · `admin` | Payouts, anchoring, governance |

## Status

**In development.** The wire format is settled and empirically verified
against mainnet; implementation is underway. See
[`docs/status.md`](docs/status.md) for what is built and what is next, and
[§12](docs/nns-spec-v1.md) for what remains undecided.

Names are `[a-z0-9-]`, 5–24 characters, with a positional digit rule that
removes the `n1m1q` / `nimiq` class of impersonation entirely.

## Run your own indexer

The point of the project. One container, one RPC URL pointed at a Nimiq node
you already run — no new storage, no resync. An independent replay is worth
more to this protocol than any assurance its authors can offer about
themselves.

Instructions land with the indexer package.

## Contributing

The specification is the place to start. If something in it is wrong,
ambiguous, or will age badly, that is the most valuable issue you can open —
more valuable than a patch, because a wire format is expensive to change and
cheap to argue about beforehand.

## License

MIT. Including the specification: an interpretation layer that anyone may
reimplement is the only kind worth trusting.

---

<div align="center">
<sub>Built on <a href="https://nimiq.com">Nimiq</a>. Not an official Nimiq project.</sub>
</div>
