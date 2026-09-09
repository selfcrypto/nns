# Subdomains and delegation

Register `exchange` once, and hand out `alice.exchange`, `shop.exchange`, `pay.exchange` from a server you run. NNS stores nothing per subdomain, charges nothing per subdomain, and knows nothing about them.

## How a subdomain resolves

`shop.exchange` is a **label** under a **parent**. When a client sees the dot, it does two things:

1. Resolves `exchange` normally, with a proof. If the parent is not registered, or its owner has not set a subdomain host, the query fails there.
2. Asks the host the owner designated: `GET https://<host>/exchange/shop`. The host answers `{"address": "NQ…", "ttl": 300}`.

The parent is in the request, so one server can answer for every name that points at it, each with its own set of labels. `shop.a` and `shop.b` are different questions.

## What is proven, and what is not

NNS proves two things: that `exchange` belongs to a particular owner, and that its owner designated **this host**. Both come out of the checkpoint through an ordinary proof.

The address the host returns for `shop` is the owner's word and nothing else's. No signature, no proof, no protocol recourse past the dot. That boundary is deliberate: an exchange already controls the deposit addresses it names, and having the registry ratify each one would cost a fee per subdomain and a log that never stops growing. So every client shows a delegated answer differently from a proven one — the app marks it *Subdomain* and says "The address is `exchange`'s word — no proof covers it."

**The consequence for a host operator: your server's security is your subdomains' security.** A compromised host serves whatever addresses the attacker likes, and no part of NNS will notice. A signed-response format is fixed for a future version that requires it.

## NNS never says whether a subdomain exists

A 404, a timeout, a DNS failure and a wrong-shaped reply all reach the client as one thing: the host did not answer. The client shows the parent still verified and says "`exchange`'s resolver did not answer" — never "`shop.exchange` does not exist", because only the owner can know that, and a server that told callers which labels it serves would be an enumeration surface.

## Setting one up

You need: the owner key of the name, a server reachable over **publicly trusted HTTPS**, and a JSON file.

1. **Run the reference host.** One container, one file, no node, no database, no key. The file is `name → label → address`:

   ```json
   {
     "defaultTtl": 300,
     "names": {
       "exchange": {
         "shop": "NQ34 248H …",
         "pay": { "address": "NQ93 48H2 …", "ttl": 60 }
       },
       "othername": {
         "shop": "NQ60 6CRK …"
       }
     }
   }
   ```

   Edit the file and it reloads within seconds. A bad entry rejects the whole file and names the key, while the previous file keeps serving; nothing goes silently missing.

2. **Put TLS in front of it.** Clients build `https://<host>/…` and nothing else; a host on plain HTTP is a host no client will ever reach. Any terminator works — Caddy, nginx with certbot, a tunnel, a hosting panel. Check from a machine that is not the server: `curl https://<host>/exchange/shop`.

3. **Then set the host on the name**, from My names → Subdomain host. Lowercase, no scheme, up to {{n:MAX_HOST_LEN}} characters, and **name and host together within 52 characters**. A short path is allowed (`example.com/nns`) and says where the server is mounted; it is not how two names share a host, since the parent in the request already does that.

   The order matters: a host set before it answers over HTTPS turns subdomains **off** for the name until it does.

4. **Resolve `shop.exchange` in a client** and check the address it shows.

Adding a customer afterwards is an edit to the JSON file, nothing else.

## What clears it

- **Transferring the name** clears the host; the new owner sets their own.
- **Entering grace** clears it, and subdomains stop answering because the parent no longer resolves. Renewing restores the name; the host is set again.
- **Setting an empty host** switches subdomains off deliberately.

## Labels

1 to {{n:MAX_LABEL_LEN}} characters from `a–z 0–9 -`, no hyphen at either end or doubled. No letter required and no digit rule — labels are not scarce, not sold, and the parent keeps them apart. Only one dot: nested subdomains are not part of this version.

## What the reference host promises

- `GET /<parent>/<label>` answers, under any path prefix it happens to be mounted at.
- Its 404 is the same for an unknown label and for a name it does not serve.
- `/healthz` reports counts, never which names.
- Every answer carries open CORS headers, because clients are browsers.
- The labels file is the whole product. There is nothing to back up except a copy of it, and a lost host is a `docker compose up` and a JSON file from being back.

Details of the container and the TLS recipes are in the repository under `deploy/delegate`.
