import { describe, expect, it } from 'vitest'

import { CONSTANTS } from '@nimiqnames/core'

import {
  defaultReferralRate,
  defaultReferralRebate,
  durationFromBlocks,
  durationFromSeconds,
  feesTable,
  fillPlaceholders,
  formatNim,
  groupDocPages,
  headingId,
  LONG_BAND_FROM,
  parseDocIndex,
} from './docsFormat'
import { headlineBp, REFERRAL_RATES } from './referralRates'

describe('parseDocIndex', () => {
  it('keeps the file order, which is the prev/next chain, and the section each page sits under', () => {
    const index = parseDocIndex(
      '# Documentation\n\nThe sidebar.\n\n## Introduction\n- intro: What NNS is\n\n## Names\n- prices: Prices, terms and expiry\n',
    )
    expect(index).toEqual([
      { slug: 'intro', title: 'What NNS is', section: 'Introduction' },
      { slug: 'prices', title: 'Prices, terms and expiry', section: 'Names' },
    ])
  })

  it('refuses an entry that is not "slug: Title"', () => {
    expect(() => parseDocIndex('## A\n- intro — What NNS is\n')).toThrow(/slug: Title/)
  })

  it('refuses a page listed before any section, which the sidebar has nowhere to put', () => {
    expect(() => parseDocIndex('- intro: What NNS is\n')).toThrow(/before any "## Section"/)
  })

  it('refuses an index with no pages, which would render an empty section', () => {
    expect(() => parseDocIndex('# Documentation\n## A\n')).toThrow(/no pages/)
  })
})

describe('groupDocPages', () => {
  it('groups consecutive pages by section, in first-seen order', () => {
    const pages = [
      { slug: 'a', title: 'A', section: 'One' },
      { slug: 'b', title: 'B', section: 'One' },
      { slug: 'c', title: 'C', section: 'Two' },
    ]
    expect(groupDocPages(pages)).toEqual([
      { title: 'One', pages: [pages[0], pages[1]] },
      { title: 'Two', pages: [pages[2]] },
    ])
  })
})

describe('headingId', () => {
  it('is the heading text as a route segment', () => {
    expect(headingId('Expiry and grace')).toBe('expiry-and-grace')
    expect(headingId('"It never confirmed"')).toBe('it-never-confirmed')
    expect(headingId('What `verification` means')).toBe('what-verification-means')
    expect(headingId('The "?" and the "(i)"')).toBe('the-and-the-i')
  })
})

describe('fillPlaceholders', () => {
  it('fails on an unknown key, because a renamed constant is what this exists to catch', () => {
    expect(() => fillPlaceholders('{{nim:FEE_STANDARD}}')).toThrow(/no CONSTANTS.FEE_STANDARD/)
  })

  it('fails on an unknown format', () => {
    expect(() => fillPlaceholders('{{usd:FEE_BASE}}')).toThrow(/unknown format "usd"/)
  })

  it('fails on a constant of the wrong shape rather than printing it', () => {
    expect(() => fillPlaceholders('{{nim:MAX_NAME_LEN}}')).toThrow(/not an amount/)
    expect(() => fillPlaceholders('{{dur:FEE_BASE}}')).toThrow(/not a number/)
    expect(() => fillPlaceholders('{{addr:LAUNCH_HEIGHT}}')).toThrow(/not an address/)
  })

  it('renders every format the pages use', () => {
    expect(fillPlaceholders('{{nim:FEE_BASE}}')).toBe(formatNim(CONSTANTS.FEE_BASE))
    expect(fillPlaceholders('{{n:MAX_NAME_LEN}}')).toBe('24')
    expect(fillPlaceholders('{{pct:COMMISSION_RATE}}')).toBe('2.5%')
    expect(fillPlaceholders('{{pct:BURN_SHARE_BP}}')).toBe('20%')
    expect(fillPlaceholders('{{blocks:TERM_LENGTH}}')).toBe('31,536,000 blocks')
    expect(fillPlaceholders('{{height:LAUNCH_HEIGHT}}')).toMatch(/^\d{1,3}(,\d{3})*$/)
    expect(fillPlaceholders('{{addr:BURN_ADDRESS}}')).toBe(CONSTANTS.BURN_ADDRESS)
    // The compact form is what `parseAddress` stores; a page shows the spaced one.
    expect(fillPlaceholders('{{addr:TREASURY_ADDRESS}}')).toMatch(/^NQ\d\d( [0-9A-Z]{4}){8}$/)
  })

  it('leaves the rest of the sentence alone', () => {
    expect(fillPlaceholders('a name of {{n:LONG_BAND_FROM}} characters or more')).toBe(
      `a name of ${LONG_BAND_FROM} characters or more`,
    )
  })

  it('derives the renewal reminder window from GRACE_PERIOD, not a typed 60 days', () => {
    // The one placeholder whose key is not a CONSTANTS entry. It was typed as
    // "60 days" in three pages, which a compressed era (GRACE_PERIOD a day)
    // rendered false on the live build.
    expect(fillPlaceholders('{{dur:RENEW_WINDOW}}')).toBe(durationFromBlocks(2 * CONSTANTS.GRACE_PERIOD))
  })

  it('prices a name by its band, from core', () => {
    // 7 and 11 are the same band, and a lifetime is LIFETIME_MULTIPLIER of it.
    expect(fillPlaceholders('{{fee:7}}')).toBe(fillPlaceholders('{{fee:11}}'))
    expect(fillPlaceholders('{{lifetime:12}}')).toBe(formatNim(CONSTANTS.FEE_BASE * CONSTANTS.LIFETIME_MULTIPLIER))
  })

  it('refuses a length no name can have', () => {
    expect(() => fillPlaceholders('{{fee:0}}')).toThrow(/not a name length/)
    expect(() => fillPlaceholders('{{fee:25}}')).toThrow(/not a name length/)
  })

  it('refuses a table placeholder it does not have', () => {
    expect(() => fillPlaceholders('{{fees:bands}}')).toThrow(/{{fees:table}}/)
    expect(() => fillPlaceholders('{{referral:table}}')).toThrow(/{{referral:default}}/)
  })
})

