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
curl localhost:8636/binance/shop
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
(`@nimiqnames/resolver` marks every such answer `DELEGATED` and attaches a
`DELEGATED_ANSWER` warning), so a user is never told an unverified address is
verified.

**The consequence for you: your host's security is your subdomains' security.**
A compromised delegate serves whatever addresses the attacker likes, and no
part of NNS will notice. Signed responses are a fixed format waiting for a v2
that requires them.

## The request tells you which name asked

```
GET https://<host>/<parent>/<label>
```

The parent is in the path, so two names delegating to the same host have
**separate** namespaces: `shop.binance` and `shop.nq` are different questions
and you may answer them differently.

- **One file serves every name you own.** The labels file is `name → label →
  address`, so a single process answers for every name whose `D` points here.
  That is what the parent in the request is for; you do not need a container,
  a port or a proxy route per name.
- **The `names` in your file are the gate.** A request naming a name the file
  does not carry gets the same `404 NO_ANSWER` as an unheld label — never a
  distinguishable error, because a client must not be able to learn which
  names you serve. `/healthz` reports counts for the same reason.
- **A short `D` path is for mounting, not for separation.** Point one process
  at `nns.example.com/binance` and another at `nns.example.com/nq` if it suits
  your deployment — but the namespaces are separate whether or not you do, and
  a bare host leaves more of `MAX_HOST_LEN`'s 30 characters for the name.

`@nimiqnames/resolver` keys its answer cache on host, parent and label — the same
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
  "defaultTtl": 300,
  "names": {
    "binance": {
      "shop": "NQ12 3456 789A BCDE FGHJ KLMN PQRS TUVX YZ01",
      "pay": { "address": "NQ98 7654 321Z YXVU TSRQ PNML KJHG FEDC BA98", "ttl": 60 }
    },
    "kraken": {
      "shop": "NQ12 3456 789A BCDE FGHJ KLMN PQRS TUVX YZ01"
    }
  }
}
```

One entry per name you own, and a bare string is the address. The object form
is for a label that wants a `ttl` of its own; everything else takes
`defaultTtl`. Names and labels are both lowercase `a-z`, `0-9` and `-` — labels
up to 24 characters, the same rule the client applies before it ever builds a
request, checked here with the same code.

There is no `version` field: this is a draft protocol with nothing deployed to
stay compatible with.

**A bad entry rejects the whole file, and the error names the key:**

```
{"level":"error","msg":"delegate.labels.rejected","key":"names.binance.pay",
 "error":"names.binance.pay: not a Nimiq address: …","serving":"previous"}
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
| `GET /{parent}/{label}` | `200 {"address":"NQ…","ttl":N}` — the answer |
| | `404 {"error":"NO_ANSWER"}` — no such label here, **or not a parent this file answers for** |
| | `400 {"error":"BAD_LABEL"}` — not a valid label |
| | `400 {"error":"BAD_PARENT"}` — not a valid §4.1 name |
| `GET /healthz` | `{"ok":true,"names":N,"labels":N,"loadedAt":…}` — counts, never the names |

The lookup answers under whatever path the server is mounted at; `/healthz` is
the whole path or it is not the probe (below). Every response carries
`access-control-allow-origin: *` — clients are browser mini apps, and a
delegate without CORS fails in a browser while passing every test you run with
curl. Answers carry `cache-control: public, max-age=<ttl>`; everything else is
`no-store`.

**Your 404 is honest and it stays private.** A client cannot tell it from a
timeout, a DNS failure or a 502: `@nimiqnames/resolver` collapses every one of them
into a single `DELEGATE_FAILED`. So NNS never reports that a subdomain does not
exist — it reports that your host did not answer, which is the only thing it
actually knows.

There is no bulk listing endpoint, deliberately. Nothing in the client uses one,
and it would turn "the owner serves what it likes" into an enumeration surface.
`/healthz` is held to the same rule: it reports how many names and labels are
loaded and never which, because it answers on the same public host as the
lookups do.

