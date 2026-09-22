/**
 * The renewal schedule, from the state alone.
 *
 * Three messages per term (tasks/23, kept by 26): renewal is open, grace has
 * begun, last call before the name is anyone's. Every threshold is derived
 * from `CONSTANTS` here and typed nowhere, for the reason `a2a7ee2` exists: a
 * compressed era makes a typed "60 days" a lie.
 *
 * `RENEW_WINDOW` is the app's §10.4 reminder threshold (`lib/states.ts`),
 * restated rather than imported because `core` deliberately does not carry
 * it: it is client policy, not a rule, and this service is a client.
 */

import { CONSTANTS, formatAddress, type NnsState } from '@nimiqnames/core'

export const RENEW_WINDOW = 2 * CONSTANTS.GRACE_PERIOD
export const LAST_CALL_LEAD = Math.floor(CONSTANTS.GRACE_PERIOD / 4)

export type Milestone = 'renewal_open' | 'grace_begun' | 'last_call'

/**
 * Which message a name at `expiry` is due at `head`, or null: too early, or
 * already past grace. Only the latest one counts — an owner who subscribes
 * with five days of grace left gets the last call, not three messages.
 */
export function milestoneAt(expiry: number, head: number): Milestone | null {
  if (head >= expiry + CONSTANTS.GRACE_PERIOD) return null
  if (head >= expiry + CONSTANTS.GRACE_PERIOD - LAST_CALL_LEAD) return 'last_call'
  if (head >= expiry) return 'grace_begun'
  if (head >= expiry - RENEW_WINDOW) return 'renewal_open'
  return null
}

export interface RenewalDue {
  readonly milestone: Milestone
  readonly owner: string
  readonly name: string
  readonly expiry: number
}

/** Every name with a milestone due at `head`. A lifetime name is a century away and never appears. */
export function renewalsDue(state: NnsState, head: number): RenewalDue[] {
  const due: RenewalDue[] = []
  for (const record of state.names.values()) {
    const milestone = milestoneAt(record.expiry, head)
    if (milestone === null) continue
    due.push({ milestone, owner: formatAddress(record.owner), name: record.name, expiry: record.expiry })
  }
  return due
}
