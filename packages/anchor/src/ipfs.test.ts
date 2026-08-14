import { describe, expect, it } from 'vitest'
import { createKuboAdd, IpfsError, KUBO_ADD_PARAMS } from './ipfs.js'

const CID = 'bafybeif7ztnhq65lumvvtr4ekcwd2ifwgm3awq4zfr3srh462rwyinlb4y'

interface Captured {
  url: URL
  headers: Record<string, string>
}

function capture(body: string, status = 200): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = []
  return {
    calls,
    fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({ url: new URL(String(input)), headers: (init?.headers as Record<string, string>) ?? {} })
      return new Response(body, { status })
    }) as typeof fetch,
  }
}

describe('createKuboAdd', () => {
  it('sends §8.2\'s exact flag set — raw-leaves=false explicit, never defaulted', async () => {
    // kubo flips raw leaves ON the moment cid-version=1 is given; relying on
    // the default here would mint a raw root for every single-chunk snapshot.
    const { fetch, calls } = capture(`${JSON.stringify({ Name: 'nns-log', Hash: CID, Size: '42' })}\n`)
    const add = createKuboAdd({ url: 'http://127.0.0.1:5001/', label: 'kubo' }, fetch)

    await expect(add.add(new Uint8Array([1, 2, 3]), { pin: true })).resolves.toBe(CID)

    const params = calls[0]!.url.searchParams
    for (const [key, value] of Object.entries(KUBO_ADD_PARAMS)) {
      expect(params.get(key), key).toBe(value)
    }
    expect(params.get('raw-leaves')).toBe('false')
    expect(params.get('pin')).toBe('true')
    expect(params.get('only-hash')).toBeNull()
    expect(calls[0]!.url.pathname).toBe('/api/v0/add')
  })

  it('uses only-hash without pin, so a dry run stores nothing anywhere', async () => {
    const { fetch, calls } = capture(JSON.stringify({ Hash: CID }))
    const add = createKuboAdd({ url: 'http://127.0.0.1:5001', label: 'kubo' }, fetch)
    await add.add(new Uint8Array([1]), { pin: false })
    expect(calls[0]!.url.searchParams.get('pin')).toBe('false')
    expect(calls[0]!.url.searchParams.get('only-hash')).toBe('true')
  })

  it('passes the Authorization header verbatim when configured', async () => {
    const { fetch, calls } = capture(JSON.stringify({ Hash: CID }))
    const add = createKuboAdd({ url: 'http://pin.example', auth: 'Bearer token', label: 'pinner' }, fetch)
    await add.add(new Uint8Array([1]), { pin: true })
    expect(calls[0]!.headers).toEqual({ authorization: 'Bearer token' })
  })

  it('takes the last line of a multi-line answer — the root', async () => {
    const body = `${JSON.stringify({ Hash: 'bafyintermediate' })}\n${JSON.stringify({ Hash: CID })}\n`
    const { fetch } = capture(body)
    const add = createKuboAdd({ url: 'http://127.0.0.1:5001', label: 'kubo' }, fetch)
    await expect(add.add(new Uint8Array([1]), { pin: true })).resolves.toBe(CID)
  })

  it('names the service in every failure', async () => {
    const failing = createKuboAdd({ url: 'http://x.example', label: 'pinner-2' }, capture('nope', 500).fetch)
    await expect(failing.add(new Uint8Array([1]), { pin: true })).rejects.toThrow(/pinner-2/)

    const empty = createKuboAdd({ url: 'http://x.example', label: 'pinner-2' }, capture('').fetch)
    await expect(empty.add(new Uint8Array([1]), { pin: true })).rejects.toThrow(IpfsError)

    const noHash = createKuboAdd({ url: 'http://x.example', label: 'pinner-2' }, capture('{}').fetch)
    await expect(noHash.add(new Uint8Array([1]), { pin: true })).rejects.toThrow(/no Hash/)
  })
})
