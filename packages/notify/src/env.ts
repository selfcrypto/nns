/**
 * Environment → settings. No secrets in the repo; `deploy/notify/.env.example`
 * is the committed shape.
 *
 * Two channels, each optional: a missing bot token means no Telegram, a
 * missing SMTP host means no email, and the app is told which exist through
 * `GET /settings`. A service with neither still runs, tails the log and
 * records nothing anybody could be sent — which is what a fresh install looks
 * like before the operator fills the `.env`.
 *
 * No Nimiq key. No node URL. Nothing here can sign or broadcast.
 */

import { defineConfig, type NnsConfig, type SignedMessageConvention, SIGNED_MESSAGE_CONVENTIONS } from '@nimiqnames/core'

import { isLogLevel, type LogLevel } from './logger.js'

export class EnvError extends Error {
  override readonly name = 'EnvError'
}

export interface SmtpSettings {
  readonly host: string
  readonly port: number
  /** `starttls` on 587, `tls` on 465. `plain` exists for the tests' fake server; no `.env` produces it. */
  readonly secure: 'starttls' | 'tls' | 'plain'
  readonly user: string
  readonly password: string
  /** `Name <mailbox@domain>` or a bare mailbox. */
  readonly from: string
}

export interface NotifySettings {
  readonly config: NnsConfig
  readonly databaseUrl: string
  /** The resolver API root, no trailing slash. */
  readonly apiUrl: string
  /** The chat index root, or null for no chat notifications. */
  readonly chatUrl: string | null
  /** Where this service is reachable from a browser: the base of every link it mails. */
  readonly publicUrl: string
  /** The app's URL, for the links a message carries. */
  readonly appUrl: string
  /** The host named in the challenge text: what the user is signing in to. */
  readonly host: string
  readonly telegramToken: string | null
  readonly smtp: SmtpSettings | null
  /** Which signature conventions `POST /session` accepts, in order. */
  readonly conventions: readonly SignedMessageConvention[]
  readonly sessionTtlMs: number
  readonly pollIntervalMs: number
  readonly maxFailures: number
  readonly port: number
  readonly logLevel: LogLevel
}

export type EnvSource = Record<string, string | undefined>

const required = (env: EnvSource, key: string): string => {
  const value = env[key]
  if (value === undefined || value.trim() === '') throw new EnvError(`${key} is required`)
  return value.trim()
}

const optional = (env: EnvSource, key: string): string | null => {
  const value = env[key]
  return value === undefined || value.trim() === '' ? null : value.trim()
}

const integer = (env: EnvSource, key: string, fallback: number, min: number): number => {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) throw new EnvError(`${key} must be an integer >= ${min}`)
  return value
}

const url = (value: string, key: string): string => {
  if (!/^https?:\/\//.test(value)) throw new EnvError(`${key} must be an http(s) URL`)
  return value.replace(/\/+$/, '')
}

/**
 * Default `nimiq` alone since 2026-09-23: Nimiq Pay's `sign()` was measured
 * on a device (tasks/26 D0, rpc-reference §8) and signs the same convention
 * the Hub does. `raw` stays available by name for a wallet that does not.
 */
function conventions(env: EnvSource): readonly SignedMessageConvention[] {
  const raw = optional(env, 'NNS_NOTIFY_SIGN_CONVENTIONS')
  if (raw === null) return ['nimiq']
  const list = raw.split(',').map((entry) => entry.trim())
  for (const entry of list) {
    if (!(SIGNED_MESSAGE_CONVENTIONS as readonly string[]).includes(entry)) {
      throw new EnvError(`NNS_NOTIFY_SIGN_CONVENTIONS must list nimiq and/or raw, got ${JSON.stringify(entry)}`)
    }
  }
  return list as SignedMessageConvention[]
}

function smtp(env: EnvSource): SmtpSettings | null {
  const host = optional(env, 'NNS_NOTIFY_SMTP_HOST')
  if (host === null) return null
  const port = integer(env, 'NNS_NOTIFY_SMTP_PORT', 587, 1)
  return {
    host,
    port,
    secure: port === 465 ? 'tls' : 'starttls',
    user: required(env, 'NNS_NOTIFY_SMTP_USER'),
    password: env['NNS_NOTIFY_SMTP_PASSWORD'] ?? '',
    from: required(env, 'NNS_NOTIFY_SMTP_FROM'),
  }
}

export function loadSettings(env: EnvSource = process.env): NotifySettings {
  const level = env['NNS_NOTIFY_LOG_LEVEL']?.trim() ?? 'info'
  if (!isLogLevel(level)) throw new EnvError('NNS_NOTIFY_LOG_LEVEL must be debug, info, warn or error')

  const publicUrl = url(required(env, 'NNS_NOTIFY_PUBLIC_URL'), 'NNS_NOTIFY_PUBLIC_URL')
  const appUrl = url(optional(env, 'NNS_NOTIFY_APP_URL') ?? new URL(publicUrl).origin, 'NNS_NOTIFY_APP_URL')
  const chat = optional(env, 'NNS_NOTIFY_CHAT_URL')

  return {
    config: defineConfig({ networkId: integer(env, 'NNS_NOTIFY_NETWORK_ID', 24, 0) }),
    databaseUrl: required(env, 'NNS_NOTIFY_DATABASE_URL'),
    apiUrl: url(required(env, 'NNS_NOTIFY_API_URL'), 'NNS_NOTIFY_API_URL'),
    chatUrl: chat === null ? null : url(chat, 'NNS_NOTIFY_CHAT_URL'),
    publicUrl,
    appUrl,
    host: optional(env, 'NNS_NOTIFY_HOST') ?? new URL(appUrl).host,
    telegramToken: optional(env, 'NNS_NOTIFY_TELEGRAM_TOKEN'),
    smtp: smtp(env),
    conventions: conventions(env),
    sessionTtlMs: integer(env, 'NNS_NOTIFY_SESSION_TTL_DAYS', 30, 1) * 86_400_000,
    pollIntervalMs: integer(env, 'NNS_NOTIFY_POLL_SECONDS', 60, 5) * 1000,
    maxFailures: integer(env, 'NNS_NOTIFY_MAX_FAILURES', 5, 1),
    port: integer(env, 'NNS_NOTIFY_PORT', 8638, 1),
    logLevel: level,
  }
}
