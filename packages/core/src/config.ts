/**
 * Deployment configuration — what is left of it.
 *
 * `networkId` is the only entry here that is configuration on the merits:
 * mainnet and testnet honestly differ, so two honest deployments may
 * legitimately disagree about it. Everything else in this file is a §3 value
 * that is still **OPEN** — `LAUNCH_HEIGHT`, `TREASURY_ADDRESS`,
 * `PROTOCOL_ADDRESS`, `ADMIN_ADDRESS`, `MARKETPLACE_ADDRESS` — and is injected
 * only because it has no value yet. Injection keeps core pure and testable
 * against fixture addresses, and makes it impossible for a placeholder to
 * survive quietly into a mainnet build.
 *
 * **These five move to `constants.ts` the moment the operator supplies them**,
 * and this file then holds `networkId` alone. `RESERVED_NAMES` and the `O`
 * listing fee took that route already, at the launch freeze.
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
}

export interface NnsConfigInput {
  networkId: number
  launchHeight: number
  treasury: string
  protocol: string
  admin: string
  marketplace: string
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

  return Object.freeze({
    networkId: input.networkId,
    launchHeight: input.launchHeight,
    treasury,
    protocol,
    admin,
    marketplace,
  })
}
