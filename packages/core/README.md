# `@nns/core`

The protocol rules of the Nimiq Name Service, as a library: message encoding
and parsing, name validity, the reducer, the §8.1 Merkle tree and the §8.2
canonical log.

**Pure and deterministic.** No network, no filesystem, no clock, no
randomness — because two independent implementations of NNS must derive the
same bytes from the same chain, and anything that could vary is a fork
waiting to happen. It runs unchanged in a browser, in a worker and in Node.

Most integrations do not need this package directly. If you want to resolve a
name, use [`@nns/resolver`](https://www.npmjs.com/package/@nns/resolver),
which uses this one. You want `@nns/core` when you are **building
transactions** — registering, renewing, transferring, pointing a name — or
when you are verifying proofs yourself.

```sh
npm install @nns/core
```

## Building a message

Every builder returns the three transaction fields, so nothing ever
concatenates a payload by hand:

```ts
import { encodeRegister } from '@nns/core'

// The fee is governed, so it is read from a resolver's /params — never
// computed locally and never hard-coded. `mycoolshop` is 10 characters, which
// is the 7–11 band: five times the base price.
const { fees } = await (await fetch('https://api.nimiqnames.com/params')).json()
const band = fees.find((f) => 'mycoolshop'.length <= f.upTo)

const { recipient, value, data } = encodeRegister({
  name: 'mycoolshop',
  fee: BigInt(band.yearly),
})
// → send a basic transaction to `recipient` for `value` luna, with `data`
//   (lowercase hex) as the recipient data. That is the whole of registering
//   a name: no contract call, no approval, no second step.
```

Amounts are **`bigint` luna** (1 NIM = 100,000 luna) everywhere. Never a
float, never a `number`.

## The one thing to know before pinning a version

```ts
import { CONSTANTS } from '@nns/core'
CONSTANTS.SPEC_REVISION  // 29
```

This package's `version` tracks its **API**. `SPEC_REVISION` tracks the
**rules**, and they move independently: a revision can change a reducer rule
or a Merkle layout — moving every root and log hash derived from it — without
changing a single function signature. If you derive anything
consensus-relevant, assert on `SPEC_REVISION` rather than trusting that a
version that still compiles still agrees with the network.

While the major version is `0`, the protocol is a v1 **draft** and rules can
still move.

## Reading further

- [The integration guide](https://github.com/selfcrypto/nns/blob/main/docs/integration.md)
  — resolving, paying, registering, verifying, with runnable examples.
- [`docs/nns-spec-v1.md`](https://github.com/selfcrypto/nns/blob/main/docs/nns-spec-v1.md)
  — the specification these rules implement. It is authoritative; this
  package is not.
- Conformance vectors ship in the tarball under `vectors/`, so another
  implementation can check itself against the same cases this one is tested
  with.

MIT.