## Subdomain, path, or both — and nothing to configure

The server never reads the `Host` header, and it is never told what path it is
mounted at. **The last two segments are the parent and the label**, and
everything before them is where it sits, so all of these are one request:

```
/alice/shop
/delegated/alice/shop
/some/deep/mount/alice/shop
```

Publish it on a subdomain, under a path, or both at once — it answers either
way with no setting to match. A §6 `D` host may carry a short path
(`nns.example.com/labels`), and because the client builds the URL from the
recorded host, that prefix arrives here where no proxy could strip it.

**A path says where the delegate listens. It never says which name is being
asked about** — names come from your labels file and from the parent segment
in the request, and §6 `D` agrees: the short path mounts several *processes*
and "is not what separates two names sharing a host". So adding a customer is
an edit to the JSON and nothing else.

The prefix is not an access boundary and never was. Routing between two
containers happens at your proxy, which is the layer that can enforce it.

**Which is why §8.6 stopped supplying a prefix of its own (r25).** Through r24
the client appended a fixed `delegated/v1`, so the one word both named the
service and owned a path segment, and an operator who named the host after the
service got it twice — `delegated.example.com/delegated/alice/shop`. The
registry API never reads that way because its two words differ: `api` names the
host, `resolve` names the route. Now the word is yours to place once:

```
D = nns.example.com          →  https://nns.example.com/alice/shop
D = example.com/delegated    →  https://example.com/delegated/alice/shop
```

An r24 client still gets a correct answer here — its `/delegated/v1/…` is
simply a mount this server was told nothing about, and the parent and label it
carries are the same two. That is one shape reached two ways, not two shapes
served; the break runs the other way, where an r25 client meets an r24 delegate
still scanning for a marker and gets nothing at all.

### `/healthz` is the whole path, or it is not the probe

A lookup is always two segments, so a one-segment request is the only thing
that cannot be one — and with no marker left, that is the whole
disambiguation. It has to fall this way: `healthz` is a valid §4.4 label, an
owner may hold `healthz.alice`, and answering that lookup with a health body is
a wrong address served silently.

The cost is that behind a mount your proxy does not strip, `/<mount>/healthz`
is two segments and reads as a lookup for the label `healthz` under a parent
named after the mount — a 404. Probe the container directly, as the compose
healthcheck does, or the mount root behind a proxy that strips.

## Configuration

| Variable | Default | |
|---|---|---|
| `NNS_DELEGATE_LABELS` | *required* | Path to the labels file |
| `NNS_DELEGATE_NAME` | — | Comma-separated; each must be present in the file at boot |
| `NNS_DELEGATE_HOST` | `127.0.0.1` | Bind address; containers set `0.0.0.0` |
| `NNS_DELEGATE_PORT` | `8636` | |
| `NNS_DELEGATE_DEFAULT_TTL` | `300` | Used when the file states none |
| `NNS_DELEGATE_RELOAD_SEC` | `5` | File poll interval |
| `NNS_LOG_LEVEL` | `info` | |

No keys, no database, no chain access, no §3 constants. The only NNS code it
uses is `@nimiqnames/core` for label syntax and address parsing — the same functions
the client validates with, so this server cannot accept a label the client
would never send or serve an address the client would reject.

## Running one for real

1. Register the name and hold the owner key.
2. Stand the server up behind TLS at a host you control. `https://` is implied
   and mandatory — §8.6 fixes the scheme and clients hardcode it.
3. Send the `D`: `packages/admin`, or any wallet, with data
   `NNS1D<name>|<host>`. Name and host together must be ≤ 52 characters, and
   the host is bare — no scheme, lowercase, `a-z 0-9 . - /`.
4. Check it: `curl https://<host>/<name>/<label>`, then resolve
   `<label>.<name>` through a client.

An empty host in a later `D` clears the delegation and turns subdomain
resolution off for the name.
