import { describe, expect, it } from 'vitest'
import {
  cleanWalletName,
  discoverEvmProvider,
  listEvmWallets,
  requestEvmAddress,
  silentEvmAddress,
  type Eip1193Provider,
} from './evmWallets'

const ADDRESS = '0x1B3f6A09e2C40d55c8A1b2c3D4e5F60718293a4B'

/** A provider answering each method with a value, or rejecting with it when it is an Error or a `{code}`. */
const provider = (answers: Record<string, unknown>): Eip1193Provider => ({
  request: ({ method }) => {
    const answer = answers[method]
    const rejects = answer instanceof Error || (typeof answer === 'object' && answer !== null && 'code' in answer)
    return rejects ? Promise.reject(answer) : Promise.resolve(answer)
  },
})

interface Announcement {
  readonly info?: { readonly uuid?: unknown; readonly name?: unknown }
  readonly provider?: unknown
}

/** A window whose extensions answer `eip6963:requestProvider` the way the EIP says: synchronously. */
const browser = (announcements: readonly Announcement[], ethereum?: unknown): Window => {
  const win = Object.assign(new EventTarget(), { ethereum })
  win.addEventListener('eip6963:requestProvider', () => {
    for (const detail of announcements) {
      win.dispatchEvent(Object.assign(new Event('eip6963:announceProvider'), { detail }))
    }
  })
  return win as unknown as Window
}

describe('listEvmWallets', () => {
  it('is empty with no window and with no wallet', () => {
    expect(listEvmWallets(undefined)).toEqual([])
    expect(listEvmWallets(browser([]))).toEqual([])
  })

  it('lists window.ethereum alone as the unnamed injected wallet (the Pay WebView)', () => {
    const injected = provider({})
    expect(listEvmWallets(browser([], injected))).toEqual([
      { id: 'injected', name: null, source: 'injected', provider: injected },
    ])
  })

  it('names a wallet that announces the object it also injects, once', () => {
    const metamask = provider({})
    expect(listEvmWallets(browser([{ info: { uuid: 'a', name: 'MetaMask' }, provider: metamask }], metamask))).toEqual([
      { id: 'a', name: 'MetaMask', source: 'announced', provider: metamask },
    ])
  })

  it('keeps every announcer in order, and appends an injected object none of them is', () => {
    const [one, two, other] = [provider({}), provider({}), provider({})]
    const wallets = listEvmWallets(
      browser(
        [
          { info: { uuid: 'a', name: 'MetaMask' }, provider: one },
          { info: { uuid: 'b', name: 'Rabby' }, provider: two },
        ],
        other,
      ),
    )
    expect(wallets.map(({ id, name, source }) => [id, name, source])).toEqual([
      ['a', 'MetaMask', 'announced'],
      ['b', 'Rabby', 'announced'],
      ['injected', null, 'injected'],
    ])
  })

  it('collapses a repeated uuid and a repeated provider', () => {
    const one = provider({})
    const wallets = listEvmWallets(
      browser([
        { info: { uuid: 'a', name: 'MetaMask' }, provider: one },
        { info: { uuid: 'a', name: 'MetaMask' }, provider: provider({}) },
        { info: { uuid: 'c', name: 'Copy' }, provider: one },
      ]),
    )
    expect(wallets.map((wallet) => wallet.id)).toEqual(['a'])
  })

  it('skips an announcement it cannot use, and keeps the rest', () => {
    const good = provider({})
    const unreadable = {
      get info(): never {
        throw new Error('Permission denied to access property "info"')
      },
      provider: provider({}),
    }
    const wallets = listEvmWallets(
      browser([
        { info: { uuid: 'x', name: 'No request method' }, provider: {} },
        { info: { name: 'No uuid' }, provider: provider({}) },
        unreadable,
        { info: { uuid: 'a', name: 'MetaMask' }, provider: good },
      ]),
    )
    expect(wallets.map((wallet) => wallet.id)).toEqual(['a'])
  })

  it('stops listening once it has asked', () => {
    const win = browser([])
    listEvmWallets(win)
    const late = Object.assign(new Event('eip6963:announceProvider'), {
      detail: { info: { uuid: 'late', name: 'Late' }, provider: provider({}) },
    })
    win.dispatchEvent(late)
    expect(listEvmWallets(win)).toEqual([])
  })
})

