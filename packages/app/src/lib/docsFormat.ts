/**
 * The docs section's build step, minus the file system.
 *
 * `packages/app/docs/*.md` is content only: every protocol figure in it is a
 * `{{format:KEY}}` placeholder, filled here from `@nimiqnames/core`'s `CONSTANTS` so
 * the second launch freeze cannot leave a stale number in a sentence. The
 * contract is `packages/app/docs/README.md`'s table, and this module is its
 * one implementation.
 *
 * Pure, and separate from the Vite plugin that reads the directory and runs
 * `marked`, for the reason `lib/payRequest.ts` gives: this is parsing and
 * formatting, the package's Vitest environment is `node`, and parsing belongs
 * where it can be tested.
 *
 * **An unknown key or format throws**, and the build fails with it. A
 * placeholder that silently rendered as itself would ship `{{nim:FEE_BASE}}`
 * to a reader, and a renamed constant is exactly the case this whole
 * mechanism exists to catch.
 */

import { CONSTANTS, feeFor, LAUNCH_PRICES, LUNA_PER_NIM } from '@nimiqnames/core'

import { displayAddress } from './format'
import { headlineBp, percentOf, rebatePercent, REFERRAL_RATES, referralHeadlineBp } from './referralRates'

export interface DocPage {
  readonly slug: string
  readonly title: string
}

/**
 * `index.md`'s list, in order: one `- slug: Title` per page. The sidebar is
 * that order, and prev/next is that order — so the file is the single place a
 * page is added, renamed or moved.
 */
export function parseDocIndex(markdown: string): readonly DocPage[] {
  const pages: DocPage[] = []
  for (const line of markdown.split('\n')) {
    const item = /^-\s+(.*)$/.exec(line.trim())
    if (item === null) continue
    const entry = /^([a-z0-9-]+):\s+(\S.*)$/.exec(item[1] ?? '')
    if (entry === null) throw new Error(`docs/index.md: not a "slug: Title" entry — ${line.trim()}`)
    pages.push({ slug: entry[1] ?? '', title: (entry[2] ?? '').trim() })
  }
  if (pages.length === 0) throw new Error('docs/index.md lists no pages')
  return pages
}

/** Thousands separators, without asking the platform for a locale. */
function group(value: bigint | number): string {
  const digits = (typeof value === 'bigint' ? value : Math.trunc(value)).toString()
  const sign = digits.startsWith('-') ? '-' : ''
  const body = sign === '' ? digits : digits.slice(1)
  return sign + body.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Integer luna → `400 NIM`, grouped, fractions kept (`REFUND_FLOOR` has been one). */
export function formatNim(luna: bigint): string {
  const whole = luna / LUNA_PER_NIM
  const frac = luna % LUNA_PER_NIM
  const fraction = frac === 0n ? '' : `.${frac.toString().padStart(5, '0').replace(/0+$/, '')}`
  return `${group(whole)}${fraction} NIM`
}

/** One or two decimals, trailing zeros dropped: `2.4`, `12`, `1.25`. */
function trimmed(value: number): string {
  return (Math.round(value * 100) / 100).toString()
}

const plural = (value: string, unit: string): string => `${value} ${value === '1' ? unit : `${unit}s`}`

/**
 * A block count as prose, at roughly one block a second. No `~` — the pages
 * that want one write it ("every ~{{dur:CHECKPOINT_INTERVAL}}"), and the
 * reference table's own column header says the figures are approximate.
 *
 * The thresholds are `wording.ts`'s `periodApprox`, which the app already
 * shows on screen, so a term reads the same in the docs as on a card.
 */
export function durationFromBlocks(blocks: number): string {
  const days = blocks / 86_400
  if (days >= 364) return plural(trimmed(days / 365), 'year')
  if (days >= 2) return plural(trimmed(days), 'day')
  const hours = blocks / 3_600
  if (hours >= 2) return plural(trimmed(hours), 'hour')
  return plural(trimmed(Math.max(1, Math.round(blocks / 60))), 'minute')
}

/**
 * Seconds as prose. Hours below three days: `ANCHOR_STALENESS_LIMIT_SEC` is
 * 48 hours, and "2 days" is the wrong unit for a staleness budget a reader
 * compares against a cadence measured in hours.
 */
export function durationFromSeconds(seconds: number): string {
  const days = seconds / 86_400
  if (days >= 3) return plural(trimmed(days), 'day')
  const hours = seconds / 3_600
  if (hours >= 1) return plural(trimmed(hours), 'hour')
  return plural(trimmed(Math.max(1, Math.round(seconds / 60))), 'minute')
}

const CONSTANT_VALUES = CONSTANTS as unknown as Readonly<Record<string, unknown>>

function constant(placeholder: string, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(CONSTANT_VALUES, key)) {
    throw new Error(`${placeholder}: no CONSTANTS.${key}`)
  }
  return CONSTANT_VALUES[key]
}

