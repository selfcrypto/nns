/**
 * Environment → reconciler settings.
 *
 * The same variable names as `packages/indexer` and `packages/admin`, so one
 * `.env` on a box serves all three — minus everything the reconciler must not
 * have. **There is no database URL and no key here, and that is the deliverable
 * rather than an omission**: the reconciler's whole claim is that it computes
 * owed and settled without reading the settlement service's state, and a
 * connection string it never opens would still be an invitation to.
 *
 * `NNS_RESERVED_NAMES` must equal the indexer's value, for the same reason the
 * API's must: the list is an input to §7.4's `RESERVED_NAME` verdict, and a
 * replay under a different list derives different verdicts and reports them as
 * the operator's divergence.
 */

import { defineConfig, type NnsConfig } from '@nns/core'

export class EnvError extends Error {
  override readonly name = 'EnvError'
}

export interface ReconcilerSettings {
  /** The §3 values `core` needs, already validated and frozen. */
  readonly config: NnsConfig
  /** API root, no trailing slash — the party being audited. */
  readonly apiUrl: string
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
  if (value === undefined) throw new EnvError(`${key} is required — see packages/settlement/.env.example`)
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
function nameList(env: EnvSource, key: string): string[] {
  const raw = read(env, key)
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

export function loadSettings(env: EnvSource = process.env): ReconcilerSettings {
  const apiUrl = required(env, 'NNS_API_URL').replace(/\/+$/, '')
  try {
    void new URL(apiUrl)
  } catch {
    throw new EnvError(`NNS_API_URL is not a valid URL: ${JSON.stringify(apiUrl)}`)
  }

  let config: NnsConfig
  try {
    config = defineConfig({
      networkId: requiredInteger(env, 'NNS_NETWORK_ID', 0),
      launchHeight: requiredInteger(env, 'NNS_LAUNCH_HEIGHT', 0),
      treasury: required(env, 'NNS_TREASURY_ADDRESS'),
      protocol: required(env, 'NNS_PROTOCOL_ADDRESS'),
      admin: required(env, 'NNS_ADMIN_ADDRESS'),
      marketplace: required(env, 'NNS_MARKETPLACE_ADDRESS'),
      listingFee: luna(env, 'NNS_LISTING_FEE'),
      reservedNames: nameList(env, 'NNS_RESERVED_NAMES'),
    })
  } catch (cause) {
    if (cause instanceof EnvError) throw cause
    throw new EnvError(cause instanceof Error ? cause.message : String(cause))
  }

  return Object.freeze({ config, apiUrl })
}
