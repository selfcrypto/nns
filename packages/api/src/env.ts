/**
 * Environment → API settings.
 *
 * Deliberately much smaller than the indexer's: this service holds no keys and
 * applies no protocol rules, and since the launch freeze it needs **no §3
 * material at all**. `RESERVED_NAMES` (for `/available`) and the `O` listing
 * fee (for `/params`) are `CONSTANTS`, read straight from `core` — which also
 * ends the standing trap that `NNS_RESERVED_NAMES` had to equal the indexer's
 * value, since a drift there made `/available` lie about reserved names while
 * everything else stayed green. The four OPEN addresses are absent on purpose;
 * an unused required variable is a variable someone fills with a placeholder.
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

export function loadSettings(env: EnvSource = process.env): ApiSettings {
  const level = read(env, 'NNS_LOG_LEVEL') ?? 'info'
  if (!isLogLevel(level)) {
    throw new EnvError(`NNS_LOG_LEVEL must be one of debug|info|warn|error, got ${JSON.stringify(level)}`)
  }

  return Object.freeze({
    databaseUrl: required(env, 'NNS_DATABASE_URL'),
    host: read(env, 'NNS_API_HOST') ?? '127.0.0.1',
    port: integer(env, 'NNS_API_PORT', 8635, 1, 65_535),
    logLevel: level,
  })
}
