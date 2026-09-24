/**
 * The hot key: proving it before it is used, and putting it away after.
 *
 * Two things are worth testing here and both are cheap. The first is that the
 * key is checked against the §3 address it will pay from **locally** — an `M`
 * from the wrong sender is forfeited, not rejected (§6 `M`), so the money would
 * leave and the debt would stay. The second is the shape of one signing window:
 * unlock, confirm, sign, lock, and lock *especially* when the signing throws.
 */

import { generateKeypair } from '@nimiqnames/core'
import { describe, expect, it } from 'vitest'

import { EnvError } from './env.js'
import { createNodeWallet, loadHotKeys } from './keys.js'
import type { IssuerRpc } from './issue.js'

/** A real keypair, so the derivation under test is the one that runs live. */
const marketplaceKey = generateKeypair()
const treasuryKey = generateKeypair()

describe('loadHotKeys', () => {
  // The §3 addresses are frozen constants, and the matching private keys are
  // rightly nowhere a test can reach — so the acceptance arm cannot be
  // exercised here and belongs to the live battery (the issuer refuses at
  // startup otherwise). What *is* provable locally is that the comparison
  // reads the right operands: a generated key must be refused, and the
  // refusal must name the address that key actually derives.

  it('refuses a key that does not derive the frozen §3 address, naming what it derives', () => {
    expect(() => loadHotKeys({ NNS_SETTLEMENT_MARKETPLACE_KEY: treasuryKey.privateKey })).toThrow(
      /derives .*but MARKETPLACE_ADDRESS is/s,
    )
  })

  it('says why that matters, since a wrong sender forfeits rather than fails', () => {
    expect(() => loadHotKeys({ NNS_SETTLEMENT_TREASURY_KEY: marketplaceKey.privateKey })).toThrow(/§6 M/)
  })

  it('refuses anything that is not 32 bytes of bare hex', () => {
    // The `0x` prefix is refused rather than stripped: `importRawKey` takes the
    // bare form, and quietly accepting both spellings hides which one is set.
    for (const bad of ['not-hex', 'zz'.repeat(32), marketplaceKey.privateKey.slice(0, 62), `0x${marketplaceKey.privateKey}`]) {
      expect(() => loadHotKeys({ NNS_SETTLEMENT_MARKETPLACE_KEY: bad })).toThrow(EnvError)
    }
  })

  it('holds nothing when the environment holds nothing — a dry run needs no key', () => {
    expect(loadHotKeys({}).size).toBe(0)
    expect(loadHotKeys({ NNS_SETTLEMENT_MARKETPLACE_KEY: '   ' }).size).toBe(0)
  })

  it('checks the uppercase spelling of a key before refusing it, so case is not the failure', () => {
    // Case-insensitivity of the hex parse is observable even on the refusal
    // path: an uppercase key must fail the address comparison (naming the
    // derived address), never the hex validation.
    expect(() => loadHotKeys({ NNS_SETTLEMENT_MARKETPLACE_KEY: marketplaceKey.privateKey.toUpperCase() })).toThrow(
      /derives/,
    )
  })
})

describe('createNodeWallet', () => {
  const recording = (overrides: Partial<Record<string, unknown>> = {}) => {
    const calls: string[] = []
    const rpc: IssuerRpc = {
      async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
        calls.push(method)
        if (method in overrides) return overrides[method] as T
        if (method === 'importRawKey') return marketplaceKey.address as T
        if (method === 'isAccountUnlocked') return (calls.filter((c) => c === 'isAccountUnlocked').length === 1) as T
        if (method === 'unlockAccount') return true as T
        if (method === 'lockAccount') return null as T
        throw new Error(`unexpected ${method} ${JSON.stringify(params)}`)
      },
    }
    return { calls, rpc }
  }

  // Built by hand rather than through loadHotKeys: the loader now checks a
  // key against the frozen §3 address, and no test key can derive that. The
  // wallet under test only needs a well-formed HotKey.
  const keys = new Map([
    [
      marketplaceKey.address,
      Object.freeze({
        address: marketplaceKey.address,
        privateKey: marketplaceKey.privateKey,
        role: 'MARKETPLACE_ADDRESS' as const,
        variable: 'NNS_SETTLEMENT_MARKETPLACE_KEY',
      }),
    ],
  ])

  it('imports, unlocks, confirms, signs, then locks and confirms again', async () => {
    const { calls, rpc } = recording()
    const wallet = createNodeWallet(rpc, keys)
    const result = await wallet.withSigningKey(marketplaceKey.address, async () => {
      calls.push('SIGN')
      return 'hash'
    })
    expect(result).toBe('hash')
    expect(calls).toEqual([
      'importRawKey',
      'unlockAccount',
      'isAccountUnlocked',
      'SIGN',
      'lockAccount',
      'isAccountUnlocked',
    ])
  })

  it('locks even when the send throws — that is when a funded key would be left open', async () => {
    const { calls, rpc } = recording()
    const wallet = createNodeWallet(rpc, keys)
    await expect(
      wallet.withSigningKey(marketplaceKey.address, () => Promise.reject(new Error('connection refused'))),
    ).rejects.toThrow('connection refused')
    expect(calls).toContain('lockAccount')
  })

  it('asks whether the account is unlocked rather than believing unlockAccount (§5.4)', async () => {
    const { rpc } = recording({ isAccountUnlocked: false })
    const wallet = createNodeWallet(rpc, keys)
    await expect(wallet.withSigningKey(marketplaceKey.address, async () => 'never')).rejects.toThrow(/still locked/)
  })

  it('refuses when the node stored a different address than this process derived', async () => {
    const { rpc } = recording({ importRawKey: treasuryKey.address })
    const wallet = createNodeWallet(rpc, keys)
    await expect(wallet.withSigningKey(marketplaceKey.address, async () => 'never')).rejects.toThrow(
      /disagree about address derivation/,
    )
  })

  it('lockAll imports, then locks and confirms every held key — the sweep for a run that died between unlock and lock', async () => {
    let unlocked = true
    const calls: string[] = []
    const rpc: IssuerRpc = {
      async call<T>(method: string): Promise<T> {
        calls.push(method)
        if (method === 'importRawKey') return marketplaceKey.address as T
        if (method === 'isAccountUnlocked') return unlocked as T
        if (method === 'lockAccount') {
          unlocked = false
          return null as T
        }
        throw new Error(`unexpected ${method}`)
      },
    }
    const wasOpen = await createNodeWallet(rpc, keys).lockAll()
    expect(wasOpen).toEqual([marketplaceKey.address])
    expect(calls).toEqual(['importRawKey', 'isAccountUnlocked', 'lockAccount', 'isAccountUnlocked'])
  })

  it('lockAll reports nothing when every key was already locked', async () => {
    const { rpc } = recording({ isAccountUnlocked: false })
    await expect(createNodeWallet(rpc, keys).lockAll()).resolves.toEqual([])
  })

  it('lockAll refuses to start when a key stays unlocked — another client holds it open (§5.4)', async () => {
    const { rpc } = recording({ isAccountUnlocked: true })
    await expect(createNodeWallet(rpc, keys).lockAll()).rejects.toThrow(/still unlocked after lockAccount/)
  })

  it('has no key for an address it was not given one for', async () => {
    const { rpc } = recording()
    const wallet = createNodeWallet(rpc, keys)
    await expect(wallet.withSigningKey(treasuryKey.address, async () => 'never')).rejects.toThrow(/no key for/)
    expect(wallet.senders).toEqual([marketplaceKey.address])
  })
})
