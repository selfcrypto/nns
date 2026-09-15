import { describe, expect, it } from 'vitest'
import { CHAT_MIN_HEIGHT } from '@nns/chat'
import { EnvError, loadSettings } from './env.js'

const MINIMAL = {
  NNS_CHAT_DATABASE_URL: 'postgres://localhost/chat',
  NNS_CHAT_RPC_URL: 'http://localhost:8648',
  NNS_CHAT_START_HEIGHT: String(CHAT_MIN_HEIGHT),
}

describe('settings', () => {
  it('reads the minimal set and defaults the rest', () => {
    const settings = loadSettings(MINIMAL)
    expect(settings.startHeight).toBe(CHAT_MIN_HEIGHT)
    expect(settings.networkId).toBe(24)
    expect(settings.port).toBe(8637)
    expect(settings.logLevel).toBe('info')
    expect(settings.rpcUser).toBeUndefined()
  })

  it('refuses to start without a start height — the window is not defaultable', () => {
    const { NNS_CHAT_START_HEIGHT: _omitted, ...rest } = MINIMAL
    expect(() => loadSettings(rest)).toThrow(EnvError)
    expect(() => loadSettings({ ...MINIMAL, NNS_CHAT_START_HEIGHT: 'soon' })).toThrow(EnvError)
    expect(() => loadSettings({ ...MINIMAL, NNS_CHAT_START_HEIGHT: '0' })).toThrow(EnvError)
    // Below launch there is no registry for a message to be about, and every
    // reader drops those rows anyway (2026-09-15).
    expect(() => loadSettings({ ...MINIMAL, NNS_CHAT_START_HEIGHT: String(CHAT_MIN_HEIGHT - 1) })).toThrow(EnvError)
    expect(loadSettings({ ...MINIMAL, NNS_CHAT_START_HEIGHT: String(CHAT_MIN_HEIGHT + 1) }).startHeight).toBe(CHAT_MIN_HEIGHT + 1)
  })

  it('refuses a missing database or node', () => {
    expect(() => loadSettings({ ...MINIMAL, NNS_CHAT_DATABASE_URL: '  ' })).toThrow(EnvError)
    expect(() => loadSettings({ ...MINIMAL, NNS_CHAT_RPC_URL: undefined })).toThrow(EnvError)
  })

  it('refuses a log level it does not have', () => {
    expect(() => loadSettings({ ...MINIMAL, NNS_CHAT_LOG_LEVEL: 'chatty' })).toThrow(EnvError)
  })
})
