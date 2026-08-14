import { describe, expect, it } from 'vitest'

import { MARKETPLACE, TREASURY, testAddress } from './test-fixtures.js'
import { loadSettings } from './env.js'

const BASE = {
  NNS_API_URL: 'http://api.test/',
  NNS_NETWORK_ID: '5',
  NNS_LAUNCH_HEIGHT: '58177000',
  NNS_TREASURY_ADDRESS: TREASURY,
  NNS_PROTOCOL_ADDRESS: testAddress(2),
  NNS_ADMIN_ADDRESS: testAddress(3),
  NNS_MARKETPLACE_ADDRESS: MARKETPLACE,
  NNS_LISTING_FEE: '100000',
  NNS_RESERVED_NAMES: 'binance, kraken',
} as const

describe('loadSettings', () => {
  it('builds a validated config and strips the trailing slash from the API URL', () => {
    const settings = loadSettings(BASE)
    expect(settings.apiUrl).toBe('http://api.test')
    expect(settings.config.launchHeight).toBe(58_177_000)
    expect(settings.config.marketplace).toBe(MARKETPLACE)
    expect([...settings.config.reservedNames]).toEqual(['binance', 'kraken'])
  })

  it('has no database and no key to load — the independence is structural', () => {
    const settings = loadSettings({ ...BASE, NNS_DATABASE_URL: 'postgres://nope', NNS_SETTLEMENT_KEY: 'nope' })
    expect(Object.keys(settings).sort()).toEqual(['apiUrl', 'config'])
    expect(Object.values(settings)).not.toContain('postgres://nope')
  })

  it('requires the API URL, and requires it to be one', () => {
    expect(() => loadSettings({ ...BASE, NNS_API_URL: undefined })).toThrow(/NNS_API_URL is required/)
    expect(() => loadSettings({ ...BASE, NNS_API_URL: 'not a url' })).toThrow(/not a valid URL/)
  })

  it('rejects a listing fee written in NIM', () => {
    expect(() => loadSettings({ ...BASE, NNS_LISTING_FEE: '1.5' })).toThrow(/whole number of luna/)
  })

  it('rejects a launch height that is not an integer', () => {
    expect(() => loadSettings({ ...BASE, NNS_LAUNCH_HEIGHT: '58177000.5' })).toThrow(/must be an integer/)
  })

  it('reports a bad address through EnvError rather than core’s own error', () => {
    expect(() => loadSettings({ ...BASE, NNS_TREASURY_ADDRESS: 'NQ00 NOPE' })).toThrow(
      expect.objectContaining({ name: 'EnvError' }),
    )
  })

  it('an unset reserved list is empty, not absent', () => {
    const settings = loadSettings({ ...BASE, NNS_RESERVED_NAMES: undefined })
    expect([...settings.config.reservedNames]).toEqual([])
  })
})
