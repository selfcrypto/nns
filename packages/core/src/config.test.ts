import { describe, expect, it } from 'vitest'
import { ConfigError, defineConfig } from './config.js'
import { testConfigInput } from './test-fixtures.js'

describe('defineConfig', () => {
  it('validates and freezes', () => {
    const config = defineConfig(testConfigInput())
    expect(config.networkId).toBe(24)
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('rejects a negative or non-integer networkId', () => {
    expect(() => defineConfig(testConfigInput({ networkId: -1 }))).toThrow(ConfigError)
    expect(() => defineConfig(testConfigInput({ networkId: 1.5 }))).toThrow(ConfigError)
  })
})
