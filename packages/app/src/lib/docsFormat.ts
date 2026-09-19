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
// `group` was written here and now lives in `format.ts`: the app's own
// amounts group the same way, and two implementations of a separator is two
// that drift.
import { displayAddress, group } from './format'
import { percentOf, rebatePercent, referralHeadlineBp, referralRateBp } from './referralRates'
import { RENEW_WINDOW } from './states'

export interface DocPage {
  readonly slug: string
  readonly title: string
  /** The `## Section` the page is listed under: the sidebar's grouping. */
  readonly section: string
}

/**
 * `index.md`'s list, in order: a `## Section` heading opens a section and
 * each `- slug: Title` under it is a page. The sidebar is that structure,
 * and prev/next is the flat order, so the file is the single place a page is
 * added, renamed or moved. A page listed before any section is an error: the
 * sidebar has nowhere to put it.
 */
export function parseDocIndex(markdown: string): readonly DocPage[] {
  const pages: DocPage[] = []
  let section: string | null = null
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(\S.*)$/.exec(line.trim())
    if (heading !== null) {
      section = (heading[1] ?? '').trim()
      continue
    }
    const item = /^-\s+(.*)$/.exec(line.trim())
    if (item === null) continue
    const entry = /^([a-z0-9-]+):\s+(\S.*)$/.exec(item[1] ?? '')
    if (entry === null) throw new Error(`docs/index.md: not a "slug: Title" entry: ${line.trim()}`)
    if (section === null) throw new Error(`docs/index.md: "${entry[1]}" is listed before any "## Section" heading`)
    pages.push({ slug: entry[1] ?? '', title: (entry[2] ?? '').trim(), section })
  }
  if (pages.length === 0) throw new Error('docs/index.md lists no pages')
  return pages
}

/**
 * The sidebar's grouping of the flat list: sections in first-seen order, each
 * with its pages in file order.
 */
export function groupDocPages<T extends DocPage>(pages: readonly T[]): readonly { readonly title: string; readonly pages: readonly T[] }[] {
  const out: { title: string; pages: T[] }[] = []
  for (const page of pages) {
    const last = out[out.length - 1]
    if (last !== undefined && last.title === page.section) last.pages.push(page)
    else out.push({ title: page.section, pages: [page] })
  }
  return out
}

/**
 * A heading's anchor: the text lowercased, anything that is not a letter or a
 * digit collapsed to one hyphen. `#/docs/prices/expiry-and-grace` is the
 * route to a subsection, so the id has to be stable across rebuilds and
 * legible in a link, which a hash of the text would not be.
 */
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\x60*_]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

/** Thousands separators, without asking the platform for a locale. */
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

/** The rate a referrer with no row of their own earns, today — the headline, as published. */
export function defaultReferralRate(): string {
  const bp = referralHeadlineBp('', Number.MAX_SAFE_INTEGER)
  if (bp === null) throw new Error('referral-rates.json has no default row')
  return percentOf(bp)
}

/** What the default rate actually sends, as a share of the fee: the headline with the burn taken out. */
export function defaultReferralPaid(): string {
  const bp = referralRateBp('', Number.MAX_SAFE_INTEGER)
  if (bp === null) throw new Error('referral-rates.json has no default row')
  return percentOf(Number(bp))
}

/** What a referred buyer with no special row gets back, today. `null` where the row in effect pays no rebate. */
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
      // The one derived duration: the renewal reminder's window is the app's
      // own rule (`states.ts`), not a §3 constant, and typing it left "60
      // days" in three pages that a compressed era renders false.
      if (key === 'RENEW_WINDOW') return durationFromBlocks(RENEW_WINDOW)
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
      if (key === 'default') return defaultReferralRate()
      if (key === 'paid') return defaultReferralPaid()
      if (key === 'rebate') {
        const rebate = defaultReferralRebate()
        if (rebate === null) throw new Error(`${placeholder}: the default row pays no rebate`)
        return rebate
      }
      throw new Error(`${placeholder}: the referral placeholders are {{referral:default}}, {{referral:paid}} and {{referral:rebate}}`)
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
