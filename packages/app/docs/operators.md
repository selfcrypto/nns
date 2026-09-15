# Running your own

The point of NNS is that nobody has to take the operator's word. That is only true to the degree that other people run the pieces, so this page is an invitation. Everything is a Docker Compose project in the repository under `deploy/`, one directory per role, each with its own `.env.example` and README.

## The roles

| I want to… | Role | Reachable from outside | Needs |
|---|---|---|---|
| Serve the registry, so clients can verify it against someone other than the operator | **Resolver** | its API | a Nimiq **history** node whose retention covers block {{height:LAUNCH_HEIGHT}} |
| Make `shop.myname` resolve, for names I own | **Subdomain host** | its HTTPS port | a JSON file and publicly trusted TLS |
| Notarise checkpoint roots on an EVM chain | **Anchor publisher** | nothing | a funded EVM key and two independent IPFS importers |
| Both of the first two on one box | **Collaborator** | API and host | the same history node |

Two further roles exist and are the operator's alone: the one that hosts this app, and the one that pays what the protocol owes, which holds the system's only Nimiq hot keys. Nothing in the table above holds a key of any kind.

Run one, two or all of them. They are separate Compose projects and do not interfere.

## Run a resolver

A resolver replays the chain into name → address and serves it with proofs. It is three containers (Postgres, the indexer, the read-only API), of which only the API is published. No keys, no wallet, no chain writes.

### The node comes first

You need a Nimiq **history node** whose retention covers `LAUNCH_HEIGHT`, {{height:LAUNCH_HEIGHT}}. This is the one prerequisite that cannot be corrected afterwards, and its failure is the quietest in the system. A node brought up by state sync, or one that has pruned, answers a batch below its horizon with an empty list, which is exactly what an empty batch looks like. An indexer pointed at one would scan the whole backfill, find nothing, and report success with an empty registry, reproducibly.

The indexer refuses to start instead, naming the earliest block the node holds. **That refusal is the good outcome.** Get a node with the history. Raising the start height is not an option: `LAUNCH_HEIGHT` is a constant in the code, not configuration, because a value one operator can set is a value two resolvers can disagree about.

Two more things about the node. Do not run it on validator hardware, because a bootstrap is I/O-heavy and disk contention risks the validator's block production. And start the history sync early, because it takes days.

### Start it

```bash
cd deploy/resolver
cp .env.example .env        # NNS_RPC_URL and the node's credentials
docker compose up -d --build
docker compose logs -f indexer
```

The first run backfills from `LAUNCH_HEIGHT` to the head, then tails. The API answers `503 NOT_SYNCED` until the indexer has written state, and serves `proof: null` until the first checkpoint boundary (every ~{{dur:CHECKPOINT_INTERVAL}}), after which proofs appear.

**Start modes.** `scratch` replays from the chain. `snapshot` seeds an empty database from another operator's public log, verified against the checkpoint that operator published, and scans forward from there. It takes minutes instead of hours and costs independence over the seeded range, which the resolver discloses on `/params`. `hybrid` seeds the same way and re-derives the range from the chain in the background, so it needs the full history like `scratch`.

### Publish it

Clients are browsers, so the API must be reachable over publicly trusted HTTPS. The container serves plain HTTP on loopback. Put any terminator in front (Caddy, nginx with certbot, a tunnel). The API sends its own CORS headers, so do not strip them. Then check from a machine that is not the server:

```bash
curl -s https://nns.example.org/params
curl -s https://nns.example.org/checkpoints/latest
curl -s https://nns.example.org/resolve/<a-registered-name>
```

The proof in that last reply is the product. Anyone can check it against the checkpoint with `@nimiqnames/core` alone, and that is what makes your answers worth comparing rather than trusting.

### Join the quorum

Being runnable is not the same as being asked. Clients ask the resolvers in their shipped list, `DEFAULT_RESOLVERS` in `@nimiqnames/resolver`, which carries two entries, both run by the same operator on two machines that replay separately. That is enough to catch a bug or a bad deploy on one box, and not enough to catch the operator. **A third entry run by somebody else is the check that list is still missing**, and it is the reason to run one.

An entry is a URL and a **name**. The name is what a client shows beside the endpoint, so it names you. Open an issue with both once your endpoint answers publicly. The count rises for every app on the next `@nimiqnames/resolver` upgrade, with no change in their code.

### Operating it

There is nothing to back up. Every byte in Postgres derives from the chain and rebuilds from `LAUNCH_HEIGHT`. `docker compose down -v` then `up` is a supported, if slow, repair.

Two cases require a rebuild rather than a resume.

- **A protocol revision changed the rules or the constants.** Roots derived under the old rules are not comparable with roots under the new ones, and nothing refuses the resume for you. Release notes say when this applies.
- **The node was resynced** and no longer covers `LAUNCH_HEIGHT`. The indexer refuses to start. Fix the node, not the height.

## Run an anchor publisher

A publisher posts each checkpoint's commitment to the anchor contract on an EVM chain, on change and at least daily, so past claims cannot be quietly rewritten. It needs no inbound reachability. It reads a resolver's API outbound, pins outbound, sends outbound.

- **The contract is permissionless.** One function, one event, no owner. Anyone can anchor. Clients count only publishers on their shipped list, so a publisher earns trust by being listed, not by deploying anything.
- **A second publisher adds independence, not timestamping.** One publisher run by the operator who also runs the resolver proves only that the operator said it. Two must agree before a client trusts an anchor, and that second party is the whole point.
- **Two independent IPFS importers are required.** Each anchor names the public log snapshot by its IPFS address, and the publisher pins and anchors only when two different implementations mint the same address: a bundled kubo node and a second, non-kubo service. The publisher refuses to start with one.
- **The key should be a multisig signer**, and it must not share a machine with anything that terminates TLS.

The contract's compiled artifact is committed, and a `verify` command checks that a deployed address holds exactly it. Rehearse on a testnet first. What the rehearsal exercises is the configuration, which is where the mistakes are.

## Run a subdomain host

The smallest thing in NNS to operate: one container, one JSON file, no node, no database, no key. It answers for your own names' subdomains and proves nothing ([Subdomains](subdomains)).

## Keys, TLS, backups

**Keys.** A resolver, a subdomain host and a collaborator hold none. The anchor publisher holds a funded EVM key, and it must live on a different machine from anything with a public surface.

**TLS.** Both public roles need publicly trusted HTTPS, because clients are browsers and, for a subdomain host, the scheme is fixed by the protocol with no downgrade. No role bundles a terminator. The recipes in the host's README apply to every role with only the port changed.

**Backups.** Nothing you run here needs one. Every byte of it is derived (a resolver from the chain, a host from its JSON file, the app from the repository), so the only thing to keep safe is the `.env` you filled in.

**Verify from outside.** A certificate only your browser trusts and a port only your LAN can reach both look perfect from the machine that serves them. Check every public URL from somewhere else.

**The relay** belongs to whoever hosts the app. It holds the node's credential and forwards five allowlisted methods so a browser can talk to an authenticated node. No partner needs it, and no partner role includes it.
