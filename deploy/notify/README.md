# deploy/notify — email and Telegram notifications

Tells an address, by email or Telegram, what happened to its names: renewal
reminders, sales and bids, transfers to it, new messages. The brief is
[`../../tasks/26-notifications.md`](../../tasks/26-notifications.md); the
package is [`../../packages/notify`](../../packages/notify).

**Optional, and genuinely so.** With `VITE_NNS_NOTIFY` unset the app shows no
Notifications row and everything else works. Nothing about the registry
depends on this service.

## What it is not

It is **not** one of the roles in [`../README.md`](../README.md). It serves no
protocol data, holds no Nimiq key and no node credential, and reads only the
public API and the chat index, the same data the app shows. Running only this
is not serving NNS.

## Run it

```
cp .env.example .env && chmod 600 .env
docker compose up -d --build
curl -s localhost:8638/healthz
```

`healthz` answers `{"ok":true,"channels":{"email":…,"telegram":…}}`. Both
channels are optional: no bot token means no Telegram, no SMTP host means no
email, and the app's sheet says which exist.

## Before the first start

- **A Telegram bot**, from [BotFather](https://t.me/BotFather). Put the
  token in `.env`. The bot's username is read from the token; users reach it
  through a `t.me/<bot>?start=<code>` link the app shows, never by typing a
  handle. Long polling, so no webhook and no inbound route.
- **A mailbox on a domain your mail server signs for.** DKIM and DMARC are
  the server's business; this client speaks SMTP submission (587 with
  STARTTLS, or 465) and refuses to authenticate in the clear.
- **`NNS_NOTIFY_PUBLIC_URL`**, the base of every link it mails. Under
  [`../edge`](../edge/) it is the app's origin plus `/notify`.
- **The API and chat URLs are the public ones**, even on the box that runs
  them: the other roles publish on the host's loopback, which a container
  cannot reach.

## Put it behind TLS

A browser calls this service and confirmation links land on it, so it needs
a public HTTPS path. With [`../edge`](../edge/) it has one: the app's vhost
proxies `/notify/` to this service's loopback port. Build the app with
`VITE_NNS_NOTIFY=/notify` and the corner panel gains its row. Behind another
terminator, add the same path under the app's origin or give it a hostname
of its own, and set `NNS_NOTIFY_PUBLIC_URL` to match. CORS is open on every
response: authority is the bearer session, never the origin.

## The one thing that is not rebuildable

Every other database under `deploy/` is derived from the chain. This one
holds **contacts**: who wants to be told, and where. Lose the volume and
nothing breaks, but everyone signs in again and adds their email again.
Back up `notify-data` if that matters to you, and treat the dump as the
personal data it is.

The send-once ledger lives in the same database. A restart never re-sends;
a fresh database starts at the current checkpoint and narrates nothing older.

## What you are taking on

- **Personal data.** An email address or a Telegram chat id per contact.
  Every message carries a one-click unsubscribe, the bot understands
  `/stop`, and the sheet's delete row removes everything about an address.
  Nothing here ever enters a payload or a root.
- **A sending reputation.** The service sends only to confirmed contacts,
  once per event, and drops a contact after repeated refusals. What it
  cannot do is make a bad domain look good; the DKIM and DMARC are yours.

## Email from this box

A box with no mail server can send its own, outbound only, with the `mail`
profile: a Postfix relay with DKIM that listens inside the compose network,
opens no port on the host and receives nothing. Four things, in order:

1. **Reverse DNS.** At the provider's panel, set the IP's PTR to a name
   like `mail.example.com`, and give that name an A record back to the IP.
   Google and the rest refuse mail from an IP whose reverse name does not
   resolve to it. Check outbound port 25 is open from the box first (most
   VPS providers open it on request).
2. `.env`: `NNS_NOTIFY_MAIL_DOMAIN`, `NNS_NOTIFY_MAIL_HOSTNAME` (the PTR
   name), then `docker compose --profile mail up -d mailer`. The relay
   generates its DKIM key on first start; read the public half with
   `docker compose exec mailer cat /etc/opendkim/keys/<domain>.<selector>.txt`
   (the selector is `notify` unless changed).
3. **Three TXT records** on the domain: `v=spf1 ip4:<the IP> -all` at the
   apex, the DKIM record at `<selector>._domainkey`, and
   `v=DMARC1; p=quarantine` at `_dmarc`.
4. Point the notifier at it: `NNS_NOTIFY_SMTP_HOST=mailer`,
   `NNS_NOTIFY_SMTP_PORT=587`, `NNS_NOTIFY_SMTP_SECURE=plain`, no user, a
   From on the domain; `docker compose up -d notify`. Send yourself a
   confirmation from the app and check the headers say `dkim=pass` and
   `spf=pass`.

Volume is low, a handful a day, which is what keeps a fresh IP's reputation
a non-issue once the records are right.

## Sign-in conventions

A sign-in is a signature over a challenge the service wrote. The Hub, the
Keyguard and Nimiq Pay (measured on a device, 2026-09-23) all sign the
`nimiq` convention (prefix, length, text, SHA-256), which is the default.
`NNS_NOTIFY_SIGN_CONVENTIONS=nimiq,raw` also accepts a signature over the
bare bytes, for a wallet that does not; the service logs which one every
sign-in satisfied.
