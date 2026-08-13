/**
 * §7.4's verdict vocabulary is **normative and closed**: the token is committed
 * into the log line (§8.2) and therefore into the checkpoint, so two
 * implementations that agree perfectly about which messages are rejected and
 * disagree by one character about what to call a rejection derive different
 * roots. Renaming a token is a consensus change, and this file is what makes it
 * announce itself.
 *
 * The check that produced the r16 table was run by hand once. This is the same
 * check, pinned: the two token sets are extracted from the spec's tables and
 * from `reduce.ts`, and must be equal.
 *
 * The unions are types, erased before any test runs, so the core side is read
 * out of the source text rather than imported. Both extractors fail loudly if
 * the shape they expect is gone — a silently empty set would pass set equality
 * against nothing, which is the failure this file exists to prevent.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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
function specTokens(heading: string): string[] {
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

/** The string literals of a `export type X = 'A' | 'B'` union in `reduce.ts`. */
function unionMembers(name: string): string[] {
  const declaration = new RegExp(`export type ${name} =([\\s\\S]*?)\\n\\n`).exec(reduceSource)
  if (!declaration?.[1]) throw new Error(`reduce.ts: no union declared as ${name}`)

  const members = [...declaration[1].matchAll(/'([A-Z_]+)'/g)].map((match) => match[1] as string)
  if (members.length === 0) throw new Error(`reduce.ts: ${name} declares no members`)
  return members
}

const sorted = (tokens: readonly string[]): string[] => [...tokens].sort()

describe('§7.4 verdict vocabulary — core against the spec', () => {
  it('ForfeitReason is exactly the forfeit token table', () => {
    expect(sorted(unionMembers('ForfeitReason'))).toEqual(sorted(specTokens('**Forfeit tokens.**')))
  })

  it('RefundReason is exactly the refund token table', () => {
    expect(sorted(unionMembers('RefundReason'))).toEqual(sorted(specTokens('**Refund tokens.**')))
  })

  it('declares each token once — a duplicate would hide a rename', () => {
    for (const name of ['ForfeitReason', 'RefundReason']) {
      const members = unionMembers(name)
      expect(sorted(members)).toEqual(sorted([...new Set(members)]))
    }
  })

  it('keeps §7.5 reasons out of the verdict vocabulary', () => {
    // A discarded transaction earns no log line at all (§7.6), so an
    // IgnoredReason must never be able to reach the `<verdict>` field.
    const verdictTokens = new Set([...unionMembers('ForfeitReason'), ...unionMembers('RefundReason'), 'OK'])
    for (const ignored of unionMembers('IgnoredReason')) expect(verdictTokens).not.toContain(ignored)
  })
})
