/**
 * Environment → reconciler settings.
 *
 * The same variable names as `packages/indexer` and `packages/admin`, so one
 * `.env` on a box serves all three — minus everything the reconciler must not
 * have. **`loadSettings` reads no database URL and no key, and that is the
 * deliverable rather than an omission**: the reconciler's whole claim is that it
 * computes owed and settled without reading the settlement service's state, and
 * a connection string it never opens would still be an invitation to.
 *
 * The four loaders are a chain, each adding exactly what its command needs:
 * `loadSettings` (reconcile) → `loadWatcherSettings` (watch) →
 * `loadLedgerSettings` (ledger, + its own database) → `loadIssuerSettings`
 * (issue, + a node and the §11.5 thresholds). **No key is read anywhere in this
 * file.** Key material lives in `keys.ts`, which only `issue-main.ts` imports,
 * so "which commands can spend" is a property of the import graph — see
 * `import-graph.test.ts`.
 *
 * `RESERVED_NAMES` is a `CONSTANTS` entry since the launch freeze and is read
 * from `core`, so there is nothing here to keep equal to the indexer's value —
 * the list is an input to §7.4's `RESERVED_NAME` verdict, and a replay under a
 * different list would derive different verdicts and report them as the
 * operator's divergence.
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

/**
 * The watcher's settings: the reconciler's, plus how often to look.
 *
 * Still **no database URL and no key** — the watcher holds neither, and will
 * not until the issuer and the ledger exist. Sharing one settings loader is
 * what keeps that true by inspection rather than by intention.
 */
export interface WatcherSettings extends ReconcilerSettings {
  /** Seconds between polls. */
  readonly pollSeconds: number
}

/**
 * The ledger's settings: the watcher's, plus its own database.
 *
 * **`NNS_SETTLEMENT_DATABASE_URL`, never `NNS_DATABASE_URL`.** The name is
 * different from the indexer's on purpose: one `.env` on a box serves several of
 * these processes, and a shared variable name is how a ledger ends up beside the
 * indexer's tables — the one arrangement `packages/settlement/CLAUDE.md` rules
 * out. It is loaded here and nowhere near {@link loadSettings}, so `reconcile`
 * and `watch` keep starting on a box that has no database at all.
 *
 * **There is still no key.** The issuer's keys are `keys.ts`'s.
 */
export interface LedgerSettings extends WatcherSettings {
  readonly databaseUrl: string
}

/**
 * The issuer's settings: the ledger's, plus a node and the §11.5 thresholds.
 *
 * **Still no key** — see {@link LedgerSettings}. What is here is everything the
 * issuer needs to *plan* a settlement, which is deliberately the whole of a dry
 * run: the balance precheck is a read, and a dry run that could not perform it
 * would leave §11.5's first rule untested until the moment it mattered.
 */
export interface IssuerSettings extends LedgerSettings {
  readonly rpcUrl: string
  readonly rpcUser: string | undefined
  readonly rpcPassword: string | undefined
  /**
   * Fee on every `M`, in luna. `0` is accepted by the network
   * (`docs/rpc-reference.md` §4) and is what every other NNS sender uses; the
   * knob exists because a fee-zero transaction can be deprioritised under
   * congestion, and the plan stores the fee it was pinned with either way.
   */
  readonly feeLuna: bigint
  /**
   * Blocks after `validityStartHeight` at which a pinned `M` is treated as dead,
   * or `null` to take the node's own `transactionValidityWindow`.
   *
   * **The two directions do not cost the same.** Too long is a stall: the
   * transaction has already expired on-chain and the ledger waits longer than it
   * needed to before pinning a replacement. Too short is the double payment:
   * the ledger declares an attempt dead, pins a second one at a fresh
   * `validityStartHeight`, and both are valid at once.
   *
   * `null` is the normal case and the safe one — `getPolicyConstants` answers
   * the window authoritatively (7,200 blocks on mainnet, ~2 h), and the
   * override exists for an operator who wants to wait *longer* than the chain
   * requires, never shorter. {@link resolveExpiryBlocks} refuses a shorter one.
   */
  readonly expiryBlocks: number | null
  /**
   * §11.5 rule 2: alert on a threshold well above zero, sized so topping up is
   * routine. Refused at zero, because alerting at zero alerts after the failure.
   */
  readonly minBalance: bigint
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
    })
  } catch (cause) {
    if (cause instanceof EnvError) throw cause
    throw new EnvError(cause instanceof Error ? cause.message : String(cause))
  }

  return Object.freeze({ config, apiUrl })
}

