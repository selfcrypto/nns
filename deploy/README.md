# deploy/

Five things can be run, one directory each. Every directory carries its own
compose file, its own `.env.example` and its own README, so an operator never
reads a variable belonging to a role they do not run.

**Start by picking a row.** Then read only that directory's README.

| I want to… | Run | Reachable from outside | Needs |
|---|---|---|---|
| Serve the registry, so clients can verify it against someone other than us | [`resolver/`](resolver/) | its API | a Nimiq **history** node covering `LAUNCH_HEIGHT` |
| Make `shop.myname` resolve, for names I own | [`delegate/`](delegate/) | its HTTP port | a JSON file and publicly trusted TLS |
| Host the mini app and its RPC proxy | [`service/`](service/) | app, API, relay | the node's credential, for the relay |
| Pay what the protocol owes — payouts and refunds | [`settlement/`](settlement/) | **nothing** | the two §6 `M` hot keys, and a node it reaches privately |
| Anchor checkpoint roots to an EVM chain (§9) | [`anchor/`](anchor/) | **nothing** | a funded EVM key, and the bundled kubo — §8.2 needs two independent CID implementations |

They are separate compose projects with separate names and do not interfere;
run one, two, or all five. An exchange that wants `shop.exchange` to work needs
only the second row — no node, no database, no indexer.

[`../docs/runbooks/operators.md`](../docs/runbooks/operators.md) is the longer
version: what each role *is*, and the things that are easy to get wrong.

## The first two rows on one box

[`collaborator/`](collaborator/) is everything a third party can run, in one
compose project: Postgres, the indexer and the API, with a delegate beside
them. Same images, same variables, same two ports — one `.env` and one
`docker compose up` instead of two. It holds no key and needs the same history
node the `resolver` row does.

It is a convenience, not a sixth role, and it merges nothing: the resolver
proves its answers against the committed root and the delegate proves nothing,
which is the distinction clients render differently and a shared box does not
soften. Run the two directories separately when you want them to **fail**
separately — and never both ways on one host, where 8635 and 8636 are wanted
twice.

## An optional extra: the NC chat index

[`chat/`](chat/) indexes the NC chat messages of `docs/app-chat.md` and serves
them by address, so the app's Inbox is one small request per address rather
than a 500-transaction history pull. It is **not a role** in the sense above —
it serves no protocol data, holds no key, and an operator running only it is
not serving NNS — which is why it sits below the table rather than in it.

Three things an operator should know before running it:

- **It is optional in the strict sense.** The app falls back to reading the
  chain through the relay when `VITE_NNS_CHAT` is unset. Nothing about the
  registry, the log or any root depends on it, and it cannot affect them —
  it shares no code and no database with the protocol's services.
- **It costs a second pass over the same batches** the `resolver` role's
  indexer already walks. That duplication is deliberate: chat code inside the
  loop that produces roots is the coupling the convention exists to avoid.
- **You become the host of a queryable message corpus.** The messages are
  public on chain either way, but an index turns "each user pulls their own
  history" into "anyone can ask this service what an address said". Its
  database is disposable — every row is rebuildable from the chain — so
  retention is genuinely your call.

## One box, one command

[`vps/`](vps/) is the owner's tool, not a role: it composes every stack one
box runs — including the keyed roles the table above deliberately keeps off
the public machine — validates each role's `.env` against its own compose
file, and moves the non-regenerable state between boxes (`bundle`/`restore`).
If you are an operator, it is not for you; pick a row above. The
key-separation rule below still stands, and running everything on one box is
the explicit trade that kit's README owns up to.

## The root `docker-compose.yml` is not a deployment

The compose file at the repository root is the **development** stack — the
indexer and its database, and nothing that faces a network. If you are
deploying, you are in the right directory now; use one of the rows above.

## What every role shares

**One image recipe.** All services build from `docker/Dockerfile`, parameterised
by a `PKG` build arg (`indexer | api | relay | delegate | settlement`). The
build context is the **repository root**, so clone the whole repo — not just
`deploy/`. Everything compiles inside the image: the host needs Docker and
nothing else, no Node, no pnpm.

**Everything publishes on loopback.** Defaults are `127.0.0.1`, because these
services speak plain HTTP and expect a TLS terminator in front:

| Role | Port | What |
|---|---|---|
| `resolver` | 8635 | the API |
| `collaborator` | 8635 / 8636 | the API and the delegate, on one box |
| `service` | 8635 | the API, standalone |
| `service` | 8080 | the app, with `/api/` and `/rpc` behind it |
| `delegate` | 8636 | the delegate |
| `settlement` | 5434 | its Postgres, for `psql` and backups only |

Widen one only if you know what fronts it. `service`'s 8080 in particular must
not be widened: the relay trusts `X-Forwarded-For` there, so a client that can
reach it directly chooses its own rate-limit bucket.

**No role bundles a TLS terminator.** Deliberately — bundling one means owning
failure modes we do not control, in roles whose appeal is that they are small.
Recipes for Caddy, nginx + certbot, a tunnel, and panels like Plesk are in
[`delegate/README.md`](delegate/README.md) and apply to the others unchanged,
with only the port differing. For the one case where nothing fronts the box at
all, [`edge/`](edge/) is a self-contained nginx that issues its own
certificates — optional, separate, and skipped entirely when you already have
a terminator.

