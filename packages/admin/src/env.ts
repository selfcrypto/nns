/**
 * Environment → admin CLI settings.
 *
 * A trimmed mirror of `packages/indexer/src/env.ts` — the same variable names
 * on purpose, so the `.env` that runs an indexer on a box also serves this
 * CLI — minus everything the CLI never touches (database, poll tuning,
 * logging). The §3 values that are still OPEN go through `core`'s
 * `defineConfig`, which validates them at startup rather than at first use.
 *
 * No secrets in the repo, and none here either: the admin private key never
 * passes through this process. It lives in the node's wallet (`importRawKey`),
 * and the CLI only unlocks it by address (`docs/rpc-reference.md` §5).
 */

import { defineConfig, type NnsConfig } from '@nns/core'

export class EnvError extends Error {
  override readonly name = 'EnvError'
}

export interface AdminSettings {
  /** The §3 values `core` needs, already validated and frozen. */
  readonly config: NnsConfig
  readonly rpcUrl: string
  readonly rpcUser: string | undefined
  readonly rpcPassword: string | undefined
  /**
   * Base URL of an NNS API. Optional, because only `p` needs it: §10.6's
   * relative bounds are measured against the active prices and the last `P`'s
   * height, which no node knows and this process does not hold (`params.ts`).
   * `u` runs without one, so an unset value is not an error until `p` is asked
   * for.
   */
  readonly apiUrl: string | undefined
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
  if (value === undefined) throw new EnvError(`${key} is required — see packages/admin/.env.example`)
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
    throw new EnvError('set NNS_RPC_URL, or both NNS_RPC_HOST and NNS_RPC_PORT — see packages/admin/.env.example')
  }
  const scheme = read(env, 'NNS_RPC_SCHEME') ?? 'http'
  return `${scheme}://${host}:${port}`
}

export function loadSettings(env: EnvSource = process.env): AdminSettings {
  const url = rpcUrl(env)
  try {
    void new URL(url)
  } catch {
    throw new EnvError(`NNS_RPC_URL is not a valid URL: ${JSON.stringify(url)}`)
  }

  let config: NnsConfig
  try {
    config = defineConfig({
      networkId: requiredInteger(env, 'NNS_NETWORK_ID', 0),
    })
  } catch (cause) {
    if (cause instanceof EnvError) throw cause
    throw new EnvError(cause instanceof Error ? cause.message : String(cause))
  }

  const apiUrl = read(env, 'NNS_API_URL')
  if (apiUrl !== undefined) {
    try {
      void new URL(apiUrl)
    } catch {
      throw new EnvError(`NNS_API_URL is not a valid URL: ${JSON.stringify(apiUrl)}`)
    }
  }

  return Object.freeze({
    config,
    rpcUrl: url,
    rpcUser: read(env, 'NNS_RPC_USER'),
    rpcPassword: read(env, 'NNS_RPC_PASSWORD'),
    apiUrl,
  })
}
