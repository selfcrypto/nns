import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageLike } from './identity'

const connectWallet = vi.fn()
const isHostedWebView = vi.fn()

vi.mock('./sdk', () => ({
  connectWallet: () => connectWallet(),
  devAddressOverride: () => null,
  paySendTransaction: vi.fn(),
}))
vi.mock('./chrome', () => ({ isHostedWebView: () => isHostedWebView() }))

const { detectWallet } = await import('./wallet')

const ADDRESS = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'

function memoryStore(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  }
}

describe('detectWallet — which adapter answers', () => {
  beforeEach(() => {
    connectWallet.mockReset()
    isHostedWebView.mockReset()
  })

  it('takes the Pay session when the host gives one', async () => {
    connectWallet.mockResolvedValue({ addresses: [ADDRESS], provider: {} })
    isHostedWebView.mockReturnValue(true)
    const wallet = await detectWallet(memoryStore(), '')
    expect(wallet.identity).toEqual({ kind: 'pay', addresses: [ADDRESS] })
  })

  it('stays on Pay when the prompt is DECLINED inside Pay — never the Hub', async () => {
    // The regression this exists for. `connectWallet` returns null for a
    // declined prompt exactly as it does for "no wallet here", and falling
    // through on the first case offered a desktop web-wallet connector inside
    // Pay's own WebView (Kike, 2026-08-22).
    connectWallet.mockResolvedValue(null)
    isHostedWebView.mockReturnValue(true)
    const wallet = await detectWallet(memoryStore(), '')
    expect(wallet.identity.kind).toBe('pay')
    expect(wallet.identity.addresses).toEqual([])
    // …and it can ask again, which is the whole point.
    expect(wallet.connect).not.toBeNull()
  })

  it('falls back to the Hub only outside a hosted WebView', async () => {
    connectWallet.mockResolvedValue(null)
    isHostedWebView.mockReturnValue(false)
    const wallet = await detectWallet(memoryStore(), '')
    expect(wallet.identity.kind).toBe('hub')
  })
})

describe('the Pay adapter can be disconnected and reconnected', () => {
  beforeEach(() => {
    connectWallet.mockReset()
    isHostedWebView.mockReset()
    isHostedWebView.mockReturnValue(true)
  })

  it('drops the addresses and remembers the choice across a reload', async () => {
    const store = memoryStore()
    connectWallet.mockResolvedValue({ addresses: [ADDRESS], provider: {} })

    const wallet = await detectWallet(store, '')
    expect(wallet.identity.addresses).toEqual([ADDRESS])

    expect(wallet.disconnect?.()).toEqual({ kind: 'pay', addresses: [] })
    expect(wallet.identity.addresses).toEqual([])

    // A reload must not silently reconnect — that would make the button a
    // no-op the moment the WebView reloads.
    const reloaded = await detectWallet(store, '')
    expect(reloaded.identity).toEqual({ kind: 'pay', addresses: [] })
    expect(connectWallet).toHaveBeenCalledTimes(1)
  })

  it('asks the host again on connect, and clears the dismissal', async () => {
    const store = memoryStore()
    connectWallet.mockResolvedValue(null)

    const wallet = await detectWallet(store, '')
    wallet.disconnect?.()

    connectWallet.mockResolvedValue({ addresses: [ADDRESS], provider: {} })
    expect(await wallet.connect?.()).toEqual({ kind: 'pay', addresses: [ADDRESS] })
    expect((await detectWallet(store, '')).identity.addresses).toEqual([ADDRESS])
  })

  it('refuses to send while no account is connected, rather than throwing', async () => {
    connectWallet.mockResolvedValue(null)
    const wallet = await detectWallet(memoryStore(), '')
    const outcome = await wallet.submit(
      { sender: ADDRESS, recipient: ADDRESS, value: 1n, dataHex: '00' },
      null,
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'failed' })
  })
})