**Add no CORS headers, and strip none.** The API sends
`access-control-allow-origin: *` itself and exposes the two §8.2 verification
headers. An endpoint a browser cannot read answers `curl` perfectly while being
invisible to every client that tries to use it.

**Nothing is baked into an image.** The same image runs against any node and any
deployment. Since the launch freeze every §3 value — `LAUNCH_HEIGHT`, the four
role addresses, `RESERVED_NAMES`, the listing fee — is a constant in
`@nns/core` with no environment variable at all, because a value an operator can
set is a value two operators can disagree about.

## The node, for the roles that need one

`resolver`, `collaborator` and `service` all run the indexer, so all three need
a Nimiq **history** node whose retention covers `LAUNCH_HEIGHT`. `settlement`
needs a node too, but any node it can reach privately — it signs rather than
replays. A `delegate` needs none.

This is the one prerequisite that cannot be corrected afterwards, and its
failure is the quietest in the system: a node brought up by state sync, or one
that has pruned, answers a batch below its horizon with `[]` — exactly what it
answers for a genuinely empty batch. An indexer pointed at one would scan the
whole backfill, match nothing, and **report success with an empty registry**,
reproducibly, so a second indexer would agree with it.

The indexer refuses to start rather than do that, naming the earliest block the
node actually holds. **That refusal is the good outcome.** Get a node with the
history; [`resolver/README.md`](resolver/README.md) explains why raising the
start height is the wrong response to it.

## Keys, and where they may not be

The two that hold a spending key are the two with no public surface:

| Role | Key |
|---|---|
| `resolver` | none — spends nothing, signs nothing |
| `delegate` | none — holds no chain data at all |
| `collaborator` | none — it is those two rows on one box |
| `service` | the node's RPC credential, for the relay. No chain key |
| `settlement` | **both §6 `M` hot keys** |
| `anchor` | **a funded EVM publisher key** (SHOULD be a multisig signer, §9) |

**`settlement` must not share a machine with `service`.** A box that terminates
TLS is the wrong home for a hot key, and the issuer needs the node's *wallet*
methods, which the relay deliberately does not allowlist. It needs no inbound
reachability: it polls an API outbound and broadcasts `M` transactions that
every indexer then picks up. The chain is the only channel between the two
halves — no shared database, no open port.

`anchor` is in the same position as `settlement`: a funded key, no inbound
reachability, and it must not share a machine with `service`. The admin CLI
(cold key) has no directory here at all, for the same reason.

## Secrets

**Every value a role needs, including its keys, goes in that role's `.env`.**
`cp .env.example .env`, fill it in, `chmod 600`, and `docker compose up -d`.
There is no shell ritual, and there deliberately isn't one:

- A deployment that needs an export before every `up` fails to start after a
  reboot, a rebuild, or a colleague.
- **Compose gives the shell environment precedence over `.env`.** Sourcing a
  secret store that happens to define the same variable names silently
  overrides the deployment, and nothing warns. This has already cost one live
  debugging session.

`.env` is gitignored everywhere. Two things worth knowing rather than
discovering: Docker records a container's environment in its on-disk config, so
`docker inspect` exposes these regardless of where they came from — a file
changes ergonomics, not runtime exposure. And for keys you cannot roll, a
systemd unit with `LoadCredential` beats compose.

Keys are still declared `${VAR:?}` in the compose files, so a *missing* one
stops `up` with a message naming it rather than starting a service that runs
happily and does nothing.

## Backups

**There is exactly one thing here worth backing up: the settlement ledger.**

Everything else is derived. The indexer's Postgres rebuilds from
`LAUNCH_HEIGHT`; the app bundle rebuilds from the repo; a delegate is one JSON
file and a `docker compose up`. `docker compose down -v` is a supported, if
slow, repair for a resolver.

The ledger records payments that have already left a hot key and cannot be
rebuilt from anywhere. `down -v` on `settlement/` is never routine.

## Two cases where a rebuild is required, not optional

- **A revision changed the rules or the §3 constants.** Roots derived under the
  old rules are not comparable with roots derived under the new ones, and
  `configFingerprint` covers configuration, not rules — so **nothing refuses the
  resume for you**. Release notes say when this applies.
- **The node was resynced.** If its retention no longer covers `LAUNCH_HEIGHT`,
  the indexer refuses to start. Fix the node, not the height.

The procedure, in your role's directory — build first, so a broken image
surfaces before anything stops:

```
docker compose build
docker compose stop
docker compose start postgres
docker compose exec -T postgres psql -U nns -d template1 -c 'DROP DATABASE nns'
docker compose exec -T postgres psql -U nns -d template1 -c 'CREATE DATABASE nns'
docker compose up -d      # the indexer migrates and replays from LAUNCH_HEIGHT
```

(`template1`, because a session inside the doomed database blocks the drop.)
On the one-box kit this is one command: `nns-vps rebuild <role>`. It refuses
the settlement ledger by name — that database is not derived state and is
never dropped.

## Verify from outside

Whatever you run, check it from a host that is not the one serving it. A
certificate only your browser trusts, and a port only your LAN can reach, both
look perfect from the machine that serves them.

[`monitor/`](monitor/) is that check made continuous: an optional Uptime Kuma
that probes the public URLs every minute and — the part no HTTP probe can do —
holds a dead-man switch for the anchor publisher, whose failures otherwise
look exactly like an idle container. Like everything optional here, NNS
neither knows nor cares whether it runs.