describe('cleanWalletName', () => {
  it('is null for what is not a name', () => {
    for (const raw of [undefined, null, 7, {}, '', '   ', '\n\t']) expect(cleanWalletName(raw)).toBeNull()
  })

  it('strips control characters, collapses whitespace and caps the length', () => {
    expect(cleanWalletName('  Meta\u0000Mask \n Flask ')).toBe('Meta Mask Flask')
    expect(cleanWalletName('W'.repeat(80))).toBe('W'.repeat(24))
  })
})

describe('discoverEvmProvider', () => {
  it('is window.ethereum first, else the first announcer, else null', () => {
    const [injected, announced] = [provider({}), provider({})]
    const announcements = [{ info: { uuid: 'a', name: 'MetaMask' }, provider: announced }]
    expect(discoverEvmProvider(browser(announcements, injected))).toBe(injected)
    expect(discoverEvmProvider(browser(announcements))).toBe(announced)
    expect(discoverEvmProvider(browser([]))).toBeNull()
    expect(discoverEvmProvider(undefined)).toBeNull()
  })
})

describe('silentEvmAddress', () => {
  it('is the first address, lowercased', async () => {
    expect(await silentEvmAddress(provider({ eth_accounts: [ADDRESS] }))).toBe(ADDRESS.toLowerCase())
  })

  it('is null for a site that is not connected, a refusal and a malformed answer', async () => {
    expect(await silentEvmAddress(provider({ eth_accounts: [] }))).toBeNull()
    expect(await silentEvmAddress(provider({ eth_accounts: new Error('locked') }))).toBeNull()
    expect(await silentEvmAddress(provider({ eth_accounts: 'not a list' }))).toBeNull()
  })
})

describe('requestEvmAddress', () => {
  const ask = (answer: unknown) => requestEvmAddress(provider({ eth_requestAccounts: answer }))

  it('answers the address, lowercased', async () => {
    expect(await ask([ADDRESS])).toEqual({ ok: true, address: ADDRESS.toLowerCase() })
  })

  it('reads a decline from the code, or from the words of a wallet that sends none', async () => {
    expect(await ask({ code: 4001, message: 'User rejected the request.' })).toEqual({ ok: false, reason: 'declined' })
    expect(await ask(new Error('Request cancelled by the user'))).toEqual({ ok: false, reason: 'declined' })
  })

  it('is busy when the wallet already has a request open', async () => {
    // MetaMask keeps the first prompt alive and refuses the second.
    expect(
      await ask({ code: -32002, message: "Request of type 'wallet_requestPermissions' already pending" }),
    ).toEqual({ ok: false, reason: 'busy' })
  })

  it('is empty for an answer holding no address', async () => {
    expect(await ask([])).toEqual({ ok: false, reason: 'empty' })
    expect(await ask(['0x1234', 7])).toEqual({ ok: false, reason: 'empty' })
  })

  it('carries the wallet’s own words for anything else, capped', async () => {
    expect(await ask({ code: -32603, message: 'Internal JSON-RPC error.' })).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'Internal JSON-RPC error.',
    })
    const long = await ask({ code: -32603, message: 'x'.repeat(500) })
    expect(long).toMatchObject({ reason: 'failed' })
    expect(long.ok === false && long.reason === 'failed' ? long.detail.length : 0).toBe(120)
    const bare = await ask({ code: -32000 })
    expect(bare.ok === false && bare.reason === 'failed' ? bare.detail : '').not.toContain('[object Object]')
  })

  it('has no timeout of its own: a wallet that has not answered has not failed', async () => {
    const silent: Eip1193Provider = { request: () => new Promise(() => {}) }
    const settled = await Promise.race([requestEvmAddress(silent), Promise.resolve('still waiting')])
    expect(settled).toBe('still waiting')
  })
})
