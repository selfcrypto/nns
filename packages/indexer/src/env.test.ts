import { describe, expect, it } from 'vitest'

import { EnvError, loadSettings } from './env.js'

const MINIMAL = {
  NNS_RPC_URL: 'http://127.0.0.1:6488',
  NNS_NETWORK_ID: '24',
  NNS_LAUNCH_HEIGHT: '58200000',
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
    expect(() => loadSettings({ NNS_NETWORK_ID: '24', NNS_LAUNCH_HEIGHT: '1' })).toThrow(/NNS_RPC_URL/)
    expect(() => loadSettings({ NNS_RPC_URL: 'http://x', NNS_LAUNCH_HEIGHT: '1' })).toThrow(/NNS_NETWORK_ID/)
    expect(() => loadSettings({ NNS_RPC_URL: 'http://x', NNS_NETWORK_ID: '24' })).toThrow(/NNS_LAUNCH_HEIGHT/)
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
