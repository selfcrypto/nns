/**
 * `reconcile` and `watch` must keep starting on a box with no database.
 *
 * That is the oldest rule in this package — the reconciler was built first so
 * that "computed by code that never reads this service's own database" could
 * not decay — and until the ledger existed it was true because there was no
 * database code to reach. Now there is, so the property needs a test rather
 * than an absence.
 *
 * The walk is over the transitive *runtime* import graph of each entry point.
 * A `type` import is erased and cannot open a connection, so it is excluded;
 * anything else that reaches `db.ts`, `ledger.ts` or `pg` fails here.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** `import … from 'x'` and `export … from 'x'`, minus the type-only forms. */
const EDGE = /^\s*(?:import|export)(?!\s+type\b)([\s\S]*?)from\s+'([^']+)'/gm

function reachable(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(resolve(HERE, file), 'utf8')
    for (const match of source.matchAll(EDGE)) {
      const clause = match[1] ?? ''
      const specifier = match[2] ?? ''
      // `import { type A, type B }` — every named binding erased.
      const bindings = clause.match(/\{([\s\S]*)\}/)?.[1]
      if (bindings !== undefined && bindings.trim() !== '' && bindings.split(',').every((name) => /^\s*type\s/.test(name))) {
        continue
      }
      if (specifier.startsWith('.')) queue.push(specifier.replace(/\.js$/, '.ts'))
      else seen.add(specifier)
    }
  }
  return seen
}

describe('the import graph', () => {
  for (const entry of ['./reconcile-main.ts', './watch-main.ts']) {
    it(`${entry} reaches no database`, () => {
      const graph = reachable(entry)
      expect([...graph].filter((file) => /db\.ts|ledger\.ts|^pg$|@nns\/indexer/.test(file))).toEqual([])
    })
  }

  // The other half: the ledger is allowed one, and losing that edge would mean
  // the guard above had been satisfied by deleting the wrong thing.
  it('ledger-main.ts reaches the database', () => {
    const graph = reachable('./ledger-main.ts')
    expect(graph).toContain('./db.ts')
    expect(graph).toContain('./ledger.ts')
  })
})
