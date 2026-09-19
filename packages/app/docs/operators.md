# Running your own

Nobody has to take the operator's word, but only if other people run the pieces. Everything is a Docker Compose project in the repository under `deploy/`, one directory per role, each with its own `.env.example` and README.

## The roles

| I want to… | Role | Reachable from outside | Needs |
|---|---|---|---|
| Serve the registry, so clients can verify it against someone other than the operator | **Resolver** | its API | a Nimiq **history** node whose retention covers block {{height:LAUNCH_HEIGHT}} |
| Make `shop.myname` resolve, for names I own | **Subdomain host** | its HTTPS port | a JSON file and publicly trusted TLS |
| Notarise checkpoint roots on an EVM chain | **Anchor publisher** | nothing | a funded EVM key and two independent IPFS importers |
| Both of the first two on one box | **Collaborator** | API and host | the same history node |

Nothing in this table holds a Nimiq key. The roles that do, hosting the app and paying what the protocol owes, are the operator's alone.

## Run a resolver

A resolver replays the chain into name → address and serves it with proofs. It is three containers (Postgres, the indexer, the read-only API), of which only the API is published.

### The node comes first

You need a Nimiq **history node** whose retention covers `LAUNCH_HEIGHT`, {{height:LAUNCH_HEIGHT}}. A node brought up by state sync, or one that has pruned, answers a batch below its horizon with an empty list, exactly as an empty batch does, so an indexer pointed at one would scan everything, find nothing, and report an empty registry as success.

The indexer refuses to start instead, naming the earliest block the node holds. **That refusal is the good outcome.** Get a node with the history. `LAUNCH_HEIGHT` is a constant in the code, not configuration.

Do not run the node on validator hardware. Start the history sync early, because it takes days.

### Start it

```bash
cd deploy/resolver
cp .env.example .env        # NNS_RPC_URL and the node's credentials
docker compose up -d --build
docker compose logs -f indexer
```

The first run backfills from `LAUNCH_HEIGHT` to the head, then tails. The API answers `503 NOT_SYNCED` until the indexer has written state, and serves `proof: null` until the first checkpoint (every ~{{dur:CHECKPOINT_INTERVAL}}).

**Start modes.** `scratch` replays from the chain. `snapshot` seeds an empty database from another operator's public log, verified against the checkpoint that operator published, and scans forward from there. It takes minutes instead of hours, and the resolver discloses the seeded range on `/params`. `hybrid` seeds the same way and re-derives the range from the chain in the background.

### Publish it

Clients are browsers, so the API must be reachable over publicly trusted HTTPS. The container serves plain HTTP on loopback. Put any terminator in front (Caddy, nginx with certbot, a tunnel) and do not strip the API's CORS headers. Then check from a machine that is not the server:

```bash
curl -s https://nns.example.org/params
curl -s https://nns.example.org/checkpoints/latest
curl -s https://nns.example.org/resolve/<a-registered-name>
```

### Join the quorum

Clients ask the resolvers in their shipped list, `DEFAULT_RESOLVERS` in `@nimiqnames/resolver`. It carries two entries, both run by the same operator. **A third entry run by somebody else is the check that list is still missing.**

An entry is a URL and a name. Open an issue with both once your endpoint answers publicly. The count rises for every app on the next `@nimiqnames/resolver` upgrade.

### Operating it

There is nothing to back up. Every byte in Postgres derives from the chain, and `docker compose down -v` then `up` is a supported, if slow, repair.

Two cases require a rebuild rather than a resume:

- **A protocol revision changed the rules or the constants.** Release notes say when this applies, and whether the revision is *log-preserving*. Most are: they change verdicts but not which transactions are logged, so the indexer replays its own log in seconds, with no node and the API up throughout:

  ```bash
  git pull && docker compose build
  docker compose stop indexer
  docker compose run --rm --no-deps indexer node dist/rebuild-main.js --log-preserving <revision>
  docker compose up -d
  ```

  If the rebuild refuses, the database is unchanged. Do not start the new image over it: rows derived under the old rules resume silently wrong. A revision that is not log-preserving needs the full replay from the chain, `down -v` then `up`.
- **The node was resynced** and no longer covers `LAUNCH_HEIGHT`. The indexer refuses to start. Fix the node.

## Run an anchor publisher

A publisher posts each checkpoint's commitment to the anchor contract on an EVM chain, on change and at least daily. It needs no inbound reachability.

- **The contract is permissionless.** One function, one event, no owner. Anyone can anchor. Clients count only publishers on their shipped list.
- **A second publisher adds independence.** One publisher run by the operator who also runs the resolver proves only that the operator said it.
- **Two independent IPFS importers are required.** Each anchor names the public log snapshot by its IPFS address, and the publisher anchors only when two different implementations mint the same address: a bundled kubo node and a second, non-kubo service.
- **The key should be a multisig signer**, on a machine that terminates no TLS.

The contract's compiled artifact is committed, and a `verify` command checks that a deployed address holds exactly it. Rehearse on a testnet first.

## Run a subdomain host

The smallest thing in NNS to operate: one container, one JSON file, no node, no database, no key ([Subdomains](subdomains)).

## Keys, TLS, backups

**Keys.** A resolver, a subdomain host and a collaborator hold none. The anchor publisher holds a funded EVM key, on a machine with no public surface.

**TLS.** Both public roles need publicly trusted HTTPS. No role bundles a terminator. The recipes in the subdomain host's README apply to every role with only the port changed.

**Backups.** Nothing you run here needs one. Keep the `.env` you filled in.

**Verify from outside.** A certificate only your browser trusts and a port only your LAN can reach both look fine from the machine that serves them. Check every public URL from somewhere else.
