import { describe, expect, it } from 'vitest'

import { CONSTANTS } from '@nns/core'

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

describe('NNS_SNAPSHOT_SOURCE', () => {
  const ANCHOR = {
    ...MINIMAL,
    NNS_START_MODE: 'snapshot',
    NNS_SNAPSHOT_SOURCE: 'anchor',
    NNS_SNAPSHOT_URL: 'https://gw.example.com',
    NNS_SNAPSHOT_ANCHOR_RPC: 'https://rpc-a.example.com, https://rpc-b.example.com',
    NNS_SNAPSHOT_ANCHOR_CONTRACT: '0xef503a681c490ccb65090b7e9f6df734d9f7eaeb',
    NNS_SNAPSHOT_ANCHOR_PUBLISHERS: '0x2efd3f0e5608bb9e2e7027a1f73485b82e8093c6',
  }

  it('defaults to peer', () => {
    expect(loadSettings(MINIMAL).snapshotSource).toBe('peer')
  })

  it('reads the anchor set, trimming the comma-separated lists', () => {
    const settings = loadSettings(ANCHOR)
    expect(settings.snapshotSource).toBe('anchor')
    expect(settings.anchorRpcUrls).toEqual(['https://rpc-a.example.com', 'https://rpc-b.example.com'])
    expect(settings.anchorPublishers).toEqual(['0x2efd3f0e5608bb9e2e7027a1f73485b82e8093c6'])
    expect(settings.anchorQuorum).toBe(CONSTANTS.ANCHOR_QUORUM)
  })

  it('refuses a single endpoint — §9 says one is not a cross-check', () => {
    expect(() => loadSettings({ ...ANCHOR, NNS_SNAPSHOT_ANCHOR_RPC: 'https://only.example.com' })).toThrow(
      /at least two independent endpoints/,
    )
  })

  it('refuses an empty publisher list rather than treating it as permissive', () => {
    // §8.5 #1: an unlisted publisher is ignored, never counted — so no list is
    // no check, and the failure would otherwise be silent agreement.
    expect(() => loadSettings({ ...ANCHOR, NNS_SNAPSHOT_ANCHOR_PUBLISHERS: '' })).toThrow(
      /NNS_SNAPSHOT_ANCHOR_PUBLISHERS/,
    )
  })

  it('refuses addresses that are not 20 bytes', () => {
    expect(() => loadSettings({ ...ANCHOR, NNS_SNAPSHOT_ANCHOR_CONTRACT: '0xdeadbeef' })).toThrow(/20-byte/)
    expect(() => loadSettings({ ...ANCHOR, NNS_SNAPSHOT_ANCHOR_PUBLISHERS: 'alice' })).toThrow(/20-byte/)
  })

  it('takes a deliberately lowered quorum, and refuses zero', () => {
    expect(loadSettings({ ...ANCHOR, NNS_SNAPSHOT_ANCHOR_QUORUM: '1' }).anchorQuorum).toBe(1)
    expect(() => loadSettings({ ...ANCHOR, NNS_SNAPSHOT_ANCHOR_QUORUM: '0' })).toThrow(/>= 1/)
  })

  it('takes a lookback override, because the reader default exceeds public caps', () => {
    // publicnode's Sepolia caps eth_getLogs at 50,000 blocks and errors above
    // it; DEFAULT_READER_LOOKBACK_BLOCKS is 250,000. Measured, not assumed.
    expect(loadSettings({ ...ANCHOR, NNS_SNAPSHOT_ANCHOR_LOOKBACK: '45000' }).anchorLookbackBlocks).toBe(45_000n)
    expect(loadSettings(ANCHOR).anchorLookbackBlocks).toBeUndefined()
    expect(() => loadSettings({ ...ANCHOR, NNS_SNAPSHOT_ANCHOR_LOOKBACK: '-1' })).toThrow(/positive integer/)
  })

  it('accepts a {cid} template as the gateway', () => {
    expect(
      loadSettings({ ...ANCHOR, NNS_SNAPSHOT_URL: 'https://{cid}.ipfs.dweb.link' }).snapshotUrl,
    ).toBe('https://{cid}.ipfs.dweb.link')
  })

  it('checks none of it while the mode is scratch', () => {
    // The anchor set describes a bootstrap. A scratch indexer never performs
    // one, and refusing to start over a half-filled block an operator is still
    // writing would be a refusal about nothing.
    expect(() =>
      loadSettings({ ...ANCHOR, NNS_START_MODE: undefined, NNS_SNAPSHOT_ANCHOR_PUBLISHERS: '' }),
    ).not.toThrow()
  })

  it('refuses an unknown source by name', () => {
    expect(() => loadSettings({ ...MINIMAL, NNS_SNAPSHOT_SOURCE: 'ipfs' })).toThrow(/peer\|anchor/)
  })
})