describe('formatNim', () => {
  it('groups thousands and keeps a fraction', () => {
    expect(formatNim(400n * 100_000n)).toBe('400 NIM')
    expect(formatNim(100_000n * 100_000n)).toBe('100,000 NIM')
    // REFUND_FLOOR was 10,000 luna until r29, and a band price under
    // governance can land anywhere: a fraction must never be truncated away.
    expect(formatNim(10_000n)).toBe('0.1 NIM')
    expect(formatNim(1n)).toBe('0.00001 NIM')
  })
})

describe('durations', () => {
  it('reads a term in the unit a reader thinks in', () => {
    expect(durationFromBlocks(CONSTANTS.TERM_LENGTH)).toBe('1 year')
    expect(durationFromBlocks(CONSTANTS.GRACE_PERIOD)).toBe('30 days')
    expect(durationFromBlocks(CONSTANTS.XFER_TIMELOCK)).toBe('12 hours')
    expect(durationFromBlocks(CONSTANTS.AUCTION_EXTENSION)).toBe('10 minutes')
  })

  it('says hours below three days, because a staleness budget is compared against a cadence', () => {
    expect(durationFromSeconds(CONSTANTS.ANCHOR_STALENESS_LIMIT_SEC)).toBe('48 hours')
    expect(durationFromSeconds(3 * 86_400)).toBe('3 days')
    expect(durationFromSeconds(3_600)).toBe('1 hour')
  })
})

describe('the generated tables', () => {
  it('gives every fee band a row, with the band the lengths it covers', () => {
    const table = feesTable()
    expect(table.split('\n')).toHaveLength(CONSTANTS.FEE_MULTIPLIERS.length + 2)
    expect(table).toContain('| 1–2 | 200× |')
    expect(table).toContain(`| ${LONG_BAND_FROM}–${CONSTANTS.MAX_NAME_LEN} | 1× | ${formatNim(CONSTANTS.FEE_BASE)} |`)
  })

  // Agreed partner rates are between the partner and us. The docs state the
  // default and nothing that could print a named row (Kike, 2026-09-19).
  it('has no placeholder that prints the rate table', () => {
    expect(() => fillPlaceholders('{{referral:rates}}')).toThrow(/referral placeholders/)
  })

  // A headline that cannot be turned back into what the payer sends is a
  // wrong number on a page, so every published row must round-trip exactly.
  it('every headline divides back to the rate the payer holds', () => {
    for (const row of REFERRAL_RATES.rows) {
      const burn = Number(CONSTANTS.BURN_SHARE_BP)
      const back = row.netOfBurn ? (headlineBp(row.bp, row) * (10_000 - burn)) / 10_000 : headlineBp(row.bp, row)
      expect(back).toBe(Number(row.bp))
    }
  })

  it('{{referral:paid}} is the default headline with the burn taken out', () => {
    expect(fillPlaceholders('{{referral:default}} {{referral:paid}}')).toBe('5% 4%')
  })

  it('{{referral:rebate}} fills from the same row as {{referral:default}}', () => {
    expect(fillPlaceholders('{{referral:rebate}}')).toBe(defaultReferralRebate())
    expect(() => fillPlaceholders('{{referral:nonsense}}')).toThrow(/referral placeholders/)
  })
})
