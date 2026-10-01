import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { RULES_VERSION } from './rules-version.js'

/**
 * The vectors a rule change moves: verdicts and state, the canonical order,
 * name validity and the wire format. `merkle.json` is left out on purpose —
 * the commitment's shape is `COMMITMENT_LAYOUT`'s to refuse on.
 */
const VECTORS = ['reduce.json', 'ordering.json', 'names.json', 'codec.json'] as const

const digest = (): string => {
  const hash = createHash('sha256')
  for (const file of VECTORS) hash.update(readFileSync(new URL(`../vectors/${file}`, import.meta.url)))
  return hash.digest('hex')
}

/**
 * The pair. They move together or the digest moves alone, never the version
 * alone.
 *
 * When this fails, the vectors changed. Ask one question: **does any vector
 * that existed before now expect something else** — a verdict, a state, an
 * order, a parse?
 *
 * - Yes: a replay of an existing log can come out differently. Bump
 *   `RULES_VERSION` and set `PINNED.version` to match, then update the digest.
 *   The indexer will refuse to resume a database built under the old value.
 * - No (vectors were added, or only a note was reworded): update the digest
 *   and leave the version.
 */
const PINNED = {
  version: 1,
  digest: 'e8bda5b25192057faad8f1071f91a4c42e001aee65f3a3b178d62dba21308fc7',
} as const

describe('RULES_VERSION', () => {
  it('is the version the vectors were last looked at under', () => {
    expect(RULES_VERSION).toBe(PINNED.version)
  })

  it('has been reconsidered since the conformance vectors last changed', () => {
    expect(
      digest(),
      'the vectors changed: bump RULES_VERSION if an existing vector expects something new, then update PINNED (see the comment above it)',
    ).toBe(PINNED.digest)
  })
})
