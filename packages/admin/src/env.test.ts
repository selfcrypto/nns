import { describe, expect, it } from 'vitest'

import { EnvError, loadSettings, type EnvSource } from './env.js'

const FULL: EnvSource = {
  NNS_RPC_URL: 'http://127.0.0.1:6488',
  NNS_RPC_USER: 'admin',
  NNS_RPC_PASSWORD: 'hunter2',
}

describe('loadSettings', () => {
  it('loads a full environment', () => {
    const settings = loadSettings(FULL)
    expect(settings.rpcUrl).toBe('http://127.0.0.1:6488')
    expect(settings.rpcUser).toBe('admin')
    expect(Object.isFrozen(settings)).toBe(true)
  })

  it('assembles the URL from host and port when NNS_RPC_URL is absent', () => {
    const { NNS_RPC_URL: _omitted, ...rest } = FULL
    const settings = loadSettings({ ...rest, NNS_RPC_HOST: '10.0.0.5', NNS_RPC_PORT: '6488' })
    expect(settings.rpcUrl).toBe('http://10.0.0.5:6488')
  })

  it('has no variable for a frozen §3 value or a network id, so an operator cannot set one', () => {
    // The freeze deleted NNS_LAUNCH_HEIGHT and the four address vars; the
    // 2026-09-02 dedupe deleted NNS_NETWORK_ID, which nothing read. Setting
    // any of them is inert rather than honoured.
    const settings = loadSettings({ ...FULL, NNS_ADMIN_ADDRESS: 'NQ00 NOT A REAL ADDRESS', NNS_NETWORK_ID: '1.5' })
    expect(Object.keys(settings).sort()).toEqual(['apiUrl', 'rpcPassword', 'rpcUrl', 'rpcUser'])
  })

  it('reports a missing RPC URL by variable name, as an EnvError', () => {
    expect(() => loadSettings({})).toThrow(EnvError)
    expect(() => loadSettings({})).toThrow(/NNS_RPC_URL/)
  })

  it('leaves NNS_API_URL unset rather than failing — each command demands it on entry', () => {
    expect(loadSettings(FULL).apiUrl).toBeUndefined()
    expect(loadSettings({ ...FULL, NNS_API_URL: 'http://127.0.0.1:8080' }).apiUrl).toBe('http://127.0.0.1:8080')
  })

  it('rejects an NNS_API_URL that is not a URL, at startup', () => {
    expect(() => loadSettings({ ...FULL, NNS_API_URL: 'not a url' })).toThrow(/NNS_API_URL/)
  })
})
