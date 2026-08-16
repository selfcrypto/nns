# @nns/delegate

A reference **delegate host**: the small HTTP server a name owner runs to
answer for their own subdomains.

You own `binance`. You point a `D` at a host you control, write a JSON file of
`label → address`, and every NNS client that resolves `shop.binance` asks your
server for the answer. NNS stores nothing per subdomain, charges nothing per
subdomain, and knows nothing about them.

```bash
cp .env.example .env          # NNS_DELEGATE_LABELS=./labels.json
pnpm --filter @nns/delegate dev
curl localhost:8636/delegated/v1/binance/shop
# {"address":"NQ12 3456 …","ttl":300}
```

This is **not** registry infrastructure. A resolver is run by whoever operates
NNS; a delegate is run by a name owner, answering for their own names. A
partner may well run both — that is a compose profile, not a shared service.

## What is proven, and what is not

Nothing this server says is proven by anything.

NNS proves two things about `shop.binance`: that `binance` is registered to a
particular owner, and that its owner designated **this host**. Both come out of
the checkpoint through an ordinary inclusion proof. The address this server
returns for `shop` is your word and nothing else's — no signature, no
guarantee, no protocol recourse past the dot.

That boundary is deliberate. An exchange already controls the deposit addresses
it is naming; making the registry ratify them would buy nothing and would cost
a per-subdomain fee, a growing log, and a Merkle tree that no longer fits in a
phone. Clients are required to render the two halves differently
(`@nns/resolver` marks every such answer `DELEGATED` and attaches a
`DELEGATED_ANSWER` warning), so a user is never told an unverified address is
verified.

**The consequence for you: your host's security is your subdomains' security.**
A compromised delegate serves whatever addresses the attacker likes, and no
part of NNS will notice. Signed responses are a fixed format waiting for a v2
that requires them.

## The request tells you which name asked

```
GET https://<host>/delegated/v1/<parent>/<label>
```

The parent is in the path, so two names delegating to the same host have
**separate** namespaces: `shop.binance` and `shop.nq` are different questions
and you may answer them differently.

- **The `name` in your labels file is a gate.** This server answers only for
  the name that file declares, and refuses any other parent with the same
  `404 NO_ANSWER` it gives an unheld label — never a distinguishable error,
  because a client must not be able to learn which names you serve. Serving two
  names means two files and two processes (or two `NNS_DELEGATE_BASE_PATH`
  routes); a stale `name` means nothing resolves, which is the failure you
  want.
- **A short `D` path is for mounting, not for separation.** Point one process
  at `nns.example.com/binance` and another at `nns.example.com/nq` if it suits
  your deployment — but the namespaces are separate whether or not you do.

`@nns/resolver` keys its answer cache on host, parent and label — the same
triple the request carries.

**This changed in r23, and the old shape is dead.** Through r22 the request was
`GET https://<host>/nns/v1/resolve/<label>` — the label alone — so a host could
not tell two parents apart and one answer served both, silently, with a payment
address as the wrong answer. Clients do **not** fall back to it: if you are
running an older delegate, every subdomain under it stops resolving until you
upgrade, which is deliberate.

## The labels file

```json
{
  "version": 1,
  "name": "binance",
  "defaultTtl": 300,
  "labels": {
    "shop": "NQ12 3456 789A BCDE FGHJ KLMN PQRS TUVX YZ01",
    "pay": { "address": "NQ98 7654 321Z YXVU TSRQ PNML KJHG FEDC BA98", "ttl": 60 }
  }
}
```

A bare string is the address. The object form is for a label that wants a `ttl`
of its own; everything else takes `defaultTtl`. Labels are lowercase `a-z`,
`0-9` and `-`, up to 24 characters — the same rule the client applies before it
ever builds a request, checked here with the same code.

**A bad entry rejects the whole file, and the error names the key:**

```
{"level":"error","msg":"delegate.labels.rejected","key":"labels.pay",
 "error":"labels.pay: not a Nimiq address: …","serving":"previous"}
```

Serving the rest and skipping the bad line would take one subdomain out of
service with no error anywhere you would look for one.

**It reloads without a restart.** The file's mtime and size are polled every
`NNS_DELEGATE_RELOAD_SEC` (5 by default) and `SIGHUP` forces a reload —
polling rather than `fs.watch`, because an atomic save replaces the inode and a
bind mount delivers no events at all. A reload that fails changes nothing: the
previous file keeps serving and the error is logged. A file that is invalid **at
startup** is fatal instead, because there is nothing good to fall back to.

## Endpoints

| | |
|---|---|
| `GET /delegated/v1/{parent}/{label}` | `200 {"address":"NQ…","ttl":N}` — the answer |
| | `404 {"error":"NO_ANSWER"}` — no such label here, **or not a parent this file answers for** |
| | `400 {"error":"BAD_LABEL"}` — not a valid label |
| | `400 {"error":"BAD_PARENT"}` — not a valid §4.1 name |
| `GET /healthz` | `{"ok":true,"name":…,"labels":N,"loadedAt":…}` |

Both sit under `NNS_DELEGATE_BASE_PATH` when one is set. Every response carries
`access-control-allow-origin: *` — clients are browser mini apps, and a
delegate without CORS fails in a browser while passing every test you run with
curl. Answers carry `cache-control: public, max-age=<ttl>`; everything else is
`no-store`.

**Your 404 is honest and it stays private.** A client cannot tell it from a
timeout, a DNS failure or a 502: `@nns/resolver` collapses every one of them
into a single `DELEGATE_FAILED`. So NNS never reports that a subdomain does not
exist — it reports that your host did not answer, which is the only thing it
actually knows.

There is no bulk listing endpoint, deliberately. Nothing in the client uses one,
and it would turn "the owner serves what it likes" into an enumeration surface.

## Configuration

| Variable | Default | |
|---|---|---|
| `NNS_DELEGATE_LABELS` | *required* | Path to the labels file |
| `NNS_DELEGATE_NAME` | — | Cross-checked against the file's `name` at boot |
| `NNS_DELEGATE_HOST` | `127.0.0.1` | Bind address; containers set `0.0.0.0` |
| `NNS_DELEGATE_PORT` | `8636` | |
| `NNS_DELEGATE_BASE_PATH` | *(none)* | Prefix, for one host serving several names |
| `NNS_DELEGATE_DEFAULT_TTL` | `300` | Used when the file states none |
| `NNS_DELEGATE_RELOAD_SEC` | `5` | File poll interval |
| `NNS_LOG_LEVEL` | `info` | |

No keys, no database, no chain access, no §3 constants. The only NNS code it
uses is `@nns/core` for label syntax and address parsing — the same functions
the client validates with, so this server cannot accept a label the client
would never send or serve an address the client would reject.

## Running one for real

1. Register the name and hold the owner key.
2. Stand the server up behind TLS at a host you control. `https://` is implied
   and mandatory — §8.6 fixes the scheme and clients hardcode it.
3. Send the `D`: `packages/admin`, or any wallet, with data
   `NNS1D<name>|<host>`. Name and host together must be ≤ 52 characters, and
   the host is bare — no scheme, lowercase, `a-z 0-9 . - /`.
4. Check it: `curl https://<host>/delegated/v1/<name>/<label>`, then resolve
   `<label>.<name>` through a client.

An empty host in a later `D` clears the delegation and turns subdomain
resolution off for the name.
