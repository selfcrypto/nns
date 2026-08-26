/**
 * Environment → indexer settings.
 *
 * The five §3 values that are still **OPEN** (`LAUNCH_HEIGHT` and the four
 * addresses) are read here and handed to `core`'s `defineConfig`, which
 * validates them. That is the whole reason they are injected: a placeholder
 * cannot survive quietly into a mainnet build if it has to come from the
 * environment of the machine running it. `RESERVED_NAMES` and the `O` listing
 * fee took the opposite route at the launch freeze — they are `CONSTANTS` now,
 * and there is deliberately no environment variable that can set them.
 *
 * No secrets in the repo: `NNS_RPC_PASSWORD` and `NNS_DATABASE_URL` come from
 * the environment, and `.env` is gitignored. `.env.example` is the committed
 * shape.
 */

import { CONSTANTS, defineConfig, type NnsConfig } from '@nns/core'

import { isLogLevel, type LogLevel } from './logger.js'

export class EnvError extends Error {
  override readonly name = 'EnvError'
}

export interface IndexerSettings {
  readonly databaseUrl: string
  /** The §3 values `core` needs, already validated and frozen. */
  readonly config: NnsConfig
  readonly rpcUrl: string
  readonly rpcUser: string | undefined
  readonly rpcPassword: string | undefined
  readonly rpcTimeoutMs: number
  readonly rpcAttempts: number
  /** §7.5: guards against a node fed by a different network. 24 is main-albatross. */
  readonly networkId: number
  /** Idle wait once the scan has caught up to the last finalised macro block. */
  readonly pollIntervalMs: number
  /** How often the `indexer.progress` heartbeat may repeat. */
  readonly progressIntervalMs: number
  readonly logLevel: LogLevel
  /**
   * How an **empty** database is seeded. Read only when there is no cursor —
   * a database that has already scanned a batch is never re-seeded, whatever
   * this says, because the mode describes where state came from and that is a
   * fact the database already holds.
   *
   * `hybrid`'s background verification is the exception: it resumes on every
   * start while an unverified range remains, so an operator who bootstrapped
   * with `snapshot` can switch to `hybrid` later and have it run.
   */
  readonly startMode: StartMode
  /** Where a bootstrap's expected commitment comes from. */
  readonly snapshotSource: SnapshotSource
  /**
   * For `peer`, the API root a bootstrap reads `/log` and
   * `/checkpoints/{height}` from — another operator's resolver, **not** this
   * deployment's own. For `anchor`, an IPFS gateway root; `{cid}` is
   * substituted where it appears, and `/ipfs/<cid>` appended where it does not.
   */
  readonly snapshotUrl: string | undefined
  /**
   * Anchor-chain endpoints. **Two or more**, and independent: §9 exists
   * because the injected provider is the host's, and one endpoint can lie
   * alone. The reader refuses a single one rather than treating it as a check.
   */
  readonly anchorRpcUrls: readonly string[]
  readonly anchorContract: string | undefined
  /**
   * `ANCHOR_PUBLISHERS`. An unlisted publisher is ignored, never counted and
   * never a mismatch (§8.5 #1), so an empty list is not a permissive default —
   * it is no check at all, and the bootstrap refuses rather than proceed.
   */
  readonly anchorPublishers: readonly string[]
  /** Distinct listed publishers that must agree. Defaults to `ANCHOR_QUORUM`. */
  readonly anchorQuorum: number
}

/**
 * How an empty database is seeded (`NNS_START_MODE`).
 *
 * - `scratch` — replay every batch from `LAUNCH_HEIGHT`. The default, and the
 *   only mode that derives the whole registry from the chain.
 * - `snapshot` — fetch a peer's §8.2 log, verify it against the §8.1
 *   commitment that peer publishes, replay it into state, and start scanning
 *   from there. Minutes instead of hours, at the cost of §8.4 Tier 3 depth
 *   over the bootstrapped range: a line the peer **omitted** is invisible to a
 *   replay of what it served.
 * - `hybrid` — `snapshot`, and then re-derive the bootstrapped range from the
 *   chain in the background, checking every §8.1 commitment against the one
 *   already stored. Usable immediately, Tier 3 shortly after.
 *
 * A **flag** was the obvious shape and is the wrong one here: this indexer runs
 * under compose, and `deploy/README.md` is explicit that every value a role
 * needs goes in that role's `.env`. `@nns/anchor` already learned this the
 * expensive way — `NNS_ANCHOR_SEND=--send` exists purely to thread a flag back
 * through an env var, which is the shape of the mistake, not a precedent.
 */
export type StartMode = 'scratch' | 'snapshot' | 'hybrid'

const START_MODES: readonly StartMode[] = ['scratch', 'snapshot', 'hybrid']

export function isStartMode(value: string): value is StartMode {
  return (START_MODES as readonly string[]).includes(value)
}

/**
 * Where a bootstrap's log and its expected §8.1 commitment come from
 * (`NNS_SNAPSHOT_SOURCE`).
 *
 * - `peer` — another operator's API. The log and the checkpoint it is bound to
 *   come from the same party, so what is proved is "this is what that operator
 *   committed to". All six components come back, so a mismatch names one.
 * - `anchor` — the §9 contract. `ANCHOR_QUORUM` listed publishers must agree,
 *   across at least two RPC endpoints, and the bytes then come from any IPFS
 *   gateway with the gateway trusted for nothing. Stronger provenance, coarser
 *   diagnostics: an `Anchored` event carries the commitment and the CID digest
 *   and no individual roots.
 */
export type SnapshotSource = 'peer' | 'anchor'

