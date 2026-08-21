# deploy/edge — TLS for a bare host

One nginx (stock `nginx:1-alpine`, whose `ngx_http_acme_module` issues and
renews the certificates itself), host networking, and a hostname-to-port map
rendered from `.env`. It is the TLS terminator for a machine that has nothing
else in front — nothing in it is NNS-specific beyond the ports it proxies.

**You probably do not need this.** Every NNS service speaks plain HTTP on
loopback and expects a terminator it does not own. If you run Plesk, cPanel,
an existing nginx or Caddy, Cloudflare, or a tunnel, point a hostname at the
port and skip this directory — `../README.md` has the table, and
`../delegate/README.md` the recipes.

## Run it

```bash
cp .env.example .env      # your hostnames — they must already resolve here
docker compose up -d
```

Port 80 must be reachable from the internet: that is how the http-01
challenge is answered. Delete the server blocks for roles you do not run — a
hostname nginx is told to certify but nobody points DNS at is a renewal that
fails forever.

The status page of `deploy/monitor` is an overlay, not a fourth block:
`COMPOSE_FILE=docker-compose.yml:status.yml` in `.env` plus
`NNS_EDGE_STATUS_HOST`. Only the page's anonymous paths are proxied; the Kuma
dashboard and login stay loopback-only, reached over an SSH tunnel.

## Two things worth knowing before they cost a week

- **`acme-state` is a named volume and must stay one.** It holds the ACME
  account key and every certificate. On an ephemeral filesystem each recreate
  re-registers and re-issues, and Let's Encrypt allows **5 duplicate
  certificates per week** — a few restarts on a bad afternoon is a week with
  no HTTPS, surfacing later as an expired certificate, not as a message about
  restarts.
- **Rehearse against staging when in doubt.** `NNS_EDGE_ACME_URI` in `.env`
  points issuance at Let's Encrypt staging, which proves DNS, port 80 and the
  config without spending the production quota. Staging certificates are not
  browser-trusted — that is the point: it proves issuance, not trust.

The `X-Forwarded-For` handling in `nginx.conf.template` is load-bearing and
commented where it happens: the relay keys its rate limiter on the *first*
entry, so the edge **sets** the header and never appends.

## Migrating from a host terminator (Caddy, systemd nginx)

Both want ports 80/443, so the rehearsal is the start of the cutover window.
With `deploy/vps/nns-vps` this is `nns-vps up edge --staging` and then
`nns-vps up edge`; by hand:

1. Put the staging URI in `.env`. `sudo systemctl stop caddy` (stop, not
   disable — it is still the rollback), then `docker compose up -d` here.
2. Confirm every hostname answers HTTPS with a staging certificate
   (`curl -kIs https://<host> | head -1` for each). That proves issuance.
3. `docker compose down && docker volume rm nns-edge_acme-state` — drop the
   staging account and certificates so production state starts clean — then
   remove the staging URI from `.env` and `docker compose up -d`.
4. Check every hostname again, now without `-k`. On success:
   `sudo systemctl disable --now caddy`.

**Rollback at any point:** `docker compose down` and
`sudo systemctl start caddy` — its certificates are still in its own state
and were never touched.
