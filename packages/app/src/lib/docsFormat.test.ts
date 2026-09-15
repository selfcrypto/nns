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
  referralRatesTable,
} from './docsFormat'
import { headlineBp, percentOf, REFERRAL_RATES } from './referralRates'

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
    expect(() => fillPlaceholders('{{referral:table}}')).toThrow(/{{referral:rates}}/)
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
    expect(durationFromBlocks(CONSTANTS.OFFER_IRREVOCABLE)).toBe('2.4 hours')
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

  it('publishes the rate table settlement pays from, defaults named as such', () => {
    const table = referralRatesTable()
    expect(table).toContain('| *default* |')
    expect(table).toContain('| launch |')
    expect(table).toContain(defaultReferralRate())
  })

  // Both payouts, or a reader cannot check a payment they hold no rate for.
  // A row that pays no rebate prints "none", not a blank: "the policy did not
  // exist then" and "the policy pays zero" are different claims, and an empty
  // cell reads as neither. It was an em dash until the 2026-09-14 wording pass
  // took the character out of everything a reader sees.
  it('gives the rate table a column for the buyer’s rebate, and says none where a row pays none', () => {
    const table = referralRatesTable()
    expect(table).toContain('| Referrer | To the referrer | Back to the buyer | From height | Note |')
    const rebate = defaultReferralRebate()
    expect(rebate).not.toBeNull()
    expect(table).toContain(`| ${rebate}† |`)
    expect(table).toContain('| none |')
    // The `note` column is the JSON's prose, printed straight onto the page,
    // so the pages' em-dash rule (docsPages.test.ts) has to reach it there.
    expect(table).not.toContain('—')
    // Every row renders; the header, the separator, the blank line and the
    // footnote are the extra four.
    expect(table.split('\n')).toHaveLength(REFERRAL_RATES.rows.length + 4)
  })

  // The published rates are the ones Kike decided — 5% and 5% — and the table
  // settlement pays from holds those net of the §10.2 burn. The docs state
  // the headline and mark it, per row: a blanket caption would restate the
  // pre-2026-09-12 default, which paid its 10% flat and carried no burn.
  it('states the headline rate and daggers the rows the burn comes out of', () => {
    const table = referralRatesTable()
    const net = REFERRAL_RATES.rows.filter((row) => row.netOfBurn)
    expect(net.length).toBeGreaterThan(0)
    for (const row of net) {
      expect(headlineBp(row.bp, row)).toBe(Math.round((Number(row.bp) * 10_000) / (10_000 - Number(CONSTANTS.BURN_SHARE_BP))))
      expect(table).toContain(`| ${percentOf(headlineBp(row.bp, row))}† |`)
    }
    for (const row of REFERRAL_RATES.rows.filter((r) => !r.netOfBurn)) {
      expect(headlineBp(row.bp, row)).toBe(Number(row.bp))
      expect(table).toContain(`| ${percentOf(Number(row.bp))} |`)
    }
    expect(table).toContain('† Before the registry')
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

  it('{{referral:rebate}} fills from the same row as {{referral:default}}', () => {
    expect(fillPlaceholders('{{referral:rebate}}')).toBe(defaultReferralRebate())
    expect(() => fillPlaceholders('{{referral:nonsense}}')).toThrow(/referral placeholders/)
  })
})
