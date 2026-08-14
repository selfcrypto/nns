/**
 * `@nns/anchor` — the NNS anchor contract (§9) and the record of its build.
 *
 * Deliverable 1 of `tasks/05-anchor.md`. The publisher cron and the
 * client-side reader land later, behind their own subpath exports
 * (`@nns/anchor/publisher`, `@nns/anchor/reader`) so that a mini app bundling
 * the reader can never pull in key-handling code.
 *
 * Nothing exported here touches the network, the filesystem or a key. The
 * compiler wrapper is deliberately *not* re-exported: `compile.ts` reads the
 * contract off disk and loads solc, and it is a build-time module.
 */

export { ANCHORED_TOPIC0, ARTIFACT, INIT_CODE_HASH } from './artifact.js'
export type { AbiEntry, AbiParameter, Artifact } from './compile.js'
