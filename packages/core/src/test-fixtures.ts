/**
 * Shared test fixtures. Excluded from the build (see `tsconfig.json`) — this
 * file must never reach `dist`.
 *
 * The four role aliases point at the frozen §3 constants since the launch
 * freeze — the reducer routes by those literals, so a test that sent to an
 * arbitrary fixture address would earn `WRONG_RECIPIENT` and test nothing.
 */

import { parseAddress } from './address.js'
import { defineConfig, type NnsConfig, type NnsConfigInput } from './config.js'
import { CONSTANTS } from './constants.js'

export const TREASURY = CONSTANTS.TREASURY_ADDRESS
export const PROTOCOL = CONSTANTS.PROTOCOL_ADDRESS
export const ADMIN = CONSTANTS.ADMIN_ADDRESS
export const MARKETPLACE = CONSTANTS.MARKETPLACE_ADDRESS

/** Ordinary user addresses, for owners, targets and counterparties. */
export const ALICE = parseAddress('NQ57 B9KP 90CE KELB BGNF TKLY C0QG 3LM3 EH2H')
export const BOB = parseAddress('NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK')
export const CAROL = parseAddress('NQ19 KSMT HHEJ TYNF J1GK 40NK LHSL C5P7 P24M')

/** Nimiq mainnet. */
export const MAINNET_ID = 24

export const testConfigInput = (overrides: Partial<NnsConfigInput> = {}): NnsConfigInput => ({
  networkId: MAINNET_ID,
  ...overrides,
})

export const testConfig = (overrides: Partial<NnsConfigInput> = {}): NnsConfig =>
  defineConfig(testConfigInput(overrides))
