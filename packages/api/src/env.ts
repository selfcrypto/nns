/**
 * Environment → API settings.
 *
 * Deliberately much smaller than the indexer's: this service holds no keys
 * and applies no protocol rules, so the only §3 material it needs is what
 * shapes *answers* — `RESERVED_NAMES` for `/available`, and the `O` listing
 * fee for `/params`. The four OPEN addresses are absent on purpose; an unused
 * required variable is a variable someone fills with a placeholder.
 *
 * `NNS_RESERVED_NAMES` must match the indexer's value. The API cannot derive
 * the list from the database — the `unreserved` table records releases, not
 * the list they were released from — so a drift here makes `/available` lie
 * about reserved names while everything else stays green.
 */

import { isLogLevel, type LogLevel } from '@nns/indexer'

export class EnvError extends Error {
  override readonly name = 'EnvError'
}

export interface ApiSettings {
  readonly databaseUrl: string
  /** TCP bind. Loopback by default; containers set 0.0.0.0 explicitly. */
  readonly host: string
  readonly port: number
  /** §4.1 rule 6, same value the indexer runs with. */
  readonly reservedNames: ReadonlySet<string>
  /** Listing fee for an `O` (§6 `O`, still OPEN) — served by `/params`. */
  readonly listingFee: bigint
  readonly logLevel: LogLevel
}

export type EnvSource = Readonly<Record<string, string | undefined>>

function read(env: EnvSource, key: string): string | undefined {
  const value = env[key]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function required(env: EnvSource, key: string): string {
  const value = read(env, key)
  if (value === undefined) throw new EnvError(`${key} is required — see packages/api/.env.example`)
  return value
}

function integer(env: EnvSource, key: string, fallback: number, min: number, max: number): number {
  const raw = read(env, key)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${key} must be an integer in ${min}..${max}, got ${JSON.stringify(raw)}`)
  }
  return value
}

/** Luna is integer and `bigint`. A decimal point here is a NIM/luna mix-up. */
function luna(env: EnvSource, key: string): bigint {
  const raw = read(env, key)
  if (raw === undefined) return 0n
  if (!/^\d+$/.test(raw)) {
    throw new EnvError(`${key} must be a whole number of luna (1 NIM = 100,000 luna), got ${JSON.stringify(raw)}`)
  }
  return BigInt(raw)
}

/** Comma-separated. §4.1 matches reserved names exactly and never normalises. */
function nameSet(env: EnvSource, key: string): ReadonlySet<string> {
  const raw = read(env, key)
  const names = new Set<string>()
  if (raw === undefined) return names
  for (const entry of raw.split(',')) {
    const name = entry.trim()
    if (name === '') continue
    if (name !== name.toLowerCase()) {
      throw new EnvError(`${key} entry ${JSON.stringify(name)} must be lowercase — §4.1 matches exactly and never normalises`)
    }
    names.add(name)
  }
  return names
}

export function loadSettings(env: EnvSource = process.env): ApiSettings {
  const level = read(env, 'NNS_LOG_LEVEL') ?? 'info'
  if (!isLogLevel(level)) {
    throw new EnvError(`NNS_LOG_LEVEL must be one of debug|info|warn|error, got ${JSON.stringify(level)}`)
  }

  return Object.freeze({
    databaseUrl: required(env, 'NNS_DATABASE_URL'),
    host: read(env, 'NNS_API_HOST') ?? '127.0.0.1',
    port: integer(env, 'NNS_API_PORT', 8635, 1, 65_535),
    reservedNames: nameSet(env, 'NNS_RESERVED_NAMES'),
    listingFee: luna(env, 'NNS_LISTING_FEE'),
    logLevel: level,
  })
}
