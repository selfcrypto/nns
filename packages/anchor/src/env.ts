/**
 * Environment → deploy settings.
 *
 * Same shape as `packages/admin/src/env.ts` and `packages/indexer/src/env.ts`
 * — read, trim, validate at startup rather than at first use.
 *
 * **The deploy key is the one secret this repository handles directly**, and
 * unlike `admin`'s Nimiq key there is no node wallet to hide it in: an EVM
 * transaction is signed in-process. So it comes from the environment, it is
 * validated for shape but never printed, and `.env` is gitignored. Nothing
 * here has a default — a defaulted chain id or RPC URL would deploy
 * successfully to the wrong network, which is the failure this file exists to
 * prevent.
 */

export class EnvError extends Error {
  override readonly name = 'EnvError'
}

export type EnvSource = Readonly<Record<string, string | undefined>>

export interface DeploySettings {
  readonly rpcUrl: string
  readonly chainId: number
  /** Present only when a key is configured; absent is legal for a dry run. */
  readonly deployKey: string | undefined
  /**
   * The deployer address, for planning without the key present.
   *
   * A dry run needs an address — it reads a nonce and a balance and predicts
   * a `CREATE` address from them — but it has no reason to need the key. So
   * the plan can be produced and reviewed on a machine that has never seen
   * it, which is the whole point of a cold deploy key. Ignored when
   * `NNS_ANCHOR_DEPLOY_KEY` is set, and cross-checked against the key's own
   * address if both are given.
   */
  readonly deployAddress: string | undefined
}

function read(env: EnvSource, key: string): string | undefined {
  const value = env[key]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function required(env: EnvSource, key: string): string {
  const value = read(env, key)
  if (value === undefined) throw new EnvError(`${key} is required — see packages/anchor/.env.example`)
  return value
}

/**
 * `NNS_ANCHOR_CHAIN_ID` is required and has no default — **not even 137**.
 * The whole point of carrying it is to disagree with the endpoint when the
 * endpoint is wrong (`planDeploy` refuses on mismatch), and a default would
 * make the common misconfiguration — an RPC URL still pointing at the
 * rehearsal network — agree with itself.
 */
export function loadSettings(env: EnvSource = process.env): DeploySettings {
  const rpcUrl = required(env, 'NNS_ANCHOR_RPC_URL')
  const rawChainId = required(env, 'NNS_ANCHOR_CHAIN_ID')
  // Canonical decimal, checked before `Number` sees it. `Number('0x89')` is
  // 137 and `Number('1e3')` is 1000 — a chain id written in any of the forms
  // JavaScript silently accepts would pass a `Number.isInteger` check and
  // then be compared against the endpoint as though it had been read as
  // written. Same rule §5.2 applies to numeric wire fields, for the same
  // reason: one spelling, no coercion.
  if (!/^[0-9]+$/.test(rawChainId)) {
    throw new EnvError(
      `NNS_ANCHOR_CHAIN_ID must be a decimal integer, got ${JSON.stringify(rawChainId)} ` +
        '(Polygon PoS is 137, Sepolia 11155111)',
    )
  }
  const chainId = Number(rawChainId)
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new EnvError(`NNS_ANCHOR_CHAIN_ID must be a positive integer, got ${JSON.stringify(rawChainId)}`)
  }

  const deployKey = read(env, 'NNS_ANCHOR_DEPLOY_KEY')
  if (deployKey !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(deployKey)) {
    // Shape only, and the value never appears in the message.
    throw new EnvError('NNS_ANCHOR_DEPLOY_KEY must be a 0x-prefixed 32-byte hex private key')
  }

  const deployAddress = read(env, 'NNS_ANCHOR_DEPLOY_ADDRESS')
  if (deployAddress !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(deployAddress)) {
    throw new EnvError('NNS_ANCHOR_DEPLOY_ADDRESS must be a 0x-prefixed 20-byte hex address')
  }
  // Deliberately *not* requiring one of the two here. `verify` reads code at
  // an address and needs no deployer at all; demanding one would make the
  // audit command — the one a third party runs to check the operator —
  // require a key it has no business holding. The deploy path asks for it
  // instead, via `requireDeployer`.
  return { rpcUrl, chainId, deployKey, deployAddress }
}

/**
 * The deployer identity, for the paths that need one.
 *
 * A discriminated union rather than two optional fields, so the caller cannot
 * reach for an address that is not there — the shape carries which of the two
 * configurations is in force, and `signing` is the only one that can send.
 */
export type Deployer =
  | { readonly kind: 'signing'; readonly key: string; readonly declaredAddress: string | undefined }
  | { readonly kind: 'planning'; readonly address: string }

export function requireDeployer(settings: DeploySettings): Deployer {
  if (settings.deployKey !== undefined) {
    return { kind: 'signing', key: settings.deployKey, declaredAddress: settings.deployAddress }
  }
  if (settings.deployAddress !== undefined) {
    return { kind: 'planning', address: settings.deployAddress }
  }
  throw new EnvError(
    'set NNS_ANCHOR_DEPLOY_KEY to deploy, or NNS_ANCHOR_DEPLOY_ADDRESS to plan without the key ' +
      '— see packages/anchor/.env.example',
  )
}

/** The key, or a usable error. Separate so a dry run can run without one. */
export function requireDeployKey(settings: DeploySettings): string {
  if (settings.deployKey === undefined) {
    throw new EnvError('NNS_ANCHOR_DEPLOY_KEY is required to send — see packages/anchor/.env.example')
  }
  return settings.deployKey
}
