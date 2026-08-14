/**
 * Deployment configuration — what is left of it: `networkId`, alone.
 *
 * Mainnet and testnet honestly differ, so two honest deployments may
 * legitimately disagree about it; that is the test for configuration, and
 * nothing else passed it. `LAUNCH_HEIGHT` and the four §3 addresses moved to
 * `constants.ts` at the launch freeze's second half (2026-08-14), following
 * `RESERVED_NAMES` and the `O` listing fee — an injected consensus input is a
 * silent-divergence surface, and none of the five §3 values was one two
 * honest deployments could differ on.
 */

export interface NnsConfig {
  /** Guards against a node fed by a different network (§7.5). */
  readonly networkId: number
}

export interface NnsConfigInput {
  networkId: number
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

/**
 * Validate and freeze a deployment config.
 *
 * Kept as a function, not ceremony: the check runs at startup rather than at
 * the §7.5 filter, which is where a malformed value would otherwise first
 * bite.
 */
export function defineConfig(input: NnsConfigInput): NnsConfig {
  if (!Number.isInteger(input.networkId) || input.networkId < 0) {
    throw new ConfigError('networkId must be a non-negative integer')
  }
  return Object.freeze({ networkId: input.networkId })
}
