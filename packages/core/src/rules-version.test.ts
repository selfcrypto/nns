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
  version: 2,
  digest: 'f2d8cd7bd0e01883c22ca66530d2d4f47c4c98c07854619e6f405cef44defab7',
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
