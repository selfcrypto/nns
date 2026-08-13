/**
 * Deployment configuration — the §3 constants that are still **OPEN**.
 *
 * `LAUNCH_HEIGHT`, `TREASURY_ADDRESS`, `PROTOCOL_ADDRESS`, `ADMIN_ADDRESS` and
 * `MARKETPLACE_ADDRESS` have no settled values yet, and `RESERVED_NAMES` is a
 * versioned list published in the repo before launch (§4.1). Injecting them
 * keeps core pure and fully testable with fixture addresses, and makes it
 * impossible for a placeholder to survive quietly into a mainnet build.
 *
 * The `O` listing fee is also OPEN (§6 `O`, §10.6), so it lives here too.
 */

import { type Address, parseAddress } from './address.js'
import { isProfileName, type ProfileName } from './constants.js'

export interface NnsConfig {
  /**
   * Constants profile the deployment runs under — see `PROFILES` in
   * {@link ./constants.ts | constants.ts}. Always resolved here: `mainnet`
   * unless the input selected something else explicitly, in which case
   * {@link defineConfig} has already warned loudly that the resulting roots
   * are not mainnet roots.
   */
  readonly profile: ProfileName
  /** Guards against a node fed by a different network (§7.5). */
  readonly networkId: number
  /** Indexers start here, not at genesis (§3, §7.2). */
  readonly launchHeight: number
  /** Receives fees — and only fees (§5.3). */
  readonly treasury: Address
  /** Receives dust-only signalling, and acts as the §5.3 sentinel. */
  readonly protocol: Address
  /** Governance only; cold key, distinct from the treasury (§10.6). */
  readonly admin: Address
  /** `B` escrow and `M` settlement; the only NNS hot wallet (§3). */
  readonly marketplace: Address
  /** Listing fee for `O`. Still **OPEN** in the spec. */
  readonly listingFee: bigint
  /** §4.1 rule 6. Lowercase, exact-match. */
  readonly reservedNames: ReadonlySet<string>
}

export interface NnsConfigInput {
  /** Omitted means `mainnet`. Anything else is a deliberate, warned-about act. */
  profile?: ProfileName
  networkId: number
  launchHeight: number
  treasury: string
  protocol: string
  admin: string
  marketplace: string
  listingFee: bigint
  reservedNames?: Iterable<string>
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

// The build tsconfig deliberately loads no runtime type library — `core` is
// pure, and an undeclared global turning up is a compile error, which is the
// point. `defineConfig`'s warning is the one sanctioned exception, so exactly
// the method it uses is declared here rather than pulling in all of node's
// globals. Every runtime this package supports provides it.
declare const console: { warn(message: string): void }

function address(field: string, value: string): Address {
  try {
    return parseAddress(value)
  } catch (cause) {
    throw new ConfigError(`${field}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/**
 * Validate and freeze a deployment config.
 *
 * Everything checkable is checked here rather than at the point of use, so a
 * malformed address fails at startup instead of at the first Merkle root —
 * which is exactly where a silent divergence would otherwise begin.
 */
export function defineConfig(input: NnsConfigInput): NnsConfig {
  const profile = input.profile ?? 'mainnet'
  // Runtime-checked despite the type: profiles arrive from env vars and JSON,
  // where a cast is one `as` away.
  if (!isProfileName(profile)) {
    throw new ConfigError(`unknown constants profile ${JSON.stringify(profile)} — expected "mainnet" or "fast"`)
  }
  if (profile !== 'mainnet') {
    // Deliberately the one write to stderr in this package. It feeds no state,
    // no root and no log hash — it exists so a process quietly pointed at a
    // non-mainnet profile cannot start silently. Runs once, at config time,
    // which is startup for every consumer.
    console.warn(
      `[nns] ⚠ constants profile "${profile}": waiting periods ÷1000, fee bands ÷100.\n` +
        `[nns] ⚠ This is NOT the mainnet protocol. Nothing in a checkpoint marks the profile,\n` +
        `[nns] ⚠ so keep its database separate and never quote its roots as a baseline.`,
    )
  }
  if (!Number.isInteger(input.networkId) || input.networkId < 0) {
    throw new ConfigError('networkId must be a non-negative integer')
  }
  if (!Number.isInteger(input.launchHeight) || input.launchHeight < 0) {
    throw new ConfigError('launchHeight must be a non-negative integer')
  }
  if (input.listingFee < 0n) throw new ConfigError('listingFee must not be negative')

  const treasury = address('treasury', input.treasury)
  const protocol = address('protocol', input.protocol)
  const admin = address('admin', input.admin)
  const marketplace = address('marketplace', input.marketplace)

  // §3 and §10.6 require all four to be distinct: the treasury/protocol split
  // is what makes the burn base exact, the admin key is cold while the
  // treasury is hot, and the marketplace is "distinct from both".
  const roles = { treasury, protocol, admin, marketplace }
  const seen = new Map<string, string>()
  for (const [role, value] of Object.entries(roles)) {
    const previous = seen.get(value)
    if (previous !== undefined) {
      throw new ConfigError(`${role} and ${previous} must be distinct addresses (§3, §10.6)`)
    }
    seen.set(value, role)
  }

  const reservedNames = new Set<string>()
  for (const name of input.reservedNames ?? []) {
    if (name !== name.toLowerCase()) {
      throw new ConfigError(`reservedNames entry ${JSON.stringify(name)} must be lowercase — §4.1 matches exactly and never normalises`)
    }
    reservedNames.add(name)
  }

  return Object.freeze({
    profile,
    networkId: input.networkId,
    launchHeight: input.launchHeight,
    treasury,
    protocol,
    admin,
    marketplace,
    listingFee: input.listingFee,
    reservedNames: reservedNames as ReadonlySet<string>,
  })
}
