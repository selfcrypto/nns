import { describe, expect, it } from 'vitest'

import { EnvError, loadSettings, type EnvSource } from './env.js'

const FULL: EnvSource = {
  NNS_RPC_URL: 'http://127.0.0.1:6488',
  NNS_RPC_USER: 'admin',
  NNS_RPC_PASSWORD: 'hunter2',
  NNS_NETWORK_ID: '24',
  NNS_LAUNCH_HEIGHT: '58000000',
  NNS_TREASURY_ADDRESS: 'NQ82 24C1 X9HD 6GVL 4JAG AVF6 AT3K FA0Q H3UN',
  NNS_PROTOCOL_ADDRESS: 'NQ07 48LK 0DRX 8M65 6NK1 D1PP CYC4 HE99 K857',
  NNS_ADMIN_ADDRESS: 'NQ67 6CV4 2J2F AREN 8STJ F608 F3LM KJHS MCDQ',
  NNS_MARKETPLACE_ADDRESS: 'NQ28 8H5M 4NB0 CVP7 AY43 HA8R H7V6 MNSB PGN9',
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

  it('requires every §3 address and reports the variable by name', () => {
    const { NNS_ADMIN_ADDRESS: _omitted, ...rest } = FULL
    expect(() => loadSettings(rest)).toThrow(/NNS_ADMIN_ADDRESS/)
  })

  it("wraps core's validation into EnvError, so a bad address fails at startup", () => {
    expect(() => loadSettings({ ...FULL, NNS_ADMIN_ADDRESS: 'NQ00 NOT A REAL ADDRESS' })).toThrow(EnvError)
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
