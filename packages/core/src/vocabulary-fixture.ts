/**
 * The §7.4 verdict vocabulary, read out of the two files that state it.
 * Excluded from the build (see `tsconfig.json`) — this file must never reach
 * `dist`: it does I/O, and core does not.
 *
 * The reason both sides are *parsed* rather than imported: `ForfeitReason` and
 * `RefundReason` are types, erased before any test runs, so there is nothing to
 * import at runtime. Any test that wants to reason about the token set as data
 * gets it here instead of retyping it — a hand-copied list is exactly the drift
 * §7.4 cannot afford, and `log.test.ts` had already lost `BELOW_MIN_PRICE` from
 * one.
 *
 * Both extractors throw when the shape they expect is missing. A silently empty
 * set would satisfy every check made of it.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const spec = readFileSync(join(here, '../../../docs/nns-spec-v1.md'), 'utf8')
const reduceSource = readFileSync(join(here, 'reduce.ts'), 'utf8')

/**
 * The tokens in the first column of the table introduced by `heading`.
 *
 * §7.4 holds several tables; each is taken as the run of `|` lines that follows
 * its own bold lead-in, so the check-order table's `` `G` `` rows cannot leak
 * into a token set.
 */
export function specTokens(heading: string): string[] {
  const lines = spec.split('\n')
  const start = lines.findIndex((line) => line.startsWith(heading))
  if (start < 0) throw new Error(`spec: no section headed ${heading}`)

  const tokens: string[] = []
  let inTable = false
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('|')) {
      if (inTable) break
      continue
    }
    inTable = true
    const cell = line.split('|')[1]?.trim() ?? ''
    const token = /^`([A-Z_]+)`$/.exec(cell)
    if (token?.[1]) tokens.push(token[1])
  }
  if (tokens.length === 0) throw new Error(`spec: no tokens in the table under ${heading}`)
  return tokens
}

/** The string literals of an `export type X = 'A' | 'B'` union in `reduce.ts`. */
export function unionMembers(name: string): string[] {
  const declaration = new RegExp(`export type ${name} =([\\s\\S]*?)\\n\\n`).exec(reduceSource)
  if (!declaration?.[1]) throw new Error(`reduce.ts: no union declared as ${name}`)

  const members = [...declaration[1].matchAll(/'([A-Z_]+)'/g)].map((match) => match[1] as string)
  if (members.length === 0) throw new Error(`reduce.ts: ${name} declares no members`)
  return members
}
