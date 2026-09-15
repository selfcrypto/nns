# Subdomains

Register `exchange` once, and hand out `alice.exchange`, `shop.exchange` and `pay.exchange` from a server you run. NNS stores nothing per subdomain and charges nothing for them.

## How a subdomain resolves

`shop.exchange` is a **label** (`shop`) under a **parent** (`exchange`). A client does two things:

1. Resolves `exchange` normally, with a proof. If the parent is not registered, or its owner has not set a subdomain host, the query stops there.
2. Asks the host the owner set: `GET https://<host>/exchange/shop`. The host answers `{"address": "NQ…", "ttl": 300}`.

The parent is in the request, so one server can answer for several names, each with its own labels.

## What is proven, and what is not

NNS proves that `exchange` belongs to its owner and that the owner set **this host**. The address the host returns for `shop` is the owner's word alone: no signature, no proof. So every client shows a subdomain differently from a proven name. The app marks it *Subdomain* and badges it with the host that answered, *Resolved by `names.exchange.example`*, rather than with the name: a name is registrable by anybody, so a familiar word in that badge would read as a promise the answer does not carry.

**Your server's security is your subdomains' security.** A compromised host serves whatever addresses the attacker likes, and NNS will not notice.

## NNS never says whether a subdomain exists

A 404, a timeout, a DNS failure and a malformed reply all reach the client as one thing: the host did not answer. The app keeps the parent verified and says "exchange's host did not answer. Only its owner can say whether the subdomain exists."

## Setting one up

You need the owner key of the name, a server reachable over **publicly trusted HTTPS**, and a JSON file.

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

   Edit the file and it reloads within seconds. A bad entry rejects the whole file and names the key, and the previous file keeps serving.

2. **Put TLS in front of it.** Any terminator works: Caddy, nginx with certbot, a tunnel, a hosting panel. Check from a machine that is not the server:

   ```bash
   curl https://<host>/exchange/shop
   ```

3. **Set the host on the name**, from the **Subdomain Host** tile in My Names. Lowercase, no scheme, up to {{n:MAX_HOST_LEN}} characters, and name and host together within 52 characters. A path is allowed (`example.com/nns`) if the server is mounted under one.

   Do this last. A host set before it answers over HTTPS leaves subdomains off until it does.

4. **Resolve `shop.exchange` in the app** and check the address it shows.

Adding a customer afterwards is an edit to the JSON file.

## What clears it

- **Transferring the name.** The new owner sets their own host.
- **Entering grace.** Renewing restores the name, and the host is set again.
- **Ticking "Remove the current host"** in the Subdomain Host sheet.

## Labels

1 to {{n:MAX_LABEL_LEN}} characters from `a-z 0-9 -`, no hyphen at either end or doubled. No letter required and no digit rule. Only one dot: nested subdomains are not part of this version.

## What the reference host promises

- `GET /<parent>/<label>` answers, under any path prefix it is mounted at.
- Its 404 is the same for an unknown label and for a name it does not serve.
- `/healthz` reports counts, never which names.
- Every answer carries open CORS headers.
- The labels file is the whole product. Keep a copy of it and nothing else.

The container and the TLS recipes are in the repository under `deploy/delegate`.
