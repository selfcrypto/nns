# Put names in your app

Your payee field takes `NQ64 VFXQ TPAS 5Q7S ADEX 072S CR2M QCQ4 8P8M`. It could
take `kike`.

That is the whole offer. Two ways in, both small; the second is the one worth
your time. The deep version of everything here is [`docs/integration.md`](docs/integration.md)
— the HTTP API from any language, verifying proofs without this package,
writing to the registry, running your own resolver.

## 1. Resolve a name — two minutes

No bundler:

```html
<script type="module">
  import { createResolver } from 'https://cdn.jsdelivr.net/npm/@nimiqnames/resolver@0.1.0/dist/nns.js'

  const { address, verification } = await createResolver({}).resolve('kike')
  // address      → 'NQ64 VFXQ …', the address to pay
  // verification → 'PROVEN'
</script>
```

With one:

```sh
npm install @nimiqnames/resolver
```

`createResolver({})` needs no configuration. The shipped list carries two
independent public resolvers and the default quorum is 2, so both are asked and
both must agree before you get an address. 68 kB, 24 kB over the wire, no Node
builtins, no telemetry, MIT.

**Render `verification`, don't drop it.** `PROVEN` means the answer arrived with
a Merkle proof against a published checkpoint root and this package rebuilt the
leaf itself — an operator's word is not what you are paying. `DELEGATED` means a
subdomain, answered by its parent's own host and proven only as far as the dot
(§2). `result.warnings` is a list of things your user should be told; it is
empty on the ordinary path.

The registry has no smart contract. Names live in Nimiq transaction data and
independent operators replay the chain into a `name → address` table. You can
replay it yourself and derive the same root.

## 2. Give every one of your users a name — free

This is the part most apps want and most apps miss.

You register **one** name. You point a `D` message at a host you already run and
serve a JSON file of `label → address`. Every NNS client that resolves
`alice.yourapp` asks your host, and your users have names.

```
GET https://<your host>/yourapp/alice
{"address":"NQ12 3456 …","ttl":300}
```

No per-user registration. No per-user fee. No on-chain state per user. The
registry stores nothing about your subdomains and charges nothing for them —
you already control the addresses you are naming, and making the registry
ratify them would buy nothing and cost a fee, a growing log, and a Merkle tree
that no longer fits in a phone.

The honest boundary: **nothing your host says is proven.** NNS proves that
`yourapp` is yours and that you designated that host. The address behind the
dot is your word. Clients are required to show the difference — this package
marks every such answer `DELEGATED` and attaches a `DELEGATED_ANSWER` warning —
so your users are never told an unverified address is verified. Your host's
security is your subdomains' security.

[`packages/delegate`](packages/delegate) is a reference implementation you can
run as-is, or reimplement in twenty lines in whatever you already have. One file
serves every name you own; the parent is in the request path, so you do not need
a container, a port or a proxy route per name.

## What it costs you

Reading the registry is free and always will be — no key, no account, no rate
limit worth mentioning, CORS open to any origin.

A name costs a yearly fee that depends on its length. Registering is a plain
Nimiq transaction; nothing about it runs through us.

## Links

- Resolver reference — [`packages/resolver/README.md`](packages/resolver/README.md)
- Full integration guide — [`docs/integration.md`](docs/integration.md)
- Live API and its OpenAPI contract — <https://nimiqnames.com/api/openapi.yaml>
- Protocol spec — [`docs/nns-spec-v1.md`](docs/nns-spec-v1.md)

Questions, or something in here that does not work on the first try: open an
issue. A broken first-run is the bug I most want to hear about.
