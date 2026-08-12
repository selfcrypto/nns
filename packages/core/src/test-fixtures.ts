/**
 * Shared test fixtures. Excluded from the build (see `tsconfig.json`) — this
 * file must never reach `dist`.
 *
 * The four role addresses are deliberately arbitrary: the real §3 values are
 * still **OPEN**, and nothing in core may depend on their identity. They were
 * generated from fixed byte seeds through `addressFromBytes`, so their
 * checksums are genuine and `parseAddress` accepts them.
 */

import { parseAddress } from './address.js'
import { defineConfig, type NnsConfig, type NnsConfigInput } from './config.js'

export const TREASURY = parseAddress('NQ82 24C1 X9HD 6GVL 4JAG AVF6 AT3K FA0Q H3UN')
export const PROTOCOL = parseAddress('NQ07 48LK 0DRX 8M65 6NK1 D1PP CYC4 HE99 K857')
export const ADMIN = parseAddress('NQ67 6CV4 2J2F AREN 8STJ F608 F3LM KJHS MCDQ')
export const MARKETPLACE = parseAddress('NQ28 8H5M 4NB0 CVP7 AY43 HA8R H7V6 MNSB PGN9')

/** Ordinary user addresses, for owners, targets and counterparties. */
export const ALICE = parseAddress('NQ57 B9KP 90CE KELB BGNF TKLY C0QG 3LM3 EH2H')
export const BOB = parseAddress('NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK')
export const CAROL = parseAddress('NQ19 KSMT HHEJ TYNF J1GK 40NK LHSL C5P7 P24M')

/** Nimiq mainnet. */
export const MAINNET_ID = 24

export const testConfigInput = (overrides: Partial<NnsConfigInput> = {}): NnsConfigInput => ({
  networkId: MAINNET_ID,
  launchHeight: 58_000_000,
  treasury: TREASURY,
  protocol: PROTOCOL,
  admin: ADMIN,
  marketplace: MARKETPLACE,
  listingFee: 0n,
  ...overrides,
})

export const testConfig = (overrides: Partial<NnsConfigInput> = {}): NnsConfig =>
  defineConfig(testConfigInput(overrides))
