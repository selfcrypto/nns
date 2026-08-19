# deploy/chat — the NC chat index

Indexes the NC chat messages of [`../../docs/app-chat.md`](../../docs/app-chat.md)
and serves them by address, so the app's Inbox is one small request per
address instead of pulling that address's entire transaction history.

**Optional, and genuinely so.** With `VITE_NNS_CHAT` unset the app reads the
chain through the relay and everything works; this service only makes it
cheap. Nothing about the registry depends on it.

## What it is not

It is **not** one of the five roles in [`../README.md`](../README.md). It
serves no protocol data, holds no key, and shares no code or database with the
indexer, the API or `core` — its own scan, its own Postgres, its own RPC
client. Running only this is not serving NNS.

## Run it

```
cp .env.example .env      # set the node URL, the credentials, the start height
docker compose up -d --build
curl -s localhost:8637/healthz
```

`healthz` answers `{"ok":true,"startHeight":…,"nextBatch":…}`. `nextBatch`
climbing is the scan working; it catches up at roughly a batch per node
round-trip, so a few hundred thousand blocks is minutes, not hours.

## The one irreversible input

`NNS_CHAT_START_HEIGHT` is **fixed for the life of the database**. The service
refuses to start if it changes, and that refusal is the point: this number is
the window every reader is told, so raising it would hide messages the index
holds and lowering it would claim messages it never scanned. To change it,
start a fresh database — the chain is the source, so it costs only a re-scan.

Pick a height at or below the first chat traffic you care about. Earlier costs
one node call per batch of empty history and buys nothing.

## Put it behind TLS, on its own hostname

A browser calls this endpoint directly, so it needs a public HTTPS name — the
same shape as the delegate's. With Caddy:

```
chat.example.com {
    reverse_proxy 127.0.0.1:8637
}
```

Then build the app with `VITE_NNS_CHAT=https://chat.example.com` (see
[`../service/.env.example`](../service/.env.example)). CORS is already open on
every response: the app is independently hostable by design, so an origin
allowlist would break the copies §2.2 exists to permit.

Verify from outside, not from the box:

```
curl -s "https://chat.example.com/messages/NQ..." | head
```

## What you are taking on

- **A second pass over the chain.** It walks the same batches the resolver
  role's indexer walks — about 720 node calls a day, against your own node.
  That duplication is deliberate: chat code inside the loop that produces
  roots is the coupling the whole convention exists to avoid.
- **A queryable message corpus.** The messages are public on chain either way,
  but an index turns "each user pulls their own history" into "anyone can ask
  this service what an address said". Retention is your call, and the database
  is disposable — every row is rebuildable from the chain by re-scanning.

## Backups

None needed. Lose the volume and re-scan; the only cost is the catch-up time.
Set `NNS_CHAT_START_HEIGHT` to the same value it had, which is also what the
service will insist on if you keep the database.
