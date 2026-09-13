# Running a resolver and a delegate on one box

Everything a third party can run, in one compose project: Postgres, the
indexer, the read-only API — and, beside them, a delegate answering
`shop.yourname` for names you own. One `.env`, one `docker compose up`, four
containers, two published ports.

That is the whole of what this directory adds. It is `deploy/resolver` and
`deploy/delegate` side by side, unchanged: same images, same variables, same
defaults, same ports. There is nothing new here to learn.

## What it is not

**It does not merge the two.** They remain what they were, and the difference
is the important one in NNS:

- the **resolver** replays the chain into `name → address` and answers with a
  §8.3 Merkle proof anyone can check against the committed root;
- the **delegate** asserts subdomains of your own names, from a JSON file you
  wrote, and proves **nothing** — §8.6's answer carries no proof, and clients
  render it differently for exactly that reason.

Sharing a box does not make the second answer as good as the first. The
delegate shares a machine, a build and an `.env` with the resolver, and nothing
else: no database, no port, no code path, no chain access. `docs/runbooks/operators.md`
lays the roles side by side, and "a delegate is not a resolver" is the first
of the things it lists as easy to get wrong.

**It is also not the service.** The RPC relay and the mini app bundle
(the role that hosts the app) are not here: the relay holds the node's credential and
exists to host the app, not to resolve names. And nothing that holds a key is
here either — settlement and anchor are separate machines, deliberately.

## When to run this instead of the two directories

Run this when one box does both jobs and you want one place to configure and
one command to run it.

Run `../resolver` and `../delegate` separately when you want them to **fail
separately**: different boxes, different people, different restart schedules,
or a delegate that must stay up untouched while you rebuild a resolver
database. That separation is why the per-role directories exist, and it costs
you a second `.env`, nothing more.

Either way, **do not run this alongside them on the same host.** They are
separate compose projects with separate names and separate volumes, so they do
not clash — except on ports 8635 and 8636, which they both want.

## Before anything: the node

The resolver half needs a **Nimiq history node whose retention covers
`LAUNCH_HEIGHT`** (58,842,720). This is the one prerequisite that cannot be
fixed afterwards: a pruned or state-synced node answers a batch below its
horizon with `[]` — exactly what an empty batch looks like — so an indexer
pointed at one would scan the whole backfill, match nothing, and report success
with an empty registry, reproducibly.

The indexer refuses to start rather than do that, naming the earliest block the
node actually holds. **That refusal is the good outcome.**
[`../resolver/README.md`](../resolver/README.md) has the long version,
including why raising the start height is the wrong response to it. Read it
before deploying, not after.

The delegate half needs no node, and keeps answering whatever the node does.

## Quickstart

```bash
cd deploy/collaborator
cp .env.example .env
$EDITOR .env                       # NNS_RPC_URL, and the node's credentials

mkdir -p labels
cp ../../packages/delegate/labels.example.json labels/labels.json
$EDITOR labels/labels.json         # your names, your labels, your addresses

docker compose up -d --build
docker compose logs -f indexer
curl -s http://127.0.0.1:8636/healthz
```

The first run backfills from `LAUNCH_HEIGHT` to the chain head, then tails. The
API answers `503 NOT_SYNCED` on every state route until the indexer has written
state, which is correct rather than broken; proofs appear at the first
checkpoint boundary after that. The delegate is serving before either finishes
— it reads a file.

The labels file, its format and the reload behaviour are
[`../delegate/README.md`](../delegate/README.md); it is the same file, mounted
the same way, for the same reasons.

## Two hostnames, one terminator

Both ports serve plain HTTP on loopback and expect a TLS terminator in front,
and both must be reachable over **publicly trusted HTTPS**: clients are
browsers, and for a delegate §8.6 fixes the scheme outright — a `D` host is
bare, clients hardcode `https://` on 443, and there is no downgrade path.

Give them **separate hostnames**. With Caddy, that is the whole configuration:

```caddyfile
resolver.example.com {
    reverse_proxy 127.0.0.1:8635
}

nns.example.com {
    reverse_proxy 127.0.0.1:8636
}
```

The nginx + certbot, tunnel and panel recipes in
[`../delegate/README.md`](../delegate/README.md) apply unchanged, with only the
port differing. If nothing fronts this box at all, [`../edge/`](../edge/) is a
self-contained nginx that issues its own certificates — delete its app server
block, which is the one thing here nobody runs.

Two hostnames rather than one path-mounted host, because the trust positions
differ and a reader of your URLs should be able to tell them apart. A path
mount does work — the delegate reads the parent and label as the last two
segments and ignores the mount, so `D = example.com/delegated` is served by
this same container — but then your proof-carrying answers and your unproven
ones arrive from the same origin, which is the confusion the two halves of this
README exist to prevent.

**Add no CORS headers and strip none.** The API sends
`access-control-allow-origin: *` itself and exposes the two §8.2 verification
headers. An endpoint a browser cannot read answers `curl` perfectly while being
invisible to every client that tries to use it.

Verify from **outside** the host — a certificate only your browser trusts, and
a port only your LAN can reach, both look perfect from the machine that serves
them:

```bash
curl -s https://resolver.example.com/params
curl -s https://resolver.example.com/checkpoints/latest
curl -s https://nns.example.com/alice/shop
```

## Then: the `D`, and the quorum

They are two separate publications, and neither happens automatically.

- **The delegate** answers nothing for a name until that name's owner sends
  `NNS1D<name>|<host>` naming this host — *after* the URL above answers, since
  a `D` naming a host that is not yet serving over HTTPS turns subdomains off
  for that name until it is. Steps and the 52-character cap:
  [`../delegate/README.md`](../delegate/README.md).
- **The resolver** is used only once clients know about it: `DEFAULT_RESOLVERS`
  in `@nns/resolver` and the app's `VITE_NNS_RESOLVERS`. An entry is a URL and
  a name, and the name names the operator, because it is what a client shows a
  user when resolvers disagree. [`../resolver/README.md`](../resolver/README.md).

## Operating it

```bash
docker compose ps
docker compose logs -f indexer
docker compose logs -f delegate
docker compose exec delegate kill -HUP 1     # force a labels reload
docker compose up -d --build                 # after a git pull
```

**One thing here is worth backing up, and it is `labels/labels.json`.** Every
byte in Postgres is derived from the chain and rebuilds from `LAUNCH_HEIGHT` —
`docker compose down -v` then `up` is a supported, if slow, repair — while the
labels file exists nowhere else and is the delegate's entire product. A copy of
that file is the backup strategy.

Two cases where a rebuild of the resolver half is required, not optional:

- **A revision changed the rules or the §3 constants.** Roots derived under the
  old rules are not comparable with roots derived under the new ones, and
  `configFingerprint` covers configuration, not rules — so nothing refuses the
  resume for you. Release notes say when this applies.
- **The node was resynced.** If its retention no longer covers `LAUNCH_HEIGHT`,
  the indexer refuses to start. Fix the node, not the height.

Neither touches the delegate. `down -v` does not touch it either: its file is a
bind mount on the host.
