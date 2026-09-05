/**
 * Renders an {@link Artifact} as the source of `src/artifact.ts`.
 *
 * Separate from `compile-cli.ts` because the test needs it: "recompile and
 * compare" is only a real check if the comparison is against the same bytes
 * the generator would have written, formatting included. Comparing parsed
 * objects would pass while the committed file was reformatted by hand into
 * something that no longer round-trips.
 *
 * A `.ts` module rather than a `.json` file so it typechecks with the rest of
 * `src`, needs no `resolveJsonModule` or import attributes, and carries `as
 * const` — which is what makes `ANCHORED_TOPIC0` a literal type downstream.
 */

import type { Artifact } from './compile.js'

/** `JSON.stringify` with the repo's 2-space indent, re-indented to fit. */
function embed(value: unknown, indent: number): string {
  return JSON.stringify(value, null, 2).split('\n').join(`\n${' '.repeat(indent)}`)
}

export function renderArtifactModule(artifact: Artifact): string {
  return `/**
 * GENERATED — do not edit by hand.
 *
 * Produced by \`pnpm --filter @nns/anchor compile\` from
 * \`contracts/NnsAnchor.sol\`. Committed on purpose: this is the record of
 * what was compiled and what a deployment must match, and \`artifact.test.ts\`
 * recompiles from source and fails if the two disagree.
 */

import type { Artifact } from './compile.js'

export const ARTIFACT = ${embed(artifact, 0)} as const satisfies Artifact

/** \`keccak256("${artifact.anchoredSignature}")\` — the \`Anchored\` event's topic 0. */
export const ANCHORED_TOPIC0 = ARTIFACT.anchoredTopic0

/**
 * CREATE2 init-code hash — kept for third parties deploying through a
 * factory. This package's own deploy is plain \`CREATE\`
 * (\`docs/decisions.md\`, "CREATE2 dropped with the second chain").
 */
export const INIT_CODE_HASH = ARTIFACT.initCodeHash
`
}
