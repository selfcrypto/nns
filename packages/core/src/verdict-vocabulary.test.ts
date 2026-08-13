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
 * from `reduce.ts` — by `vocabulary-fixture.ts`, which explains why both sides
 * are read as text — and must be equal.
 */

import { describe, expect, it } from 'vitest'
import { specTokens, unionMembers } from './vocabulary-fixture.js'

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
