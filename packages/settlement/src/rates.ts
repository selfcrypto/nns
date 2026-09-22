/**
 * The committed §10.7 rate table, read from a file — the half of
 * `rate-table.ts` that needs `node:fs`. `env.ts` reads it once at startup;
 * everything pure (types, parser, `rateFor`, `rebateFor`, `shareAmount`)
 * lives in `rate-table.ts` and is re-exported here, so a caller that only
 * needs the rule need not know which file the rule is in.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parseRateTable, RateTableError, type RateTable } from './rate-table.js'

export * from './rate-table.js'

/** The committed table, beside `package.json` — the default when `NNS_REFERRAL_RATES` is unset. */
export const DEFAULT_RATES_PATH: string = fileURLToPath(new URL('../referral-rates.json', import.meta.url))

function readJson(path: string, what: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new RateTableError(`cannot read the ${what} at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new RateTableError(`${path} is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

const ratesOf = (value: unknown, path: string, what: string): unknown[] => {
  const rates = typeof value === 'object' && value !== null ? (value as { rates?: unknown }).rates : undefined
  if (!Array.isArray(rates)) throw new RateTableError(`${path}: the ${what} must be an object with a \`rates\` array`)
  return rates
}

/**
 * The committed table, with the operator's **private partner rows** appended
 * when `partnersPath` names one: a file on the box, `{ "rates": [ … ] }`,
 * holding named rows only. An agreed partner rate is between the partner and
 * the operator: it is on chain for anyone who looks, and stays out of the
 * repository and the docs (Rico, 2026-09-19). The default stays the committed
 * one, so a partner file carrying a `ref: null` row is refused rather than
 * allowed to reprice every referral from a file nobody reviews. The merged
 * rows go through the one parser, so the append-only and duplicate rules hold
 * across both files.
 */
export function readRateTable(path: string = DEFAULT_RATES_PATH, partnersPath: string | null = null): RateTable {
  const committed = readJson(path, 'rate table')
  if (partnersPath === null) return parseRateTable(committed)
  const partners = ratesOf(readJson(partnersPath, 'partner rate file'), partnersPath, 'partner rate file')
  partners.forEach((row, index) => {
    const ref = typeof row === 'object' && row !== null ? (row as { ref?: unknown }).ref : undefined
    if (typeof ref !== 'string') {
      throw new RateTableError(`${partnersPath}: rates[${index}] has no ref — the partner file holds named rows only, the default is the committed table's`)
    }
  })
  return parseRateTable({ rates: [...ratesOf(committed, path, 'rate table'), ...partners] })
}
