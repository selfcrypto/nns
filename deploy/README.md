# deploy/

Three things can be run, one directory each. Every directory carries its own
compose file, its own `.env.example` and its own README, so an operator never
reads a variable belonging to a role they do not run.

**Start by picking a row.** Then read only that directory's README.

| I want to… | Run | Reachable from outside | Needs |
|---|---|---|---|
| Serve the registry, so clients can verify it against someone other than us | [`resolver/`](resolver/) | its API | a Nimiq **history** node covering `LAUNCH_HEIGHT` |
| Make `shop.myname` resolve, for names I own | [`delegate/`](delegate/) | its HTTP port | a JSON file and publicly trusted TLS |
| Anchor checkpoint roots to an EVM chain (§9) | [`anchor/`](anchor/) | **nothing** | a funded EVM key, and the bundled kubo — §8.2 needs two independent CID implementations |

They are separate compose projects with separate names and do not interfere;
run one, two, or all three. An exchange that wants `shop.exchange` to work needs
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

## The root `docker-compose.yml` is not a deployment

The compose file at the repository root is the **development** stack — the
indexer and its database, and nothing that faces a network. If you are
deploying, you are in the right directory now; use one of the rows above.

## What every role shares

**One image recipe.** All services build from `docker/Dockerfile`, parameterised
by a `PKG` build arg
(`indexer | api | relay | delegate | settlement | anchor | chat-index`). The
build context is the **repository root**, so clone the whole repo — not just
`deploy/`. Everything compiles inside the image: the host needs Docker and
nothing else, no Node, no pnpm.

**Everything publishes on loopback.** Defaults are `127.0.0.1`, because these
services speak plain HTTP and expect a TLS terminator in front:

| Role | Port | What |
|---|---|---|
| `resolver` | 8635 | the API |
| `collaborator` | 8635 / 8636 | the API and the delegate, on one box |
| `delegate` | 8636 | the delegate |

Widen one only if you know what fronts it.

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
`@nimiqnames/core` with no environment variable at all, because a value an operator can
set is a value two operators can disagree about.

## The node, for the roles that need one

`resolver` and `collaborator` both run the indexer, so both need a Nimiq
**history** node whose retention covers `LAUNCH_HEIGHT`. A `delegate` needs
none, and neither does an `anchor` publisher — it reads a resolver's API.

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

`NNS_START_MODE` is the one thing that moves this requirement. A `snapshot`
bootstrap seeds an empty database from another operator's §8.2 log — verified
against the §8.1 commitment that operator publishes, and replayed locally
rather than copied — and then scans from there, so the node only has to hold
history from the bootstrap height on. It buys minutes instead of hours and
costs §8.4 Tier 3 depth over the bootstrapped range: a message that was on
chain and is missing from that log commits perfectly, and every operator who
bootstraps from the same peer inherits the same blind spot. The resolver says
so on `/params` rather than claiming otherwise. `hybrid` re-derives the range
from the chain in the background and needs the full history like `scratch`,
which it checks at startup.

## Keys, and where they may not be

The two that hold a spending key are the two with no public surface:

| Role | Key |
|---|---|
| `resolver` | none — spends nothing, signs nothing |
| `delegate` | none — holds no chain data at all |
| `collaborator` | none — it is those two rows on one box |
| `anchor` | **a funded EVM publisher key** (SHOULD be a multisig signer, §9) |

**`anchor` must not share a machine with anything that terminates TLS.** A box
with a public surface is the wrong home for a funded key, and the publisher
needs no inbound reachability of its own: it reads a resolver's API outbound,
pins outbound and sends outbound. The admin CLI (cold key) has no directory
here at all, for the same reason.

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

**Nothing here is worth backing up.** Every byte these roles hold is derived:
the indexer's Postgres rebuilds from `LAUNCH_HEIGHT`, a delegate is one JSON
file and a `docker compose up`, the chat index is rebuildable from the chain.
`docker compose down -v` is a supported, if slow, repair for any of them.

The exception is the one thing you supply rather than derive — each role's
`.env`. Keep that wherever you keep secrets; nothing else needs a schedule.

## Two cases where a rebuild is required, not optional

- **A revision changed the rules or the §3 constants.** Roots derived under the
  old rules are not comparable with roots derived under the new ones, and
  `configFingerprint` covers configuration, not rules — so **nothing refuses the
  resume for you**. Release notes say when this applies.
- **The node was resynced.** If its retention no longer covers `LAUNCH_HEIGHT`,
  the indexer refuses to start. Fix the node, not the height.

**For the first case, take the log path when the revision allows it.** A
revision whose note in `docs/history/revisions.md` says **log-preserving** —
one that leaves which messages are logged, the canonical order (§5.2) and the
attributed sender (§7.2) alone, and moves only verdicts and the state behind
them — can be applied by replaying the log this database already holds, which
is the same input in a shorter form. Seconds rather than a resync, in one
transaction, and the registry answers throughout:

```
docker compose build
docker compose stop indexer
docker compose run --rm --no-deps indexer node dist/rebuild-main.js --log-preserving 30
docker compose up -d
```

The revision is typed out because it is a declaration, and the indexer refuses
it if it is not the one the image implements — or if the replay does not
reproduce the stored log line for line. Nothing is dropped. A background
re-derivation from the chain confirms the range afterwards when
`NNS_START_MODE=hybrid`, and `/params.verification.rebuilt` says until then
that it has not.

**Otherwise, from the chain.** In your role's directory — build first, so a
broken image surfaces before anything stops:

```
docker compose build
docker compose stop
docker compose start postgres
docker compose exec -T postgres psql -U nns -d template1 -c 'DROP DATABASE nns'
docker compose exec -T postgres psql -U nns -d template1 -c 'CREATE DATABASE nns'
docker compose up -d      # the indexer migrates and replays from LAUNCH_HEIGHT
```

(`template1`, because a session inside the doomed database blocks the drop.)

## Verify from outside

Whatever you run, check it from a host that is not the one serving it. A
certificate only your browser trusts, and a port only your LAN can reach, both
look perfect from the machine that serves them.

Worth making continuous: an uptime probe against the public URL every minute,
and — the part no HTTP probe can do — a dead-man switch for an `anchor`
publisher, whose failures otherwise look exactly like an idle container.
