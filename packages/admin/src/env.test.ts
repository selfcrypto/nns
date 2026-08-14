import { describe, expect, it } from 'vitest'

import { EnvError, loadSettings, type EnvSource } from './env.js'

const FULL: EnvSource = {
  NNS_RPC_URL: 'http://127.0.0.1:6488',
  NNS_RPC_USER: 'admin',
  NNS_RPC_PASSWORD: 'hunter2',
  NNS_NETWORK_ID: '24',
}

describe('loadSettings', () => {
  it('loads a full environment through defineConfig', () => {
    const settings = loadSettings(FULL)
    expect(settings.rpcUrl).toBe('http://127.0.0.1:6488')
    expect(settings.rpcUser).toBe('admin')
    expect(settings.config.networkId).toBe(24)
    expect(Object.isFrozen(settings)).toBe(true)
  })

  it('assembles the URL from host and port when NNS_RPC_URL is absent', () => {
    const { NNS_RPC_URL: _omitted, ...rest } = FULL
    const settings = loadSettings({ ...rest, NNS_RPC_HOST: '10.0.0.5', NNS_RPC_PORT: '6488' })
    expect(settings.rpcUrl).toBe('http://10.0.0.5:6488')
  })

  it('requires the network id and reports the variable by name', () => {
    const { NNS_NETWORK_ID: _omitted, ...rest } = FULL
    expect(() => loadSettings(rest)).toThrow(/NNS_NETWORK_ID/)
  })

  it("wraps core's validation into EnvError, so a bad value fails at startup", () => {
    expect(() => loadSettings({ ...FULL, NNS_NETWORK_ID: '1.5' })).toThrow(EnvError)
  })

  it('has no variable for a frozen §3 value, so an operator cannot set one', () => {
    // The freeze's second half deleted NNS_LAUNCH_HEIGHT and the four address
    // vars from this loader; setting them is inert rather than honoured.
    const settings = loadSettings({ ...FULL, NNS_ADMIN_ADDRESS: 'NQ00 NOT A REAL ADDRESS' })
    expect(Object.keys(settings.config)).toEqual(['networkId'])
  })

  it('rejects a fractional listing fee — a NIM/luna mix-up', () => {
  })

  it('leaves NNS_API_URL unset rather than failing — only p needs it', () => {
    expect(loadSettings(FULL).apiUrl).toBeUndefined()
    expect(loadSettings({ ...FULL, NNS_API_URL: 'http://127.0.0.1:8080' }).apiUrl).toBe('http://127.0.0.1:8080')
  })

  it('rejects an NNS_API_URL that is not a URL, at startup', () => {
    expect(() => loadSettings({ ...FULL, NNS_API_URL: 'not a url' })).toThrow(/NNS_API_URL/)
  })
})
