/**
 * Environment → delegate settings.
 *
 * The smallest configuration in the workspace, and it has no §3 material at
 * all: a delegate applies no protocol rules, holds no keys, reads no chain and
 * has no database. What it needs is a file to serve and a socket to serve it
 * on.
 */

import { isLogLevel, type LogLevel } from './logger.js'
import { DEFAULT_TTL_SEC, MAX_TTL_SEC } from './labels.js'

export class EnvError extends Error {
  override readonly name = 'EnvError'
}

export interface DelegateSettings {
  /** Path to the labels file. */
  readonly labelsPath: string
  /**
   * The name this host is expected to answer for, when the operator states it.
   * Cross-checked against the file's own `name` at boot and **used for nothing
   * else** — §8.6's URL carries no parent, so no request can be checked
   * against it.
   */
  readonly name: string | null
  /** TCP bind. Loopback by default; containers set 0.0.0.0 explicitly. */
  readonly host: string
  readonly port: number
  /** `''`, or a prefix with a leading and no trailing slash. */
  readonly basePath: string
  readonly defaultTtl: number
  readonly reloadSec: number
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
  if (value === undefined) throw new EnvError(`${key} is required — see packages/delegate/.env.example`)
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

/**
 * A `D` host may carry a short path (`nns.binance.com/binance`), which is how
 * one host answers for two names — §8.6's URL has no parent field, so two
 * names pointing at one bare host share one namespace. The prefix is validated
 * against the same character set §6 `D` allows, so a path this server can be
 * mounted at is always a path a `D` can name.
 */
function basePath(env: EnvSource): string {
  const raw = read(env, 'NNS_DELEGATE_BASE_PATH')
  if (raw === undefined) return ''
  const parts = raw.split('/').filter((part) => part !== '')
  for (const part of parts) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(part)) {
      throw new EnvError(
        `NNS_DELEGATE_BASE_PATH segments must be lowercase a-z, 0-9 and -, not starting with -, got ${JSON.stringify(raw)}`,
      )
    }
  }
  return parts.length === 0 ? '' : `/${parts.join('/')}`
}

export function loadSettings(env: EnvSource = process.env): DelegateSettings {
  const level = read(env, 'NNS_LOG_LEVEL') ?? 'info'
  if (!isLogLevel(level)) {
    throw new EnvError(`NNS_LOG_LEVEL must be one of debug|info|warn|error, got ${JSON.stringify(level)}`)
  }

  return Object.freeze({
    labelsPath: required(env, 'NNS_DELEGATE_LABELS'),
    name: read(env, 'NNS_DELEGATE_NAME') ?? null,
    host: read(env, 'NNS_DELEGATE_HOST') ?? '127.0.0.1',
    port: integer(env, 'NNS_DELEGATE_PORT', 8636, 1, 65_535),
    basePath: basePath(env),
    defaultTtl: integer(env, 'NNS_DELEGATE_DEFAULT_TTL', DEFAULT_TTL_SEC, 1, MAX_TTL_SEC),
    reloadSec: integer(env, 'NNS_DELEGATE_RELOAD_SEC', 5, 1, 3_600),
    logLevel: level,
  })
}
