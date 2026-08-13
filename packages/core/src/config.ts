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

export interface NnsConfig {
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
