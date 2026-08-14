/**
 * The hot key: proving it before it is used, and putting it away after.
 *
 * Two things are worth testing here and both are cheap. The first is that the
 * key is checked against the §3 address it will pay from **locally** — an `M`
 * from the wrong sender is forfeited, not rejected (§6 `M`), so the money would
 * leave and the debt would stay. The second is the shape of one signing window:
 * unlock, confirm, sign, lock, and lock *especially* when the signing throws.
 */

import { generateKeypair } from '@nns/core'
import { describe, expect, it } from 'vitest'

import { EnvError } from './env.js'
import { createNodeWallet, loadHotKeys } from './keys.js'
import { testConfig } from './test-fixtures.js'
import type { IssuerRpc } from './issue.js'

/** A real keypair, so the derivation under test is the one that runs live. */
const marketplaceKey = generateKeypair()
const treasuryKey = generateKeypair()
const config = testConfig({ marketplace: marketplaceKey.address, treasury: treasuryKey.address })

describe('loadHotKeys', () => {
  it('accepts a key that derives the §3 address it will pay from', () => {
    const keys = loadHotKeys({ NNS_SETTLEMENT_MARKETPLACE_KEY: marketplaceKey.privateKey }, config)
    expect([...keys.keys()]).toEqual([marketplaceKey.address])
    expect(keys.get(marketplaceKey.address)?.role).toBe('MARKETPLACE_ADDRESS')
  })

  it('refuses a key that derives a different address', () => {
    expect(() => loadHotKeys({ NNS_SETTLEMENT_MARKETPLACE_KEY: treasuryKey.privateKey }, config)).toThrow(
      /derives .*but MARKETPLACE_ADDRESS is/s,
    )
  })

  it('says why that matters, since a wrong sender forfeits rather than fails', () => {
    expect(() => loadHotKeys({ NNS_SETTLEMENT_TREASURY_KEY: marketplaceKey.privateKey }, config)).toThrow(/§6 M/)
  })

  it('refuses anything that is not 32 bytes of bare hex', () => {
    // The `0x` prefix is refused rather than stripped: `importRawKey` takes the
    // bare form, and quietly accepting both spellings hides which one is set.
    for (const bad of ['not-hex', 'zz'.repeat(32), marketplaceKey.privateKey.slice(0, 62), `0x${marketplaceKey.privateKey}`]) {
      expect(() => loadHotKeys({ NNS_SETTLEMENT_MARKETPLACE_KEY: bad }, config)).toThrow(EnvError)
    }
  })

  it('holds nothing when the environment holds nothing — a dry run needs no key', () => {
    expect(loadHotKeys({}, config).size).toBe(0)
    expect(loadHotKeys({ NNS_SETTLEMENT_MARKETPLACE_KEY: '   ' }, config).size).toBe(0)
  })

  it('holds both when both are set', () => {
    const keys = loadHotKeys(
      {
        NNS_SETTLEMENT_MARKETPLACE_KEY: marketplaceKey.privateKey.toUpperCase(),
        NNS_SETTLEMENT_TREASURY_KEY: treasuryKey.privateKey,
      },
      config,
    )
    expect(keys.size).toBe(2)
    expect(keys.get(marketplaceKey.address)?.privateKey).toBe(marketplaceKey.privateKey)
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

  const keys = loadHotKeys({ NNS_SETTLEMENT_MARKETPLACE_KEY: marketplaceKey.privateKey }, config)

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

  it('has no key for an address it was not given one for', async () => {
    const { rpc } = recording()
    const wallet = createNodeWallet(rpc, keys)
    await expect(wallet.withSigningKey(treasuryKey.address, async () => 'never')).rejects.toThrow(/no key for/)
    expect(wallet.senders).toEqual([marketplaceKey.address])
  })
})
