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

import { FILEBASE_ENDPOINT_DEFAULT } from './filebase.js'

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

// ── Publisher settings ──────────────────────────────────────────────────────

/** One kubo-RPC add endpoint, as configured. */
export interface IpfsEndpointSettings {
  readonly url: string
  readonly auth: string | undefined
  readonly label: string
}

/**
 * The second §8.2 implementation, chosen by which variables are set:
 * a second kubo-RPC endpoint, or Filebase over its S3-compatible API.
 * Exactly one — both configured is ambiguous and refused. The edge modules
 * (`ipfs.ts`, `filebase.ts`) hide the difference behind `IpfsAdd`, so the
 * choice is an environment change alone.
 */
export type SecondAddSettings =
  | { readonly kind: 'kubo'; readonly url: string; readonly auth: string | undefined; readonly label: string }
  | {
      readonly kind: 'filebase'
      readonly bucket: string
      readonly accessKey: string
      readonly secretKey: string
      readonly endpoint: string
      readonly label: string
    }

export interface PublisherSettings {
  readonly rpcUrl: string
  readonly chainId: number
  /** Where `NnsAnchor` lives. An output of the deploy script, never derived. */
  readonly contractAddress: string
  /** The NNS API serving `/log` and `/checkpoints/{height}`. */
  readonly apiUrl: string
  /** Implementation A: the operator's own kubo-RPC endpoint. */
  readonly ipfsPrimary: IpfsEndpointSettings
  /** Implementation B — §8.2's independent second. */
  readonly ipfsSecondary: SecondAddSettings
  /** Present only when a key is configured; absent is legal for a dry run. */
  readonly publisherKey: string | undefined
  /** The publisher address, for planning without the key present. */
  readonly publisherAddress: string | undefined
  /** §11.5 alert threshold, wei. Alerts fire below it; sends still go out. */
  readonly minBalanceWei: bigint
  /** `eth_getLogs` window for reading own anchors back. */
  readonly lookbackBlocks: bigint
}

/**
 * ~2.3 days of Polygon PoS blocks (~2 s each): wide enough that a weekend
 * outage is still seen as "my last anchor", narrow enough for the range
 * limits public `eth_getLogs` endpoints impose. Overridable because it is an
 * operational window, not an identity — unlike the chain id, a wrong value
 * cannot silently target the wrong network.
 */
export const DEFAULT_LOOKBACK_BLOCKS = 100_000n

function requiredDecimalBigint(env: EnvSource, key: string): bigint {
  const raw = required(env, key)
  if (!/^[0-9]+$/.test(raw)) {
    throw new EnvError(`${key} must be a decimal integer (wei / blocks), got ${JSON.stringify(raw)}`)
  }
  return BigInt(raw)
}

