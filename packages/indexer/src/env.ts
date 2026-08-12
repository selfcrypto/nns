/**
 * Environment → indexer settings.
 *
 * Only what the chain-facing half needs. The deployment constants that feed
 * `core`'s `defineConfig` (treasury, protocol, admin and marketplace
 * addresses, the `O` listing fee, `RESERVED_NAMES`) are still **OPEN** in §3
 * and are not read here — an unused required variable is a variable someone
 * fills in with a placeholder.
 *
 * No secrets in the repo: `NNS_RPC_PASSWORD` comes from the environment, and
 * `.env` is gitignored. `.env.example` is the committed shape.
 */

import { isLogLevel, type LogLevel } from './logger.js'

export class EnvError extends Error {
  override readonly name = 'EnvError'
}

export interface IndexerSettings {
  readonly rpcUrl: string
  readonly rpcUser: string | undefined
  readonly rpcPassword: string | undefined
  readonly rpcTimeoutMs: number
  readonly rpcAttempts: number
  /** §7.5: guards against a node fed by a different network. 24 is main-albatross. */
  readonly networkId: number
  /** §3, §7.2: indexers start here, not at genesis. */
  readonly launchHeight: number
  /** Idle wait once the scan has caught up to the last finalised macro block. */
  readonly pollIntervalMs: number
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
  if (value === undefined) throw new EnvError(`${key} is required — see packages/indexer/.env.example`)
  return value
}

function integer(env: EnvSource, key: string, fallback: number, min: number): number {
  const raw = read(env, key)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) {
    throw new EnvError(`${key} must be an integer >= ${min}, got ${JSON.stringify(raw)}`)
  }
  return value
}

function requiredInteger(env: EnvSource, key: string, min: number): number {
  const raw = required(env, key)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) {
    throw new EnvError(`${key} must be an integer >= ${min}, got ${JSON.stringify(raw)}`)
  }
  return value
}

/**
 * `NNS_RPC_URL` wins if set; otherwise the host/port pair is assembled, which
 * is the form a `client.toml` reader recognises. Our node listens on 6488,
 * not the documented default of 8648.
 */
function rpcUrl(env: EnvSource): string {
  const explicit = read(env, 'NNS_RPC_URL')
  if (explicit !== undefined) return explicit
  const host = read(env, 'NNS_RPC_HOST')
  const port = read(env, 'NNS_RPC_PORT')
  if (host === undefined || port === undefined) {
    throw new EnvError('set NNS_RPC_URL, or both NNS_RPC_HOST and NNS_RPC_PORT — see packages/indexer/.env.example')
  }
  const scheme = read(env, 'NNS_RPC_SCHEME') ?? 'http'
  return `${scheme}://${host}:${port}`
}

export function loadSettings(env: EnvSource = process.env): IndexerSettings {
  const url = rpcUrl(env)
  try {
    void new URL(url)
  } catch {
    throw new EnvError(`NNS_RPC_URL is not a valid URL: ${JSON.stringify(url)}`)
  }

  const level = read(env, 'NNS_LOG_LEVEL') ?? 'info'
  if (!isLogLevel(level)) {
    throw new EnvError(`NNS_LOG_LEVEL must be one of debug|info|warn|error, got ${JSON.stringify(level)}`)
  }

  return Object.freeze({
    rpcUrl: url,
    rpcUser: read(env, 'NNS_RPC_USER'),
    rpcPassword: read(env, 'NNS_RPC_PASSWORD'),
    rpcTimeoutMs: integer(env, 'NNS_RPC_TIMEOUT_MS', 30_000, 1),
    rpcAttempts: integer(env, 'NNS_RPC_ATTEMPTS', 4, 1),
    networkId: requiredInteger(env, 'NNS_NETWORK_ID', 0),
    launchHeight: requiredInteger(env, 'NNS_LAUNCH_HEIGHT', 0),
    pollIntervalMs: integer(env, 'NNS_POLL_INTERVAL_MS', 15_000, 100),
    logLevel: level,
  })
}
