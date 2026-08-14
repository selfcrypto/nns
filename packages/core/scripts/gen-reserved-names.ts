/**
 * Compile `reserved-names.json` into `src/reserved-names.ts`.
 *
 *   npx tsx scripts/gen-reserved-names.ts        (or: pnpm gen:reserved)
 *
 * The JSON is the authoring format — a clean diff for a reviewer who does not
 * read TypeScript. The generated module is what ships, and it is committed:
 * **nothing reads the JSON at runtime.** A list read from disk is a list two
 * operators can hold different copies of, and §4.1 rule 6 is a consensus
 * input — a divergence there is not detectable at startup and first appears as
 * a `QUORUM_ROOT_MISMATCH` in somebody's client.
 *
 * `reserved-names.test.ts` regenerates in memory and compares, so a JSON edit
 * that was never compiled is a red run rather than a silent no-op.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SOURCE = join(packageRoot, 'reserved-names.json')
export const TARGET = join(packageRoot, 'src', 'reserved-names.ts')

/** The names, sorted. Sorting here is why a resorted JSON is not a diff. */
export function readNames(json: string = readFileSync(SOURCE, 'utf8')): string[] {
  const names: unknown = (JSON.parse(json) as { names?: unknown }).names
  if (!Array.isArray(names)) throw new Error('reserved-names.json: "names" must be an array')
  return [...(names as string[])].sort()
}

export function render(names: readonly string[] = readNames()): string {
  const entries = names.map((name) => `  '${name}',\n`).join('')
  return `// Generated from reserved-names.json by scripts/gen-reserved-names.ts.
// Do not edit by hand — edit the JSON and regenerate. See constants.ts for what
// this list is and how to change it.

/** §4.1 rule 6, the published half. Frozen: a consensus input, not a setting. */
export const RESERVED_NAMES = Object.freeze([
${entries}] as const)
`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = readNames()
  writeFileSync(TARGET, render(names))
  process.stdout.write(`${TARGET}: ${names.length} names\n`)
}