/**
 * Default poll interval, seconds.
 *
 * A quarter of `CHECKPOINT_INTERVAL` at ~1 s blocks. `/log` only changes at a
 * checkpoint boundary, so polling faster buys nothing but requests — and the
 * poll is a cheap `/checkpoints/latest` that refetches the file only when the
 * height moves, so overshooting the boundary costs a few minutes of latency and
 * nothing else.
 */
export const DEFAULT_POLL_SECONDS = 180

export function loadWatcherSettings(env: EnvSource = process.env): WatcherSettings {
  const base = loadSettings(env)
  const raw = read(env, 'NNS_SETTLEMENT_POLL_SECONDS')
  const pollSeconds = raw === undefined ? DEFAULT_POLL_SECONDS : requiredInteger(env, 'NNS_SETTLEMENT_POLL_SECONDS', 1)
  return Object.freeze({ ...base, pollSeconds })
}

export function loadLedgerSettings(env: EnvSource = process.env): LedgerSettings {
  const base = loadWatcherSettings(env)
  const databaseUrl = required(env, 'NNS_SETTLEMENT_DATABASE_URL')
  if (read(env, 'NNS_DATABASE_URL') === databaseUrl) {
    throw new EnvError(
      'NNS_SETTLEMENT_DATABASE_URL is the indexer\'s NNS_DATABASE_URL. The ledger records payments that have left a hot key ' +
        'and cannot be fully rebuilt — an in-flight attempt exists nowhere else; the indexer\'s database is a droppable projection. Give the ledger its own',
    )
  }
  return Object.freeze({ ...base, databaseUrl })
}

/**
 * `NNS_RPC_URL` wins if set; otherwise the host/port pair is assembled, which
 * is the form a `client.toml` reader recognises. Identical to `admin`'s, and
 * for the same reason: one `.env` on a box serves both.
 */
function rpcUrl(env: EnvSource): string {
  const explicit = read(env, 'NNS_RPC_URL')
  if (explicit !== undefined) return explicit
  const host = read(env, 'NNS_RPC_HOST')
  const port = read(env, 'NNS_RPC_PORT')
  if (host === undefined || port === undefined) {
    throw new EnvError('set NNS_RPC_URL, or both NNS_RPC_HOST and NNS_RPC_PORT — see packages/settlement/.env.example')
  }
  const scheme = read(env, 'NNS_RPC_SCHEME') ?? 'http'
  return `${scheme}://${host}:${port}`
}

/** Like {@link luna}, but a missing or zero value is an error rather than `0n`. */
function requiredLuna(env: EnvSource, key: string, why: string): bigint {
  const raw = required(env, key)
  if (!/^\d+$/.test(raw)) {
    throw new EnvError(`${key} must be a whole number of luna (1 NIM = 100,000 luna), got ${JSON.stringify(raw)}`)
  }
  const value = BigInt(raw)
  if (value === 0n) throw new EnvError(`${key} must be greater than zero — ${why}`)
  return value
}

export function loadIssuerSettings(env: EnvSource = process.env): IssuerSettings {
  const base = loadLedgerSettings(env)
  const url = rpcUrl(env)
  try {
    void new URL(url)
  } catch {
    throw new EnvError(`NNS_RPC_URL is not a valid URL: ${JSON.stringify(url)}`)
  }
  return Object.freeze({
    ...base,
    rpcUrl: url,
    rpcUser: read(env, 'NNS_RPC_USER'),
    rpcPassword: read(env, 'NNS_RPC_PASSWORD'),
    feeLuna: luna(env, 'NNS_SETTLEMENT_FEE_LUNA'),
    expiryBlocks:
      read(env, 'NNS_SETTLEMENT_EXPIRY_BLOCKS') === undefined
        ? null
        : requiredInteger(env, 'NNS_SETTLEMENT_EXPIRY_BLOCKS', 1),
    minBalance: requiredLuna(
      env,
      'NNS_SETTLEMENT_MIN_BALANCE',
      '§11.5 asks for a threshold well above zero, because alerting at zero alerts after the failure',
    ),
  })
}
