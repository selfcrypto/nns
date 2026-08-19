# Running a delegate

A delegate answers `shop.yourname` for names you own. It is the smallest thing
in NNS to operate: one container, one JSON file, one port. No node, no
database, no key, no chain access.

**A delegate is not a resolver.** It joins no quorum, proves nothing, and
answers only for your own names — §8.6's reply carries no proof, and clients
label it differently for that reason. If you want to serve the registry itself,
that is `deploy/resolver`. `docs/runbooks/operators.md` lays the roles side by
side; `packages/delegate/README.md` is what this server does and does not
promise, including why its 404 tells a caller nothing.

## Quickstart

```bash
cd deploy/delegate
cp .env.example .env                                     # every line optional
mkdir -p labels
cp ../../packages/delegate/labels.example.json labels/labels.json
$EDITOR labels/labels.json
docker compose up -d --build
curl -s http://127.0.0.1:8636/healthz
```

Then put TLS in front of it, and send the `D`. Both are below, in that order —
a `D` naming a host that is not yet serving over HTTPS turns subdomains **off**
for that name until it is.

## The labels file

```json
{
  "defaultTtl": 300,
  "names": {
    "alice": {
      "shop": "NQ34 248H 248H 248H 248H 248H 248H 248H 248H",
      "pay": { "address": "NQ93 48H2 48H2 48H2 48H2 48H2 48H2 48H2 48H2", "ttl": 60 }
    },
    "bob": {
      "shop": "NQ60 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK"
    }
  }
}
```

Lives at `labels/labels.json`, with the **directory** mounted read-only — not
the file, because a single-file bind mount pins the inode, and the atomic save
most editors do (write a temp file, rename it into place) would swap the inode
out from under the mount: the host file changes, the container serves the old
bytes forever, and the healthcheck stays green. With the directory mounted,
edit the file with anything and the next poll (5 s) picks it up — no restart,
no downtime, and a file that fails to parse leaves the previous one serving
rather than serving nothing. `SIGHUP` forces a reload.

## TLS is mandatory, and it is yours

§8.6 fixes the scheme. A `D` host is a bare hostname — no scheme, no port,
`validateHost` rejects `:` — so every client builds `https://<host>/…` on 443
and hardcodes it. A delegate on plain HTTP is a delegate no client will ever
reach, and there is no downgrade and no fallback.

The container serves plain HTTP on loopback and expects a terminator in front.
Three that work, in ascending order of what you have to know:

**Caddy** — a certificate and its renewal, in two lines:

```caddyfile
nns.example.com {
    reverse_proxy 127.0.0.1:8636
}
```

**nginx + certbot** — if nginx is already there:

```nginx
server {
    listen 443 ssl;
    server_name nns.example.com;
    ssl_certificate     /etc/letsencrypt/live/nns.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nns.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8636;
        proxy_set_header Host $host;
    }
}
```

**A tunnel** — if the host has no public IP, or you would rather not open one.
`cloudflared tunnel --url http://127.0.0.1:8636` gives a working HTTPS
hostname; a named tunnel with a DNS route gives a stable one. The certificate
is the provider's, which is fine: the client requires *publicly trusted* TLS,
not TLS you issued.

**On a panel (Plesk, cPanel, Runcloud):** add the subdomain, let the panel
issue the Let's Encrypt certificate, and point one `location /` proxy rule at
`127.0.0.1:8636`. On Plesk that is *Apache & nginx Settings* → uncheck **Proxy
mode** → *Additional nginx directives*; if it refuses the block as a duplicate
`location "/"`, proxy mode is still on.

**On a host you already serve** — a delegate does not need a hostname of its
own. Pick a path, mount it, and put that path in the `D`:

```nginx
location /delegated/ {
    proxy_pass http://127.0.0.1:8636;
    proxy_set_header Host $host;
}
```

with `D` = `example.com/delegated`. **No `rewrite`, unlike the registry API's
`/api/`** (`deploy/service/nginx.conf`): the prefix is part of the address the
client builds out of the `D`, so no proxy *could* strip it, and the container
does not need it stripped — it reads the parent and the label as the last two
segments and ignores the mount.

Whatever you use, verify from **outside** the host — a certificate that only
your browser trusts, or a port only your LAN can reach, both look fine from the
machine that serves them:

```bash
curl -s https://nns.example.com/alice/shop
# {"address":"NQ34 …","ttl":300}
```

## Publishing the `D`

Only after the URL above answers:

1. Hold the owner key of the name.
2. Send `NNS1D<name>|<host>` from the owner address (`packages/admin`, or any
   wallet that can set transaction data). The host is bare and lowercase:
   `nns.example.com`. **Name and host together are capped at 52 characters.**
   A short path is permitted and says *where the delegate listens* — it is
   **not** how two names share a host (§6 `D`), which the parent segment in the
   request has covered since r23, and it spends budget a longer name may need.
3. Resolve `shop.alice` in a client and check the address it shows.

**The URL is the `D` and nothing else** — §8.6 is `https://<host>/<parent>/<label>`
and the client appends no segment of its own (r25). So the word `delegated`, if
you want it in the URL at all, goes wherever you put it and appears once:

```
D = nns.example.com          →  https://nns.example.com/alice/shop
D = example.com/delegated    →  https://example.com/delegated/alice/shop
```

That is the registry API's arrangement — `api.example.com/resolve/alice` or
`example.com/api/resolve/alice`, operator's choice — and through r24 a delegate
could not have it: the client appended `delegated/v1` unconditionally, so
naming the host after the service produced it twice.

A later `D` with an empty host clears the delegation and turns subdomain
resolution off for the name.

## Operating it

```bash
docker compose logs -f
docker compose exec delegate kill -HUP 1     # force a labels reload
docker compose up -d --build                 # after a git pull
```

`/healthz` reports the loaded file: `{"ok":true,"names":N,"labels":N,"loadedAt":…}`
— counts, never which names, because it answers on the same public host as the
lookups and a roster of the names you serve is not the caller's business. It
answers under whatever path the container is mounted at, so it needs no more
configuration than the lookups do. The names are in the boot log.

What to watch: **the labels file is the whole product**. There is no backup
worth taking that is not a copy of that file, and there is nothing to rebuild —
a lost delegate is a `docker compose up` and a JSON file away from being back.
