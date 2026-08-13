import { describe, expect, it } from 'vitest'
import { ConfigError, defineConfig } from './config.js'
import { PROTOCOL, TREASURY, testConfigInput } from './test-fixtures.js'

describe('defineConfig', () => {
  it('parses, validates and freezes', () => {
    const config = defineConfig(testConfigInput())
    expect(config.treasury).toBe('NQ8224C1X9HD6GVL4JAGAVF6AT3KFA0QH3UN')
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('defaults reservedNames to empty', () => {
    expect(defineConfig(testConfigInput()).reservedNames.size).toBe(0)
  })

  it('names the offending field when an address is malformed', () => {
    expect(() => defineConfig(testConfigInput({ admin: 'NQ00 NOPE' }))).toThrow(/^admin: /)
  })

  it('rejects two roles sharing an address (§3, §10.6)', () => {
    expect(() => defineConfig(testConfigInput({ admin: TREASURY }))).toThrow(
      /admin and treasury must be distinct/,
    )
    expect(() => defineConfig(testConfigInput({ marketplace: PROTOCOL }))).toThrow(ConfigError)
  })

  it('rejects an uppercase reserved name, because §4.1 never normalises', () => {
    expect(() => defineConfig(testConfigInput({ reservedNames: ['Nimiq'] }))).toThrow(/must be lowercase/)
  })

  it('rejects a negative or non-integer height', () => {
    expect(() => defineConfig(testConfigInput({ launchHeight: -1 }))).toThrow(ConfigError)
    expect(() => defineConfig(testConfigInput({ launchHeight: 1.5 }))).toThrow(ConfigError)
  })

  it('rejects a negative listing fee', () => {
    expect(() => defineConfig(testConfigInput({ listingFee: -1n }))).toThrow(ConfigError)
  })
})
