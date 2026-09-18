/**
 * Compile `reserved-names/*.json` into `src/reserved-names.ts`.
 *
 *   node scripts/gen-reserved-names.ts           (or: pnpm gen:reserved)
 *
 * The category files are the authoring format — one per category, each
 * naming its tier and its source, so a reviewer reads a list of ten thousand
 * names as thirty lists with a reason each. The generated module is what
 * ships, and it is committed: **nothing reads the JSON at runtime.** A list
 * read from disk is a list two operators can hold different copies of, and
 * §4.1 rule 6 is a consensus input — a divergence there is not detectable at
 * startup and first appears as a `QUORUM_ROOT_MISMATCH` in somebody's client.
 *
 * Categories are policy, not protocol: the constant is the flat union of every
 * file's `names` and `speculative`, sorted and deduplicated, so a name may sit
 * in two categories and moving it between them is not a change.
 *
 * `reserved-names.test.ts` regenerates in memory and compares, so a JSON edit
 * that was never compiled is a red run rather than a silent no-op.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SOURCE = join(packageRoot, 'reserved-names')
export const TARGET = join(packageRoot, 'src', 'reserved-names.ts')

export const TIERS = ['HOLD', 'AWARD', 'AUCTION'] as const

/**
 * One category file. `speculative` holds entries reserved on a doubt — the
 * first candidates for a `U` when someone asks — and is reserved exactly like
 * `names`.
 */
export interface Category {
  tier: (typeof TIERS)[number]
  title: string
  source: string
  names: string[]
  speculative?: string[]
}

export function parseCategory(file: string, json: string): Category {
  const c = JSON.parse(json) as Partial<Category>
  if (!TIERS.includes(c.tier as Category['tier'])) throw new Error(`${file}: "tier" must be one of ${TIERS.join(', ')}`)
  if (typeof c.title !== 'string' || typeof c.source !== 'string') throw new Error(`${file}: "title" and "source" are required`)
  for (const key of ['names', 'speculative'] as const) {
    const list: unknown = c[key]
    if (list === undefined && key === 'speculative') continue
    if (!Array.isArray(list) || !list.every((n) => typeof n === 'string')) throw new Error(`${file}: "${key}" must be an array of strings`)
  }
  return c as Category
}

/** Every category file, keyed by its stem. */
export function readCategories(dir: string = SOURCE): Map<string, Category> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  return new Map(files.map((f) => [f.slice(0, -'.json'.length), parseCategory(f, readFileSync(join(dir, f), 'utf8'))]))
}

/** The names, deduplicated and sorted. Sorting here is why file order is not a diff. */
export function flatten(categories: Iterable<Category>): string[] {
  const names = new Set<string>()
  for (const c of categories) for (const n of [...c.names, ...(c.speculative ?? [])]) names.add(n)
  return [...names].sort()
}

export const readNames = (dir: string = SOURCE): string[] => flatten(readCategories(dir).values())

export function render(names: readonly string[] = readNames()): string {
  const entries = names.map((name) => `  '${name}',\n`).join('')
  return `// Generated from reserved-names/*.json by scripts/gen-reserved-names.ts.
// Do not edit by hand — edit the category files and regenerate.
// packages/core/CLAUDE.md says how to change it.

/**
 * §4.1 rule 6, the **published half** of \`RESERVED_NAMES\`. Frozen: a consensus
 * input, not a setting — two indexers holding different lists derive different
 * roots and neither is detectably wrong at startup.
 *
 * 1–4 character names are the other half and appear here nowhere: since r18
 * they are members *by rule* (\`isShortReserved\`), never materialised.
 * Sorted for review only; this is a set, pinned order-insensitively.
 *
 * Under-reserving is **permanent** — a name left off is anyone's the block
 * after \`LAUNCH_HEIGHT\` — and over-reserving is **reversible** with one \`U\`.
 * Adding an entry is out of governance scope (§10.6), so it is free only until
 * \`LAUNCH_HEIGHT\`; after it, an addition is a spec revision.
 *
 * Not a \`CONSTANTS\` member, so a bundle that never calls \`isReservedName\`
 * drops it. Typed \`readonly string[]\`, not a literal tuple: at this size a
 * tuple type is twenty thousand members in every consumer's \`.d.ts\`.
 */
export const RESERVED_NAMES: readonly string[] = /* @__PURE__ */ Object.freeze([
${entries}])
`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = readNames()
  writeFileSync(TARGET, render(names))
  process.stdout.write(`${TARGET}: ${names.length} names\n`)
}
