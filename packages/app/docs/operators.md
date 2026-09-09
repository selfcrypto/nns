# Running your own

The point of NNS is that nobody has to take the operator's word. That is only true to the degree that other people run the pieces, so this page is an invitation. Everything is a Docker Compose project in the repository under `deploy/`, one directory per role, each with its own `.env.example` and README.

## The roles

| I want to… | Role | Reachable from outside | Needs |
|---|---|---|---|
| Serve the registry, so clients can verify it against someone other than the operator | **Resolver** | its API | a Nimiq **history** node whose retention covers block {{height:LAUNCH_HEIGHT}} |
| Make `shop.myname` resolve, for names I own | **Delegate** | its HTTPS port | a JSON file and publicly trusted TLS |
| Notarise checkpoint roots on an EVM chain | **Anchor publisher** | nothing | a funded EVM key and two independent IPFS importers |
| Both of the first two on one box | **Collaborator** | API and delegate | the same history node |

Two further roles exist and are the operator's alone: **the service** (the resolver stack plus the app bundle and the RPC relay the app needs) and **settlement** (pays what the protocol owes; holds the system's only Nimiq hot keys). Nothing a third party can run holds a key of any kind.

Run one, two or all of them; they are separate Compose projects and do not interfere.

## Run a resolver

A resolver replays the chain into name → address and serves it with proofs. It is three containers — Postgres, the indexer, the read-only API — of which only the API is published. No keys, no wallet, no chain writes.

### The node comes first

You need a Nimiq **history node** whose retention covers `LAUNCH_HEIGHT`, {{height:LAUNCH_HEIGHT}}. This is the one prerequisite that cannot be corrected afterwards, and its failure is the quietest in the system: a node brought up by state sync, or one that has pruned, answers a batch below its horizon with an empty list — exactly what an empty batch looks like. An indexer pointed at one would scan the whole backfill, find nothing, and report success with an empty registry, reproducibly.

The indexer refuses to start instead, naming the earliest block the node holds. **That refusal is the good outcome.** Get a node with the history. Raising the start height is not an option: `LAUNCH_HEIGHT` is a constant in the code, not configuration, because a value one operator can set is a value two resolvers can disagree about — and a resolver that started later would confidently disagree with every other one about who owns what.

Two more things about the node: do not run it on validator hardware (a bootstrap is I/O-heavy, and disk contention risks the validator's block production), and start the history sync early, because it takes days.

### Start it

```bash
cd deploy/resolver
cp .env.example .env        # NNS_RPC_URL and the node's credentials
docker compose up -d --build
docker compose logs -f indexer
```

The first run backfills from `LAUNCH_HEIGHT` to the head, then tails. The API answers `503 NOT_SYNCED` until the indexer has written state, and serves `proof: null` until the first checkpoint boundary — every ~{{dur:CHECKPOINT_INTERVAL}} — after which proofs appear.

**Start modes.** `scratch` replays from the chain. `snapshot` seeds an empty database from another operator's public log, verified against the checkpoint that operator published, and scans forward from there; it takes minutes instead of hours and costs independence over the seeded range, which the resolver discloses on `/params` rather than hiding. `hybrid` seeds the same way and re-derives the range from the chain in the background, so it needs the full history like `scratch`.

### Publish it

Clients are browsers, so the API must be reachable over publicly trusted HTTPS. The container serves plain HTTP on loopback; put any terminator in front (Caddy, nginx with certbot, a tunnel). The API sends its own CORS headers; do not strip them. Then check from a machine that is not the server:

```bash
curl -s https://nns.example.org/params
curl -s https://nns.example.org/checkpoints/latest
curl -s https://nns.example.org/resolve/<a-registered-name>
```

The proof in that last reply is the product. Anyone can check it against the checkpoint with `@nns/core` alone, and that is what makes your answers worth comparing rather than trusting.

### Join the quorum

Being runnable is not the same as being asked. Clients ask the resolvers in their shipped list, `DEFAULT_RESOLVERS` in `@nns/resolver`, which is empty until launch. An entry is a URL and a **name** — the name is what a client shows when resolvers disagree, so it names you, not the URL. Open an issue with both once your endpoint answers publicly.

### Operating it

There is nothing to back up. Every byte in Postgres derives from the chain and rebuilds from `LAUNCH_HEIGHT`; `docker compose down -v` then `up` is a supported, if slow, repair.

Two cases require a rebuild rather than a resume:

- **A protocol revision changed the rules or the constants.** Roots derived under the old rules are not comparable with roots under the new ones, and nothing refuses the resume for you. Release notes say when this applies.
- **The node was resynced** and no longer covers `LAUNCH_HEIGHT`. The indexer refuses to start; fix the node, not the height.

## Run an anchor publisher

A publisher posts each checkpoint's commitment to the anchor contract on an EVM chain, on change and at least daily, so past claims cannot be quietly rewritten. It needs no inbound reachability: it reads a resolver's API outbound, pins outbound, sends outbound.

- **The contract is permissionless.** One function, one event, no owner. Anyone can anchor. Clients count only publishers on their shipped list, so a publisher earns trust by being listed, not by deploying anything.
- **A second publisher adds independence, not timestamping.** One publisher run by the operator who also runs the resolver proves only that the operator said it. Two must agree before a client trusts an anchor, and that second party is the whole point.
- **Two independent IPFS importers are required.** Each anchor names the public log snapshot by its IPFS address, and the publisher pins and anchors only when two different implementations mint the same address — a bundled kubo node and a second, non-kubo service. The publisher refuses to start with one.
- **The key should be a multisig signer**, and it must not share a machine with anything that terminates TLS.

The contract's compiled artifact is committed, and a `verify` command checks that a deployed address holds exactly it. Rehearse on a testnet first: what the rehearsal exercises is the configuration, which is where the mistakes are.

## Run a delegate

The smallest thing in NNS to operate: one container, one JSON file, no node, no database, no key. It answers for your own names' subdomains and proves nothing. [Subdomains](subdomains) is the whole guide.

## Keys, TLS, backups

**Keys.** A resolver, a delegate and a collaborator hold none. The service holds the node's RPC credential for the relay and no chain key. Settlement holds the two hot keys that pay refunds and proceeds; the anchor publisher holds a funded EVM key. Both keyed roles must live on a different machine from anything with a public surface.

**TLS.** Both public roles need publicly trusted HTTPS, because clients are browsers and, for a delegate, the scheme is fixed by the protocol with no downgrade. No role bundles a terminator; the recipes in the delegate's README apply to every role with only the port changed.

**Backups.** Exactly one thing in the whole system is worth backing up: the settlement ledger, which records payments that have already left a hot key. Everything else is derived — a resolver from the chain, a delegate from its JSON file, the app from the repository.

**Verify from outside.** A certificate only your browser trusts and a port only your LAN can reach both look perfect from the machine that serves them. Check every public URL from somewhere else.

**The relay** belongs to whoever hosts the app. It holds the node's credential and forwards five allowlisted methods so a browser can talk to an authenticated node. No partner needs it, and no partner role includes it.
