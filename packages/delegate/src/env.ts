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
   * The names this host is expected to answer for, when the operator states
   * them — comma-separated. Cross-checked against the file's own `names` at
   * boot and **used for nothing else**: the file is the gate, and this only
   * catches a misdeployed file before it answers with another owner's
   * addresses. Listing a subset is fine; the check is presence, not equality,
   * so a host serving customers need not restate its whole roster in `.env`.
   */
  readonly names: readonly string[]
  /** TCP bind. Loopback by default; containers set 0.0.0.0 explicitly. */
  readonly host: string
  readonly port: number
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

/** `NNS_DELEGATE_NAME`, comma-separated. Empty when the operator states none. */
function nameList(env: EnvSource): readonly string[] {
  const raw = read(env, 'NNS_DELEGATE_NAME')
  if (raw === undefined) return []
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  if (names.length === 0) {
    throw new EnvError('NNS_DELEGATE_NAME must list at least one name when set, or be left unset')
  }
  return names
}

export function loadSettings(env: EnvSource = process.env): DelegateSettings {
  const level = read(env, 'NNS_LOG_LEVEL') ?? 'info'
  if (!isLogLevel(level)) {
    throw new EnvError(`NNS_LOG_LEVEL must be one of debug|info|warn|error, got ${JSON.stringify(level)}`)
  }

  return Object.freeze({
    labelsPath: required(env, 'NNS_DELEGATE_LABELS'),
    names: nameList(env),
    host: read(env, 'NNS_DELEGATE_HOST') ?? '127.0.0.1',
    port: integer(env, 'NNS_DELEGATE_PORT', 8636, 1, 65_535),
    defaultTtl: integer(env, 'NNS_DELEGATE_DEFAULT_TTL', DEFAULT_TTL_SEC, 1, MAX_TTL_SEC),
    reloadSec: integer(env, 'NNS_DELEGATE_RELOAD_SEC', 5, 1, 3_600),
    logLevel: level,
  })
}
