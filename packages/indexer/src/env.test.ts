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

describe('NNS_START_MODE', () => {
  // The mode is `.env`, not a flag, because this process runs under compose
  // and every value a role needs lives in that role's `.env`
  // (`deploy/README.md`). A flag would need an env var to carry it anyway —
  // which is exactly what `NNS_ANCHOR_SEND=--send` already is.

  it('defaults to scratch — the mode that derives everything from the chain', () => {
    expect(loadSettings(MINIMAL).startMode).toBe('scratch')
    expect(loadSettings(MINIMAL).snapshotUrl).toBeUndefined()
  })

  it('accepts the three modes and refuses anything else by name', () => {
    for (const mode of ['scratch', 'snapshot', 'hybrid']) {
      const env = { ...MINIMAL, NNS_START_MODE: mode, NNS_SNAPSHOT_URL: 'https://peer.example.com' }
      expect(loadSettings(env).startMode).toBe(mode)
    }
    expect(() => loadSettings({ ...MINIMAL, NNS_START_MODE: 'fast' })).toThrow(EnvError)
    expect(() => loadSettings({ ...MINIMAL, NNS_START_MODE: 'fast' })).toThrow(/scratch\|snapshot\|hybrid/)
  })

  it('refuses snapshot and hybrid with no source — there is nothing to download from', () => {
    for (const mode of ['snapshot', 'hybrid']) {
      expect(() => loadSettings({ ...MINIMAL, NNS_START_MODE: mode })).toThrow(/NNS_SNAPSHOT_URL/)
    }
  })

  it('refuses a source that is not a URL', () => {
    expect(() =>
      loadSettings({ ...MINIMAL, NNS_START_MODE: 'snapshot', NNS_SNAPSHOT_URL: 'peer.example.com' }),
    ).toThrow(/not a valid URL/)
  })

  it('ignores a source scratch will never read, rather than refusing it', () => {
    // An operator who bootstrapped once and set the mode back should not have
    // to also delete the URL to start the indexer.
    const settings = loadSettings({ ...MINIMAL, NNS_SNAPSHOT_URL: 'https://peer.example.com' })
    expect(settings.startMode).toBe('scratch')
    expect(settings.snapshotUrl).toBe('https://peer.example.com')
  })
})

