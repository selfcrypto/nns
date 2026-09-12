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

export function readRateTable(path: string = DEFAULT_RATES_PATH): RateTable {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new RateTableError(`cannot read the rate table at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new RateTableError(`${path} is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  return parseRateTable(parsed)
}
