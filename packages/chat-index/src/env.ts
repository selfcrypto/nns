/**
 * Environment → settings. No secrets in the repo; `.env.example` is the
 * committed shape.
 *
 * `NNS_CHAT_START_HEIGHT` has no default on purpose. It is the operator's
 * statement of how far back this index reaches, it must be a height the node
 * still holds, and it is reported to every reader as the window — a silent
 * default would turn "the operator chose this" into "nobody noticed".
 *
 * It may be **later** than `CHAT_MIN_HEIGHT` — an operator who started
 * indexing last week says so — but never earlier. Below the launch height
 * there is no registry for a message to be about, and every reader drops
 * those rows anyway (`chatMessages`), so scanning for them buys nothing and
 * declares a window the endpoint cannot honour.
 */

import { CHAT_MIN_HEIGHT } from '@nns/chat'
import { isLogLevel, type LogLevel } from './logger.js'

export class EnvError extends Error {
  override readonly name = 'EnvError'
}

export interface ChatIndexSettings {
  readonly databaseUrl: string
  readonly rpcUrl: string
  readonly rpcUser: string | undefined
  readonly rpcPassword: string | undefined
  readonly rpcTimeoutMs: number
  readonly networkId: number
  readonly startHeight: number
  readonly pollIntervalMs: number
  readonly port: number
  readonly maxPageSize: number
  readonly logLevel: LogLevel
}

export type EnvSource = Record<string, string | undefined>

const required = (env: EnvSource, key: string): string => {
  const value = env[key]
  if (value === undefined || value.trim() === '') throw new EnvError(`${key} is required`)
  return value.trim()
}

const integer = (env: EnvSource, key: string, fallback: number, min: number): number => {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) throw new EnvError(`${key} must be an integer >= ${min}`)
  return value
}

export function loadSettings(env: EnvSource = process.env): ChatIndexSettings {
  const level = env['NNS_CHAT_LOG_LEVEL']?.trim() ?? 'info'
  if (!isLogLevel(level)) throw new EnvError('NNS_CHAT_LOG_LEVEL must be debug, info, warn or error')

  const startHeight = Number(required(env, 'NNS_CHAT_START_HEIGHT'))
  if (!Number.isInteger(startHeight) || startHeight < 1) {
    throw new EnvError('NNS_CHAT_START_HEIGHT must be a positive integer block height')
  }
  if (startHeight < CHAT_MIN_HEIGHT) {
    throw new EnvError(
      `NNS_CHAT_START_HEIGHT must be at or above the launch height (${CHAT_MIN_HEIGHT}); ` +
        'nothing below it is about a registered name, and every reader drops those messages',
    )
  }

  return {
    databaseUrl: required(env, 'NNS_CHAT_DATABASE_URL'),
    rpcUrl: required(env, 'NNS_CHAT_RPC_URL'),
    rpcUser: env['NNS_CHAT_RPC_USER']?.trim() || undefined,
    rpcPassword: env['NNS_CHAT_RPC_PASSWORD'] || undefined,
    rpcTimeoutMs: integer(env, 'NNS_CHAT_RPC_TIMEOUT_MS', 20_000, 1),
    networkId: integer(env, 'NNS_CHAT_NETWORK_ID', 24, 0),
    startHeight,
    pollIntervalMs: integer(env, 'NNS_CHAT_POLL_INTERVAL_MS', 30_000, 100),
    port: integer(env, 'NNS_CHAT_PORT', 8637, 1),
    maxPageSize: integer(env, 'NNS_CHAT_MAX_PAGE', 500, 1),
    logLevel: level,
  }
}
