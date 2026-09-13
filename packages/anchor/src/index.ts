/**
 * `@nimiqnames/anchor` — the NNS anchor contract (§9) and the record of its build.
 *
 * The publisher lives behind
 * `@nimiqnames/anchor/publisher` and the client-side reader behind
 * `@nimiqnames/anchor/reader` — kept off this root so that a mini app bundling
 * the reader can never pull in key-handling code, a property
 * `browser-safety.test.ts` enforces over the import graph.
 *
 * Nothing exported here touches the network, the filesystem or a key. The
 * compiler wrapper is deliberately *not* re-exported: `compile.ts` reads the
 * contract off disk and loads solc, and it is a build-time module.
 */

export { ANCHORED_TOPIC0, ARTIFACT, INIT_CODE_HASH } from './artifact.js'
export type { AbiEntry, AbiParameter, Artifact } from './compile.js'