const SNAPSHOT_SOURCES: readonly SnapshotSource[] = ['peer', 'anchor']

export function isSnapshotSource(value: string): value is SnapshotSource {
  return (SNAPSHOT_SOURCES as readonly string[]).includes(value)
}

/** A 20-byte EVM address in the form the reader and the contract both use. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

function list(env: EnvSource, key: string): readonly string[] {
  const raw = read(env, key)
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
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
  const networkId = requiredInteger(env, 'NNS_NETWORK_ID', 0)
  try {
    void new URL(url)
  } catch {
    throw new EnvError(`NNS_RPC_URL is not a valid URL: ${JSON.stringify(url)}`)
  }

  const level = read(env, 'NNS_LOG_LEVEL') ?? 'info'
  if (!isLogLevel(level)) {
    throw new EnvError(`NNS_LOG_LEVEL must be one of debug|info|warn|error, got ${JSON.stringify(level)}`)
  }

  const startMode = read(env, 'NNS_START_MODE') ?? 'scratch'
  if (!isStartMode(startMode)) {
    throw new EnvError(
      `NNS_START_MODE must be one of ${START_MODES.join('|')}, got ${JSON.stringify(startMode)}`,
    )
  }
  const snapshotSource = read(env, 'NNS_SNAPSHOT_SOURCE') ?? 'peer'
  if (!isSnapshotSource(snapshotSource)) {
    throw new EnvError(
      `NNS_SNAPSHOT_SOURCE must be one of ${SNAPSHOT_SOURCES.join('|')}, got ${JSON.stringify(snapshotSource)}`,
    )
  }
  const snapshotUrl = read(env, 'NNS_SNAPSHOT_URL')
  const anchorRpcUrls = list(env, 'NNS_SNAPSHOT_ANCHOR_RPC')
  const anchorContract = read(env, 'NNS_SNAPSHOT_ANCHOR_CONTRACT')
  const anchorPublishers = list(env, 'NNS_SNAPSHOT_ANCHOR_PUBLISHERS')
  const anchorQuorum = integer(env, 'NNS_SNAPSHOT_ANCHOR_QUORUM', CONSTANTS.ANCHOR_QUORUM, 1)

  if (startMode !== 'scratch') {
    if (snapshotUrl === undefined) {
      throw new EnvError(
        `NNS_START_MODE=${startMode} needs NNS_SNAPSHOT_URL ` +
          `(${snapshotSource === 'anchor' ? 'an IPFS gateway root' : "another operator's API root"}) ` +
          '— see packages/indexer/.env.example',
      )
    }
    try {
      void new URL(snapshotUrl.replace('{cid}', 'cid'))
    } catch {
      throw new EnvError(`NNS_SNAPSHOT_URL is not a valid URL: ${JSON.stringify(snapshotUrl)}`)
    }
    if (snapshotSource === 'anchor') {
      // Checked here rather than at the first fetch: an hour into a backfill
      // is the wrong moment to discover the publisher list was never filled.
      if (anchorRpcUrls.length < 2) {
        throw new EnvError(
          'NNS_SNAPSHOT_SOURCE=anchor needs at least two independent endpoints in ' +
            'NNS_SNAPSHOT_ANCHOR_RPC (comma-separated). §9: one endpoint is not a cross-check.',
        )
      }
      if (anchorContract === undefined || !EVM_ADDRESS.test(anchorContract)) {
        throw new EnvError(
          `NNS_SNAPSHOT_ANCHOR_CONTRACT must be a 20-byte 0x address, got ${JSON.stringify(anchorContract)}`,
        )
      }
      if (anchorPublishers.length === 0) {
        throw new EnvError(
          'NNS_SNAPSHOT_SOURCE=anchor needs NNS_SNAPSHOT_ANCHOR_PUBLISHERS. An unlisted publisher is ' +
            'ignored rather than counted (§8.5 #1), so an empty list is no check at all, not a lenient one.',
        )
      }
      for (const publisher of anchorPublishers) {
        if (!EVM_ADDRESS.test(publisher)) {
          throw new EnvError(
            `NNS_SNAPSHOT_ANCHOR_PUBLISHERS entries must be 20-byte 0x addresses, got ${JSON.stringify(publisher)}`,
          )
        }
      }
    }
  }

  return Object.freeze({
    rpcUrl: url,
    rpcUser: read(env, 'NNS_RPC_USER'),
    rpcPassword: read(env, 'NNS_RPC_PASSWORD'),
    rpcTimeoutMs: integer(env, 'NNS_RPC_TIMEOUT_MS', 30_000, 1),
    rpcAttempts: integer(env, 'NNS_RPC_ATTEMPTS', 4, 1),
    networkId,
    pollIntervalMs: integer(env, 'NNS_POLL_INTERVAL_MS', 15_000, 100),
    progressIntervalMs: integer(env, 'NNS_PROGRESS_INTERVAL_MS', 60_000, 1_000),
    logLevel: level,
    databaseUrl: required(env, 'NNS_DATABASE_URL'),
    config: nnsConfig(networkId),
    startMode,
    snapshotSource,
    snapshotUrl,
    anchorRpcUrls,
    anchorContract,
    anchorPublishers,
    anchorQuorum,
  })
}

/**
 * What is left of `NnsConfig` since the launch freeze: `networkId` alone.
 * The §3 addresses and `LAUNCH_HEIGHT` are `CONSTANTS` — there is no env var
 * for them, deliberately, so two indexers cannot disagree about them.
 */
function nnsConfig(networkId: number): NnsConfig {
  try {
    return defineConfig({ networkId })
  } catch (cause) {
    throw new EnvError(cause instanceof Error ? cause.message : String(cause))
  }
}
