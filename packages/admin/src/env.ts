/**
 * Environment → admin CLI settings.
 *
 * A trimmed mirror of `packages/indexer/src/env.ts` — the same variable names
 * on purpose, so the `.env` that runs an indexer on a box also serves this
 * CLI — minus everything the CLI never touches (database, poll tuning,
 * logging). Nothing §3-shaped is left: every constant is `CONSTANTS` since
 * the launch freeze, and `NNS_NETWORK_ID` went on 2026-09-02 — the CLI never
 * read it, and the node signs, so no network id is ever this process's to
 * supply.
 *
 * No secrets in the repo, and none here either: the admin private key never
 * passes through this process. It lives in the node's wallet (`importRawKey`),
 * and the CLI only unlocks it by address (`docs/rpc-reference.md` §5).
 */

export class EnvError extends Error {
  override readonly name = 'EnvError'
}

export interface AdminSettings {
  readonly rpcUrl: string
  readonly rpcUser: string | undefined
  readonly rpcPassword: string | undefined
  /**
   * Base URL of an NNS API. Every command needs one — `p` for the active
   * prices (`params.ts`), `u` for whether the name is still RESERVED
   * (`reservation.ts`, since 2026-08-21), `f` for the §10.2 ceiling
   * (`burn.ts`), `a` for all three of the floor, the reservation and the open
   * auctions (`auction.ts`, r28) — but none of it is chain state a node could
   * answer, so it is
   * parsed here and demanded by each command on entry rather than at load:
   * the error then says which read the command cannot make without it.
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

  const apiUrl = read(env, 'NNS_API_URL')
  if (apiUrl !== undefined) {
    try {
      void new URL(apiUrl)
    } catch {
      throw new EnvError(`NNS_API_URL is not a valid URL: ${JSON.stringify(apiUrl)}`)
    }
  }

  return Object.freeze({
    rpcUrl: url,
    rpcUser: read(env, 'NNS_RPC_USER'),
    rpcPassword: read(env, 'NNS_RPC_PASSWORD'),
    apiUrl,
  })
}