export function loadPublisherSettings(env: EnvSource = process.env): PublisherSettings {
  // Same endpoint discipline as the deploy path, same reason: the chain id
  // has no default, so it can contradict a stale RPC URL.
  const { rpcUrl, chainId } = loadSettings({
    NNS_ANCHOR_RPC_URL: env['NNS_ANCHOR_RPC_URL'],
    NNS_ANCHOR_CHAIN_ID: env['NNS_ANCHOR_CHAIN_ID'],
  })

  const contractAddress = required(env, 'NNS_ANCHOR_CONTRACT_ADDRESS')
  if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) {
    throw new EnvError('NNS_ANCHOR_CONTRACT_ADDRESS must be a 0x-prefixed 20-byte hex address')
  }
  const apiUrl = required(env, 'NNS_ANCHOR_API_URL')

  const primary: IpfsEndpointSettings = {
    url: required(env, 'NNS_ANCHOR_IPFS_ADD_URL'),
    auth: read(env, 'NNS_ANCHOR_IPFS_ADD_AUTH'),
    label: 'ipfs-1',
  }

  const secondaryUrl = read(env, 'NNS_ANCHOR_IPFS_ADD_URL_2')
  const filebaseBucket = read(env, 'NNS_ANCHOR_FILEBASE_BUCKET')
  if (secondaryUrl !== undefined && filebaseBucket !== undefined) {
    throw new EnvError(
      'both NNS_ANCHOR_IPFS_ADD_URL_2 and NNS_ANCHOR_FILEBASE_BUCKET are set — the second §8.2 ' +
        'implementation is one or the other, not both',
    )
  }
  let secondary: SecondAddSettings
  if (filebaseBucket !== undefined) {
    secondary = {
      kind: 'filebase',
      bucket: filebaseBucket,
      accessKey: required(env, 'NNS_ANCHOR_FILEBASE_KEY'),
      secretKey: required(env, 'NNS_ANCHOR_FILEBASE_SECRET'),
      endpoint: read(env, 'NNS_ANCHOR_FILEBASE_ENDPOINT') ?? FILEBASE_ENDPOINT_DEFAULT,
      label: 'filebase',
    }
  } else if (secondaryUrl !== undefined) {
    secondary = { kind: 'kubo', url: secondaryUrl, auth: read(env, 'NNS_ANCHOR_IPFS_ADD_AUTH_2'), label: 'ipfs-2' }
    if (primary.url.replace(/\/+$/, '') === secondaryUrl.replace(/\/+$/, '')) {
      // The same endpoint twice would make the §8.2 agreement check vacuous
      // while looking like it ran. Two *URLs* differing is necessary, not
      // sufficient — point them at genuinely different implementations.
      throw new EnvError(
        'NNS_ANCHOR_IPFS_ADD_URL and NNS_ANCHOR_IPFS_ADD_URL_2 are the same endpoint — §8.2 requires two ' +
          'independent implementations, and one service asked twice agrees with itself by definition',
      )
    }
  } else {
    throw new EnvError(
      'the second §8.2 implementation is missing — set NNS_ANCHOR_FILEBASE_BUCKET (+ KEY, SECRET) for ' +
        'Filebase, or NNS_ANCHOR_IPFS_ADD_URL_2 for a second kubo-RPC endpoint',
    )
  }

  const publisherKey = read(env, 'NNS_ANCHOR_PUBLISHER_KEY')
  if (publisherKey !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(publisherKey)) {
    // Shape only, and the value never appears in the message.
    throw new EnvError('NNS_ANCHOR_PUBLISHER_KEY must be a 0x-prefixed 32-byte hex private key')
  }
  const publisherAddress = read(env, 'NNS_ANCHOR_PUBLISHER_ADDRESS')
  if (publisherAddress !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(publisherAddress)) {
    throw new EnvError('NNS_ANCHOR_PUBLISHER_ADDRESS must be a 0x-prefixed 20-byte hex address')
  }

  const minBalanceWei = requiredDecimalBigint(env, 'NNS_ANCHOR_MIN_BALANCE_WEI')

  const rawLookback = read(env, 'NNS_ANCHOR_LOOKBACK_BLOCKS')
  let lookbackBlocks = DEFAULT_LOOKBACK_BLOCKS
  if (rawLookback !== undefined) {
    if (!/^[0-9]+$/.test(rawLookback)) {
      throw new EnvError(`NNS_ANCHOR_LOOKBACK_BLOCKS must be a decimal integer, got ${JSON.stringify(rawLookback)}`)
    }
    lookbackBlocks = BigInt(rawLookback)
  }

  return {
    rpcUrl,
    chainId,
    contractAddress,
    apiUrl,
    ipfsPrimary: primary,
    ipfsSecondary: secondary,
    publisherKey,
    publisherAddress,
    minBalanceWei,
    lookbackBlocks,
  }
}

/** The publisher identity — same two-configuration shape as {@link Deployer}. */
export type PublisherIdentity =
  | { readonly kind: 'signing'; readonly key: string; readonly declaredAddress: string | undefined }
  | { readonly kind: 'planning'; readonly address: string }

export function requirePublisherIdentity(settings: PublisherSettings): PublisherIdentity {
  if (settings.publisherKey !== undefined) {
    return { kind: 'signing', key: settings.publisherKey, declaredAddress: settings.publisherAddress }
  }
  if (settings.publisherAddress !== undefined) {
    return { kind: 'planning', address: settings.publisherAddress }
  }
  throw new EnvError(
    'set NNS_ANCHOR_PUBLISHER_KEY to anchor, or NNS_ANCHOR_PUBLISHER_ADDRESS to dry-run without the key ' +
      '— see packages/anchor/.env.example',
  )
}

/** The key, or a usable error. Separate so a dry run can run without one. */
export function requirePublisherKey(settings: PublisherSettings): string {
  if (settings.publisherKey === undefined) {
    throw new EnvError('NNS_ANCHOR_PUBLISHER_KEY is required to send — see packages/anchor/.env.example')
  }
  return settings.publisherKey
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
