import { describe, expect, it, vi } from 'vitest'

import { EnvError, loadSettings } from './env.js'

const MINIMAL = {
  NNS_RPC_URL: 'http://127.0.0.1:6488',
  NNS_NETWORK_ID: '24',
  NNS_LAUNCH_HEIGHT: '58200000',
  NNS_DATABASE_URL: 'postgres://nns@localhost:5432/nns',
  // The four §3 addresses, still OPEN in the spec and therefore injected.
  // `defineConfig` requires them to parse and to be distinct.
  NNS_TREASURY_ADDRESS: 'NQ34 248H 248H 248H 248H 248H 248H 248H 248H',
  NNS_PROTOCOL_ADDRESS: 'NQ93 48H2 48H2 48H2 48H2 48H2 48H2 48H2 48H2',
  NNS_ADMIN_ADDRESS: 'NQ60 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK 6CRK',
  NNS_MARKETPLACE_ADDRESS: 'NQ14 8H24 8H24 8H24 8H24 8H24 8H24 8H24 8H24',
}

describe('loadSettings', () => {
  it('reads the minimal set', () => {
    const settings = loadSettings(MINIMAL)
    expect(settings).toMatchObject({
      rpcUrl: 'http://127.0.0.1:6488',
      networkId: 24,
      launchHeight: 58_200_000,
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
    expect(without('NNS_LAUNCH_HEIGHT')).toThrow(/NNS_LAUNCH_HEIGHT/)
    expect(without('NNS_DATABASE_URL')).toThrow(/NNS_DATABASE_URL/)
    expect(without('NNS_TREASURY_ADDRESS')).toThrow(/NNS_TREASURY_ADDRESS/)
  })

  it('defaults the constants profile to mainnet, silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(loadSettings(MINIMAL).config.profile).toBe('mainnet')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('reads NNS_PROFILE, with core validating the name and warning loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(loadSettings({ ...MINIMAL, NNS_PROFILE: 'fast' }).config.profile).toBe('fast')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
    // Garbage is defineConfig's runtime check surfacing as an EnvError — the
    // whole point of forwarding raw rather than validating here.
    expect(() => loadSettings({ ...MINIMAL, NNS_PROFILE: 'devnet' })).toThrow(EnvError)
    expect(() => loadSettings({ ...MINIMAL, NNS_PROFILE: 'devnet' })).toThrow(/unknown constants profile/)
  })

  it('hands core the §3 values and lets it validate them', () => {
    const settings = loadSettings({ ...MINIMAL, NNS_LISTING_FEE: '100000', NNS_RESERVED_NAMES: 'nimiq, wallet' })
    expect(settings.config.listingFee).toBe(100_000n)
    expect([...settings.config.reservedNames].sort()).toEqual(['nimiq', 'wallet'])
    expect(settings.config.launchHeight).toBe(58_200_000)
  })

  it('surfaces core’s own config errors', () => {
    // All four addresses must be distinct (§3, §10.6). core decides that;
    // this only checks the message reaches the operator.
    expect(() => loadSettings({ ...MINIMAL, NNS_ADMIN_ADDRESS: MINIMAL.NNS_TREASURY_ADDRESS })).toThrow(
      /must be distinct/,
    )
    expect(() => loadSettings({ ...MINIMAL, NNS_LISTING_FEE: '1.5' })).toThrow(/whole number of luna/)
  })

  it('rejects a non-integer height instead of scanning from NaN', () => {
    expect(() => loadSettings({ ...MINIMAL, NNS_LAUNCH_HEIGHT: '58_200_000' })).toThrow(EnvError)
    expect(() => loadSettings({ ...MINIMAL, NNS_LAUNCH_HEIGHT: '1.5' })).toThrow(/integer/)
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
