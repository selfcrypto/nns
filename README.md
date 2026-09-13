<div align="center">

<img src="/assets/nns-lockup-2048.png" alt="NNS — Nimiq Name Service" width="460">

### Human-readable names on Nimiq. No smart contracts.

[![Spec](https://img.shields.io/badge/spec-v1%20draft%20r29-0582CA?style=flat-square)](docs/nns-spec-v1.md)
[![Status](https://img.shields.io/badge/status-all%20packages%20built-EC991C?style=flat-square)](#status)
[![Tests](https://img.shields.io/badge/tests-2265-1F2348?style=flat-square)](#building-and-testing)
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
| **Anchored** | Checkpoint roots are published to an EVM chain on every change, with a daily floor, so past claims cannot be quietly rewritten |
| **Delegated subdomains** | An exchange registers one name and issues `user.exchange` addresses for free, with zero on-chain state |
| **Cheap** | Two pricing bands, floored and governed within published bounds |

## How it works

```
   Nimiq chain                Indexer                  Clients
┌────────────────┐      ┌────────────────┐      ┌──────────────────┐
│ NNS1Gkike      │      │  replay rules  │      │ resolve("kike")  │
│ NNS1Sfoo       │ ──>  │  §4 validity   │ ──>  │ + Merkle proof   │
│ NNS1Xbar       │      │  §7 reducer    │      │ + quorum check   │
│ (64-byte data) │      │  §8 Merkle     │      │ + anchor check   │
└────────────────┘      └───────┬────────┘      └──────────────────┘
                                │
                                ▼
                     root → EVM chain (on change)
                     log  → IPFS (content-addressed)
```

Three clocks, and only the first decides whether a name works:

| Clock | Interval | Gates |
|---|---|---|
| Finality | ~minutes | **The name is registered and resolves** |
| Checkpoint | ~12 min | A Merkle proof exists for it |
| Anchor | on change, daily floor | The root is notarised on an EVM chain |

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
| `G` register | `S` set target | `E` link EVM address | `X` transfer |
| `D` delegate | `K` cancel | `N` renew | `O` offer |
| `B` buy | `A` auction | `M` settlement | `P` governance |
| `U` unreserve | `F` burn attestation | | |

Fourteen types. There is no recovery message: `R` was removed in r20,
because every version of it the owner key could cancel was
theatre, and every version it could not outranked the owner. A lost owner key
is a lost name, as in ENS.

## Repository

| Path | |
|---|---|
| `docs/nns-spec-v1.md` | **The protocol specification.** Authoritative |
| `docs/integration.md` | **The integration guide** — the HTTP API from any language, the `@nns/resolver` library, verifying proofs yourself, subdomains for exchanges, writing to the registry, running a resolver, names on EVM chains |
| `docs/rpc-reference.md` | What Nimiq's RPC actually does, measured not assumed |
| `docs/runbooks/` | `operators.md` (the role map), `release.md` (publishing the three npm packages) |
| **`packages/`** | **Twelve packages — [`packages/README.md`](packages/README.md) explains each one and how they stack** |
| **`deploy/`** | **One directory per operator role — [`deploy/README.md`](deploy/README.md) picks the right one and covers what they share** |

A pnpm workspace: TypeScript strict throughout, one Vitest run across every
package, dependency versions pinned once in the workspace catalog. Amounts are
`bigint` luna; heights are `number`.

## Status

**Pre-launch.** All twelve packages are built and conform to spec r29. The wire
format is settled and empirically verified against mainnet. 2,268 tests pass
with a database attached, none skipped.

What remains before a mainnet launch is deployment and one irreversible input,
not code: completing `RESERVED_NAMES`, a full mainnet battery, and a second
freeze that pins `LAUNCH_HEIGHT` to a future height and regenerates the four §3
role addresses. [§12](docs/nns-spec-v1.md) is what remains undecided in the
protocol itself.

`core` is the reference implementation, and writing it is how the spec got past
r15: it surfaced **ten places where two conforming implementations would have
derived different roots** — same-height effect order, the log's `<data>` field,
the checkpoint layout byte for byte, seven more. All ten are pinned in the spec
and held by a vector, and nineteen further check-order choices stay deliberately
unratified, pinned only by `packages/core/vectors/reduce.json` — which records
the reading taken for each, so a second implementation can match it byte for
byte. That this list exists at all is the best evidence available that the
design is being taken seriously.

Spec revisions are numbered, and the spec says which ones moved bytes — those
required every database derived under the old rules to be rebuilt, because
`configFingerprint` covers configuration and not rules, so nothing refuses the
resume for you.

Names are `[a-z0-9-]`, 5–24 characters, with a positional digit rule that
removes the `n1m1q` / `nimiq` class of impersonation entirely.

## Run your own indexer

The point of the project. One container, one RPC URL pointed at a Nimiq node
you already run — no new storage, no resync. An independent replay is worth
more to this protocol than any assurance its authors can offer about
themselves.

```bash
cp .env.example .env      # fill in NNS_RPC_URL
docker compose up
```

Postgres comes with it, published on `127.0.0.1:5433` so it does not clash
with a local server. Nothing else needs setting: since the launch freeze every
§3 value — `LAUNCH_HEIGHT`, the four role addresses, `RESERVED_NAMES`, the `O`
listing fee — is a constant in `@nns/core`, not configuration, because a value
an operator can set is a value two indexers can disagree about.

To run it outside a container instead, `packages/indexer/.env.example` is the
same set of variables pointed at a local database.

## Running one publicly

An indexer answers nobody on its own. `deploy/` has one directory per operator
role — compose file, `.env.example`, README — so nobody reads configuration
belonging to a role they do not run:

- **A resolver** (`deploy/resolver`) — Postgres, the indexer and the read-only
  API, with only the API published. This is what §8.5's quorum is made of:
  clients ask several independent ones and compare, so the protocol stops
  depending on us exactly to the degree that other people run these.
- **A delegate** (`deploy/delegate`) — one container and a JSON file, for a
  name owner who wants `shop.theirname` to resolve. No node, no database, no
  key.
- **Both, on one box** (`deploy/collaborator`) — the two above in one compose
  project, one `.env` and one `up`. Everything a third party can run; it merges
  nothing, and the resolver's proofs and the delegate's unproven answers stay
  as different as they were.
- **An anchor publisher** (`deploy/anchor`) — notarises checkpoint roots on the
  EVM contract. The contract is permissionless on purpose: a second,
  independent party anchoring is what turns timestamping into §8.5's anchor
  quorum, and recruiting one is a launch deliverable.

[`docs/runbooks/operators.md`](docs/runbooks/operators.md) is the map: what each
role is, what it needs, and the things that are easy to get wrong — starting
with the fact that a delegate is not a resolver, and that "resolver" names both
a server (`packages/api`) and the client library that queries several of them
(`packages/resolver`).

## Running the app

The mini app needs nothing but this repository — no node, no database, no
configuration. `@nns/resolver` ships the endpoints it asks, so a dev server is
pointed at the live registry from the first render:

```bash
pnpm install
pnpm --filter @nns/app dev
```

## Building and testing

```bash
pnpm install
pnpm test         # one Vitest run over every package — 2,268 tests
pnpm typecheck    # strict, and wider than the build: tests and tooling too
pnpm build
```

**All three, before calling anything done.** The build config is narrow (`src/`
only) and typecheck is wide, so a build can be broken while typecheck is green
— a broken `core` build survived several commits exactly that way.

45 of those tests are gated on a database — the SQL seam, the migrations, the
§8.1/§8.2 persistence rules, the settlement ledger's idempotency — and skip
unless `NNS_TEST_DATABASE_URL` points at a Postgres. Give them one:

```bash
docker compose up -d postgres
NNS_TEST_DATABASE_URL=postgres://nns:nns@127.0.0.1:5433/some_throwaway pnpm test
```

Each suite drops its own schema on arrival, so point it at a throwaway database
— never one holding a replay you would rather not rebuild.

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
