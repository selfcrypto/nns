import { afterEach, describe, expect, it, vi } from 'vitest'

import { CONSTANTS, type Address } from '@nimiqnames/core'

import { AdminRefusal, withUnlocked, type AdminRpc } from './cli.js'

const SENDER = CONSTANTS.ADMIN_ADDRESS as Address

afterEach(() => {
  vi.restoreAllMocks()
})

/** A node wallet with one account: unlock/lock flip it, and every call is recorded. */
function wallet(options: { unlockWorks?: boolean; lockFails?: boolean } = {}) {
  let unlocked = false
  const calls: string[] = []
  const rpc: AdminRpc = {
    call<T>(method: string): Promise<T> {
      calls.push(method)
      switch (method) {
        case 'unlockAccount':
          if (options.unlockWorks !== false) unlocked = true
          return Promise.resolve(true as T)
        case 'isAccountUnlocked':
          return Promise.resolve(unlocked as T)
        case 'lockAccount':
          if (options.lockFails) return Promise.reject(new Error('connection reset'))
          unlocked = false
          return Promise.resolve(null as T)
        default:
          return Promise.reject(new Error(`unexpected ${method}`))
      }
    },
  }
  return { rpc, calls, isUnlocked: () => unlocked }
}

describe('withUnlocked', () => {
  it('unlocks, confirms, runs the body, then locks and confirms', async () => {
    const w = wallet()
    await expect(withUnlocked(w.rpc, SENDER, () => Promise.resolve('hash'))).resolves.toBe('hash')
    expect(w.calls).toEqual(['unlockAccount', 'isAccountUnlocked', 'lockAccount', 'isAccountUnlocked'])
    expect(w.isUnlocked()).toBe(false)
  })

  it('locks when the send throws — that is when a funded key would otherwise stay open', async () => {
    const w = wallet()
    await expect(withUnlocked(w.rpc, SENDER, () => Promise.reject(new Error('send failed')))).rejects.toThrow('send failed')
    expect(w.isUnlocked()).toBe(false)
    expect(w.calls).toContain('lockAccount')
  })

  it('refuses to sign when the account is still locked after unlockAccount (§5.4: ask, never infer)', async () => {
    const w = wallet({ unlockWorks: false })
    const body = vi.fn(() => Promise.resolve('hash'))
    await expect(withUnlocked(w.rpc, SENDER, body)).rejects.toBeInstanceOf(AdminRefusal)
    expect(body).not.toHaveBeenCalled()
  })

  it('a lock that fails is loud but not fatal: the send already happened', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = wallet({ lockFails: true })
    await expect(withUnlocked(w.rpc, SENDER, () => Promise.resolve('hash'))).resolves.toBe('hash')
    expect(error.mock.calls.flat().join(' ')).toMatch(/UNLOCKED on the node; lock it by hand/)
  })

  it('holds a Ctrl-C until the key is locked, then re-raises it', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const w = wallet()
    let lockedWhenKilled: boolean | null = null
    kill.mockImplementation(() => {
      lockedWhenKilled = !w.isUnlocked()
      return true
    })
    await withUnlocked(w.rpc, SENDER, async () => {
      process.emit('SIGINT', 'SIGINT')
      return 'hash'
    })
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT')
    expect(lockedWhenKilled).toBe(true)
    expect(process.listenerCount('SIGINT')).toBe(0)
  })
})