function bigintConstant(placeholder: string, key: string): bigint {
  const value = constant(placeholder, key)
  if (typeof value !== 'bigint') throw new Error(`${placeholder}: CONSTANTS.${key} is not an amount`)
  return value
}

function numberConstant(placeholder: string, key: string): number {
  const value = constant(placeholder, key)
  if (typeof value !== 'number') throw new Error(`${placeholder}: CONSTANTS.${key} is not a number`)
  return value
}

/**
 * The first length that pays `FEE_BASE` alone — the last multiplier row's
 * lower edge, so no page types 12. Derived rather than pinned: the row above
 * moving is exactly the edit that would strand a typed number.
 */
export const LONG_BAND_FROM: number = (() => {
  const rows = CONSTANTS.FEE_MULTIPLIERS
  const previous = rows[rows.length - 2]
  return previous === undefined ? 1 : previous.upTo + 1
})()

/** A name of `length` characters, only ever handed to `feeMultiplier` through `feeFor`. */
const nameOfLength = (length: number): string => 'n'.repeat(length)

function bandLabel(index: number): string {
  const rows = CONSTANTS.FEE_MULTIPLIERS
  const row = rows[index]
  if (row === undefined) throw new Error(`no fee band at index ${index}`)
  const from = index === 0 ? 1 : (rows[index - 1]?.upTo ?? 0) + 1
  return from === row.upTo ? `${from}` : `${from}–${row.upTo}`
}

/** `FEE_MULTIPLIERS` in full, with the fees it makes at today's base. */
export function feesTable(): string {
  const rows = CONSTANTS.FEE_MULTIPLIERS.map((row, index) => {
    const fee = feeFor(nameOfLength(row.upTo), LAUNCH_PRICES)
    const lifetime = feeFor(nameOfLength(row.upTo), LAUNCH_PRICES, true)
    return `| ${bandLabel(index)} | ${row.times}× | ${formatNim(fee)} | ${formatNim(lifetime)} |`
  })
  return ['| Name length | Multiple of the base | A year | A lifetime |', '|---|---|---|---|', ...rows].join('\n')
}

/**
 * `packages/settlement/referral-rates.json` as the published table §10.7
 * promises — both payouts, because a reader cannot check a payment they
 * cannot see the rate for. A row that pays no rebate prints an em dash
 * rather than 0%, which is the difference between a policy and a rate.
 *
 * Every rate is the **headline** — 5%, the figure that was published — and a
 * row whose rates are held net of the burn gets a dagger and one footnote.
 * The marker is per row and not a caption over the table, because it is not
 * true of every row: the pre-2026-09-12 default paid its 10% flat, and a
 * blanket sentence would restate history.
 */
