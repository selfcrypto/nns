import { describe, expect, it } from 'vitest'

import { EnvError, loadSettings } from './env.js'

const MINIMAL = {
  NNS_RPC_URL: 'http://127.0.0.1:6488',
  NNS_NETWORK_ID: '24',
  NNS_DATABASE_URL: 'postgres://nns@localhost:5432/nns',
}

describe('loadSettings', () => {
  it('reads the minimal set', () => {
    const settings = loadSettings(MINIMAL)
    expect(settings).toMatchObject({
      rpcUrl: 'http://127.0.0.1:6488',
      networkId: 24,
      rpcUser: undefined,
      logLevel: 'info',
    })
  })

  it('assembles the URL from host and port', () => {
    expect(loadSettings({ ...MINIMAL, NNS_RPC_URL: '', NNS_RPC_HOST: '10.0.0.4', NNS_RPC_PORT: '6488' }).rpcUrl).toBe(
      'http://10.0.0.4:6488',
    )
    expect(
      loadSettings({ ...MINIMAL, NNS_RPC_URL: undefined, NNS_RPC_HOST: 'node', NNS_RPC_PORT: '443', NNS_RPC_SCHEME: 'https' })
        .rpcUrl,
    ).toBe('https://node:443')
  })

  it('treats blank as absent', () => {
    expect(loadSettings({ ...MINIMAL, NNS_RPC_USER: '   ' }).rpcUser).toBeUndefined()
    expect(loadSettings({ ...MINIMAL, NNS_RPC_USER: ' nns ' }).rpcUser).toBe('nns')
  })

  it('demands the values that have no safe default', () => {
    const without = (key: string) => () => loadSettings({ ...MINIMAL, [key]: undefined })
    expect(without('NNS_RPC_URL')).toThrow(/NNS_RPC_URL/)
    expect(without('NNS_NETWORK_ID')).toThrow(/NNS_NETWORK_ID/)
    expect(without('NNS_DATABASE_URL')).toThrow(/NNS_DATABASE_URL/)
  })

  it('hands core the networkId and lets it validate it', () => {
    expect(loadSettings(MINIMAL).config.networkId).toBe(24)
  })

  it('has no variable for a frozen §3 value, so an operator cannot set one', () => {
    // The launch freeze deleted NNS_RESERVED_NAMES and NNS_LISTING_FEE, and
    // its second half deleted NNS_LAUNCH_HEIGHT and the four address vars. An
    // env var that still existed is one an operator could still set, which is
    // the whole silent-divergence surface the freeze closed — so setting them
    // is inert rather than honoured.
    const settings = loadSettings({
      ...MINIMAL,
      NNS_RESERVED_NAMES: 'nimiq, wallet',
      NNS_LISTING_FEE: '100000',
      NNS_LAUNCH_HEIGHT: '1',
      NNS_TREASURY_ADDRESS: 'NQ34 248H 248H 248H 248H 248H 248H 248H 248H',
      NNS_PROTOCOL_ADDRESS: 'NQ93 48H2 48H2 48H2 48H2 48H2 48H2 48H2 48H2',
      NNS_ADMIN_ADDRESS: 'NQ60 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK',
      NNS_MARKETPLACE_ADDRESS: 'NQ14 8H24 8H24 8H24 8H24 8H24 8H24 8H24 8H24',
    })
    expect(Object.keys(settings.config)).toEqual(['networkId'])
  })

  it('rejects a non-integer networkId instead of scanning from NaN', () => {
    expect(() => loadSettings({ ...MINIMAL, NNS_NETWORK_ID: '2_4' })).toThrow(EnvError)
    expect(() => loadSettings({ ...MINIMAL, NNS_NETWORK_ID: '1.5' })).toThrow(/integer/)
    expect(() => loadSettings({ ...MINIMAL, NNS_NETWORK_ID: '-1' })).toThrow(/integer/)
  })

  it('rejects a malformed URL', () => {
    expect(() => loadSettings({ ...MINIMAL, NNS_RPC_URL: '127.0.0.1:6488' })).toThrow(/not a valid URL/)
  })

  it('validates the log level', () => {
    expect(loadSettings({ ...MINIMAL, NNS_LOG_LEVEL: 'debug' }).logLevel).toBe('debug')
    expect(() => loadSettings({ ...MINIMAL, NNS_LOG_LEVEL: 'verbose' })).toThrow(/debug\|info\|warn\|error/)
  })

  it('applies the tuning defaults', () => {
    const settings = loadSettings(MINIMAL)
    expect(settings.rpcTimeoutMs).toBe(30_000)
    expect(settings.rpcAttempts).toBe(4)
    expect(settings.pollIntervalMs).toBe(15_000)
  })
})
