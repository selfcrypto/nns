import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * The operator's monitor reads these lines out of `docker logs` and alerts on
 * them, or on their absence. It lives outside this repository, so nothing else
 * fails when one is reworded: monitoring goes quiet instead.
 *
 * Changing a line here means changing the monitor in the same sitting.
 */
const MONITORED: ReadonlyArray<readonly [file: string, line: string, role: string]> = [
  ['issue-main.ts', '(next cycle in ', 'the issuer completed a cycle'],
  ['ledger-main.ts', '(next poll in ', 'the ledger completed a cycle'],
  ['watch-main.ts', '(next poll in ', 'the watcher completed a cycle'],
  ['loop.ts', '(retry in ', 'a cycle was skipped on an unanswering source'],
  ['issue.ts', '  FAILED ', 'a leg failed'],
  ['issue.ts', '  UNFUNDED ', 'a sender cannot cover a leg'],
  ['issue.ts', 'ALERT (§11.5)', 'a sender is below its minimum balance'],
]

describe('the log lines the monitor reads', () => {
  it.each(MONITORED)('%s still prints "%s" (%s)', (file, line) => {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    expect(source).toContain(line)
  })
})