export function referralRatesTable(): string {
  let footnoted = false
  const rows = REFERRAL_RATES.rows.map((row) => {
    const ref = row.ref === null ? '*default*' : `\`${row.ref}\``
    const from = row.fromHeight === 0 ? 'launch' : group(row.fromHeight)
    const mark = row.netOfBurn ? ((footnoted = true), '†') : ''
    const share = `${percentOf(headlineBp(row.bp, row))}${mark}`
    const rebate = row.rebateBp === null ? '—' : `${percentOf(headlineBp(row.rebateBp, row))}${mark}`
    return `| ${ref} | ${share} | ${rebate} | ${from} | ${row.note ?? ''} |`
  })
  const table = ['| Referrer | To the referrer | Back to the buyer | From height | Note |', '|---|---|---|---|---|', ...rows].join('\n')
  if (!footnoted) return table
  return `${table}\n\n† Before the registry's burn, which takes ${percentOf(Number(CONSTANTS.BURN_SHARE_BP))} of the payout on its way out.`
}

/** The rate a referrer with no row of their own earns, today — the headline, as published. */
export function defaultReferralRate(): string {
  const bp = referralHeadlineBp('', Number.MAX_SAFE_INTEGER)
  if (bp === null) throw new Error('referral-rates.json has no default row')
  return percentOf(bp)
}

/** What a referred buyer with no special row gets back, today — `null` where the row in effect pays no rebate. */
export const defaultReferralRebate = (): string | null => rebatePercent('', Number.MAX_SAFE_INTEGER)

function nameLength(placeholder: string, key: string): number {
  const length = Number(key)
  if (!Number.isInteger(length) || length < 1 || length > CONSTANTS.MAX_NAME_LEN) {
    throw new Error(`${placeholder}: not a name length`)
  }
  return length
}

function render(placeholder: string, format: string, key: string): string {
  switch (format) {
    case 'n': {
      if (key === 'LONG_BAND_FROM') return group(LONG_BAND_FROM)
      const value = constant(placeholder, key)
      if (typeof value !== 'number' && typeof value !== 'bigint') {
        throw new Error(`${placeholder}: CONSTANTS.${key} is not a number`)
      }
      return group(value)
    }
    case 'nim':
      return formatNim(bigintConstant(placeholder, key))
    case 'pct':
      return percentOf(Number(bigintConstant(placeholder, key)))
    case 'dur':
      return durationFromBlocks(numberConstant(placeholder, key))
    case 'sec':
      return durationFromSeconds(numberConstant(placeholder, key))
    case 'blocks':
      return `${group(numberConstant(placeholder, key))} blocks`
    case 'height':
      return group(numberConstant(placeholder, key))
    case 'addr': {
      const value = constant(placeholder, key)
      if (typeof value !== 'string') throw new Error(`${placeholder}: CONSTANTS.${key} is not an address`)
      return displayAddress(value)
    }
    case 'fee':
      return formatNim(feeFor(nameOfLength(nameLength(placeholder, key)), LAUNCH_PRICES))
    case 'lifetime':
      return formatNim(feeFor(nameOfLength(nameLength(placeholder, key)), LAUNCH_PRICES, true))
    case 'fees':
      if (key === 'table') return feesTable()
      throw new Error(`${placeholder}: the only fees placeholder is {{fees:table}}`)
    case 'referral':
      if (key === 'rates') return referralRatesTable()
      if (key === 'default') return defaultReferralRate()
      if (key === 'rebate') {
        const rebate = defaultReferralRebate()
        if (rebate === null) throw new Error(`${placeholder}: the default row pays no rebate`)
        return rebate
      }
      throw new Error(`${placeholder}: the referral placeholders are {{referral:rates}}, {{referral:default}} and {{referral:rebate}}`)
    default:
      throw new Error(`${placeholder}: unknown format "${format}"`)
  }
}

const PLACEHOLDER = /\{\{([A-Za-z]+):([A-Za-z0-9_-]+)\}\}/g

/** Every `{{format:KEY}}` filled, or a throw naming the one that could not be. */
export function fillPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER, (placeholder, format: string, key: string) =>
    render(placeholder, format, key),
  )
}
