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
cp ../../packages/delegate/labels.example.json labels.json
$EDITOR labels.json
docker compose up -d --build
curl -s http://127.0.0.1:8636/healthz
```

Then put TLS in front of it, and send the `D`. Both are below, in that order —
a `D` naming a host that is not yet serving over HTTPS turns subdomains **off**
for that name until it is.

## The labels file

```json
{
  "version": 1,
  "name": "alice",
  "defaultTtl": 300,
  "labels": {
    "shop": "NQ34 248H 248H 248H 248H 248H 248H 248H 248H",
    "pay": { "address": "NQ93 48H2 48H2 48H2 48H2 48H2 48H2 48H2 48H2", "ttl": 60 }
  }
}
```

Mounted read-only. Edit it on the host and the next poll (5 s) picks it up —
no restart, no downtime, and a file that fails to parse leaves the previous one
serving rather than serving nothing. `SIGHUP` forces a reload.

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

Whatever you use, verify from **outside** the host — a certificate that only
your browser trusts, or a port only your LAN can reach, both look fine from the
machine that serves them:

```bash
curl -s https://nns.example.com/delegated/v1/alice/shop
# {"address":"NQ34 …","ttl":300}
```

## Publishing the `D`

Only after the URL above answers:

1. Hold the owner key of the name.
2. Send `NNS1D<name>|<host>` from the owner address (`packages/admin`, or any
   wallet that can set transaction data). The host is bare and lowercase:
   `nns.example.com`, or `nns.example.com/alice` if this host serves several
   names. **Name and host together are capped at 52 characters.**
3. Resolve `shop.alice` in a client and check the address it shows.

A later `D` with an empty host clears the delegation and turns subdomain
resolution off for the name.

## Operating it

```bash
docker compose logs -f
docker compose exec delegate kill -HUP 1     # force a labels reload
docker compose up -d --build                 # after a git pull
```

`/healthz` reports the loaded file: `{"ok":true,"name":…,"labels":N,"loadedAt":…}`.
It sits under `NNS_DELEGATE_BASE_PATH` when one is set, so two delegates behind
one certificate stay distinguishable.

What to watch: **the labels file is the whole product**. There is no backup
worth taking that is not a copy of that file, and there is nothing to rebuild —
a lost delegate is a `docker compose up` and a JSON file away from being back.
