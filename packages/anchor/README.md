# `@nns/anchor`

The §9 anchoring half of the Nimiq Name Service: the append-only EVM contract
NNS checkpoints are published to, the committed record of its compilation, and
the **reader** a client uses to check that what a resolver served is what was
anchored.

Anchoring exists because a resolver's own proofs are internally consistent
whether or not it is honest. A checkpoint commitment posted to an unrelated
chain by several publishers is a statement no NNS operator can quietly revise.

```sh
npm install @nns/anchor
```

## The part most people want: the reader

```ts
import { checkAnchors, createAnchorReadRpc } from '@nns/anchor/reader'

const check = await checkAnchors(
  [createAnchorReadRpc('https://rpc-a.example'), createAnchorReadRpc('https://rpc-b.example')],
  { contractAddress: '0x…', height: 61_460_340, publishers: ['0x…', '0x…'] },
)
check.status // 'verified' | 'quorum-not-met' | 'divergence' | 'rpc-disagreement' | 'unavailable' | 'not-checked'
```

**Two endpoints is a refusal, not a recommendation.** A single RPC endpoint
can serve a false anchor and no cross-check catches it, so the reader requires
at least two independent ones.

`@nns/resolver` wires this for you, including the step that actually makes it
mean something — tying the anchored commitment to the checkpoint the proof
verified against. Unless you are building your own client, use it from there
rather than calling this directly.

The reader is browser-safe, and that is enforced rather than asserted: a test
in this package walks the import graph from every export subpath and fails on
a Node built-in or a heavy dependency reaching the bundle.

## The publisher and the contract

`contracts/` ships the Solidity source and `ARTIFACT` the compiled bytecode
with its hash, so anyone can reproduce the deployment rather than trust an
address. Deploying and publishing are done with the CLIs in this package's
`dist/`, which are **repo tooling, not exported entry points** — they need
`viem`, which is a devDependency here for that reason. Installing this package
does not install it, and no module you can `import` from the three export
subpaths reaches it.

Running a publisher is `deploy/anchor` in the repository, not an npm install:
it needs a funded EVM key and two independent IPFS implementations that must
mint the same CID before anything is broadcast.

## Reading further

- [The integration guide](https://github.com/selfcrypto/nns/blob/main/docs/integration.md)
  — §8 covers names on EVM chains, including verifying an NNS proof in
  Solidity.
- [`docs/nns-spec-v1.md`](https://github.com/selfcrypto/nns/blob/main/docs/nns-spec-v1.md)
  §9 is what this implements.

MIT.
