# Running a resolver

A resolver replays the chain into `name → address` and serves the result over
HTTP with §8.3 Merkle proofs. It is the role that matters most to the protocol:
**§8.5 asks a client to ask several independent resolvers and compare**, and a
quorum of one is a single point of trust with extra steps.

Three containers, one unit: Postgres, the indexer, and the read-only API. Only
the API is published. No keys, no wallet, no chain writes — a resolver spends
nothing and signs nothing.

It does **not** need the relay (that belongs to whoever hosts the mini app), it
does not host a frontend, and it has nothing to do with a delegate. See
`docs/runbooks/operators.md`.

## Before anything: the node

You need a **Nimiq history node whose retention covers `LAUNCH_HEIGHT`**
(58,842,720). This is the one prerequisite that cannot be fixed after the fact,
and the failure it causes is the quietest in the system.

A node brought up by state sync, or one that has pruned, holds no blocks below
its sync point. Asked for a batch below that, it answers **`[]`** — exactly
what it answers for a batch that genuinely held no transactions. There is no
error. So an indexer pointed at such a node would scan the entire backfill,
match nothing, log nothing, and **report success with an empty registry** —
reproducibly, so a second indexer on the same node would derive identical,
identically wrong checkpoints and agree with it.

The indexer refuses to start rather than do that. It probes the node at
startup, and if the history is short it aborts with the earliest block the node
actually holds:

```
the node has no block at LAUNCH_HEIGHT 58,842,720 — its history starts at 59,001,234.
  A batch below that answers with an empty transaction list, not an error, so the scan would run
  the whole backfill, find nothing, and report success with an empty registry — reproducibly, so a
  second indexer would agree with it.
  Re-index the node with history, or start at or above 59,001,234.
```

**That refusal is the good outcome.** It is the guard doing its job, and it is
the only signal that separates a short node from an empty chain.

**And only the first of its two suggestions applies to you.** "Start at or
above" is for a throwaway test bench. `LAUNCH_HEIGHT` is a constant in
`@nns/core`, not configuration — there is no environment variable for it,
deliberately, because a value an operator can set is a value two resolvers can
disagree about. Raising it means editing `packages/core/src/constants.ts` and
rebuilding, and what you would get is a resolver that has never seen the names
registered before that height: it answers with confidence, its own checkpoints
are internally consistent, its logs are clean, and it **disagrees with every
other resolver in the network** about who owns what. A client comparing it
against others reports a mismatch to the user, or halts. There is no partial
version of this: either you replay from `LAUNCH_HEIGHT` or you are not serving
the same registry.

Get a node with the history. Nothing else in this file is as important.

## Quickstart

```bash
cd deploy/resolver
cp .env.example .env
$EDITOR .env                       # NNS_RPC_URL, and the node's credentials
docker compose up -d --build
docker compose logs -f indexer
```

The first run backfills from `LAUNCH_HEIGHT` to the chain head, then tails. The
`indexer.progress` heartbeat reports height, verdict counts and rate; the API
answers `503 NOT_SYNCED` on every state route until the indexer has written
state, which is correct rather than broken.

Proofs appear at the first checkpoint boundary after that — the API serves a
proof only when it can re-derive the §8.1 root from its snapshot and match the
committed one, and degrades to `proof: null` rather than to a proof that fails
verification.

## Publishing it

Clients are browsers, so the API must be reachable over **publicly trusted
HTTPS**. The container serves plain HTTP on loopback and expects a terminator
in front; the three recipes in `../delegate/README.md` (Caddy, nginx + certbot,
a tunnel, plus the panel note) apply unchanged — only the port differs, 8635.

CORS is handled by the API itself: every response carries
`access-control-allow-origin: *`, so no header configuration is needed in your
proxy, and none should be removed. An endpoint a browser cannot read answers
`curl` perfectly while being invisible to every client that tries to use it.

Verify from outside the host:

```bash
curl -s https://nns.example.com/params
curl -s https://nns.example.com/checkpoints/latest
curl -s https://nns.example.com/resolve/<a-registered-name>
```

The proof in that last response is the product. Anyone can check it against the
root in `/checkpoints/latest` with `@nns/core` alone, and that is what makes
your answers worth comparing rather than trusting.

## Joining the quorum

Being independently runnable is not the same as being used. To have clients ask
you, your endpoint has to appear in their resolver list — `DEFAULT_RESOLVERS`
in `@nns/resolver`, which ships **empty on purpose**, and the app's
`VITE_NNS_RESOLVERS`.

An entry is a URL and a **name**: the name is what a client shows a user when
resolvers disagree, so it names the operator, not the URL. Open an issue or
contact the maintainers with both, once your endpoint answers publicly.

## Operating it

```bash
docker compose logs -f indexer
docker compose logs -f api
docker compose ps
docker compose up -d --build          # after a git pull
```

**There is nothing here to back up.** Every byte in Postgres is derived from
the chain and rebuilds from `LAUNCH_HEIGHT`; `docker compose down -v` followed
by `up` is a supported, if slow, repair. That is a property worth keeping in
mind before designing a backup strategy around it.

Two cases where a rebuild is not optional but required:

- **The spec revision changes the rules or the constants.** Roots derived under
  the old rules are not comparable with roots derived under the new ones, and
  `configFingerprint` covers configuration, not rules — so nothing refuses the
  resume for you. Release notes say when this applies.
- **The node was resynced.** If its retention no longer covers `LAUNCH_HEIGHT`,
  the indexer will refuse to start, which is the guard above doing its job on a
  database that is already correct. Fix the node, not the height.
