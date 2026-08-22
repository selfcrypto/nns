import { describe, expect, it } from 'vitest'
import { MAX_HISTORY_RESULTS, MAX_RAW_TX_HEX_CHARS, screen } from './allowlist.js'

const rpc = (method: string, params?: unknown, id: unknown = 1): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })

const errorCode = (screened: ReturnType<typeof screen>): number | null => {
  if (screened.ok) return null
  const body = JSON.parse(screened.body) as { error: { code: number } }
  return body.error.code
}

describe('the boundary', () => {
  it('accepts exactly the four methods and answers -32601 to any other', () => {
    expect(screen(rpc('getBlockNumber', [])).ok).toBe(true)
    for (const method of ['sendBasicTransaction', 'unlockAccount', 'importRawKey', 'createAccount', 'getAccounts', '']) {
      expect(errorCode(screen(rpc(method, [])))).toBe(-32601)
    }
  })

  it('refuses batches outright — they multiply cost and slip past per-request limits', () => {
    expect(errorCode(screen(`[${rpc('getBlockNumber', [])}]`))).toBe(-32600)
  })

  it('refuses non-JSON, non-objects, and a wrong jsonrpc field', () => {
    expect(errorCode(screen('not json'))).toBe(-32700)
    expect(errorCode(screen('"a string"'))).toBe(-32600)
    expect(errorCode(screen(JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'getBlockNumber', params: [] })))).toBe(-32600)
  })

  it('echoes only a sane id and defaults the rest to null', () => {
    const screened = screen(rpc('getBlockNumber', [], { evil: true }))
    expect(screened.ok && screened.id).toBe(null)
  })

  it('duplicate keys cannot smuggle a method past reconstruction', () => {
    // JSON.parse keeps the last duplicate; whatever a differing upstream
    // parser would have kept never matters, because the upstream request is
    // rebuilt from the values validated here.
    const body = '{"jsonrpc":"2.0","id":1,"method":"getBlockNumber","method":"unlockAccount","params":[]}'
    expect(errorCode(screen(body))).toBe(-32601)
  })
})

describe('per-method params', () => {
  it('getBlockNumber takes nothing', () => {
    expect(screen(rpc('getBlockNumber')).ok).toBe(true)
    expect(errorCode(screen(rpc('getBlockNumber', ['x'])))).toBe(-32602)
  })

  it('getTransactionByHash takes one 64-hex hash, lowercased on the way out', () => {
    const hash = 'AB'.repeat(32)
    const screened = screen(rpc('getTransactionByHash', [hash]))
    expect(screened.ok && screened.params[0]).toBe(hash.toLowerCase())
    expect(errorCode(screen(rpc('getTransactionByHash', ['zz'])))).toBe(-32602)
    expect(errorCode(screen(rpc('getTransactionByHash', [])))).toBe(-32602)
  })

  it('getTransactionsByAddress clamps max to the page size and rejects junk', () => {
    const address = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'
    const clamped = screen(rpc('getTransactionsByAddress', [address, 10_000, null]))
    expect(clamped.ok && clamped.params).toEqual([address, MAX_HISTORY_RESULTS, null])
    const defaulted = screen(rpc('getTransactionsByAddress', [address]))
    expect(defaulted.ok && defaulted.params).toEqual([address, MAX_HISTORY_RESULTS, null])
    expect(errorCode(screen(rpc('getTransactionsByAddress', [address, 0, null])))).toBe(-32602)
    expect(errorCode(screen(rpc('getTransactionsByAddress', [{ address }])))).toBe(-32602)
    expect(errorCode(screen(rpc('getTransactionsByAddress', ['<script>alert(1)</script>'])))).toBe(-32602)
  })

  it('sendRawTransaction takes bounded hex — the relay is useless for bulk', () => {
    expect(screen(rpc('sendRawTransaction', ['00'.repeat(166)])).ok).toBe(true)
    expect(errorCode(screen(rpc('sendRawTransaction', ['00'.repeat(MAX_RAW_TX_HEX_CHARS / 2 + 1)])))).toBe(-32602)
    expect(errorCode(screen(rpc('sendRawTransaction', ['0'])))).toBe(-32602)
    expect(errorCode(screen(rpc('sendRawTransaction', [42])))).toBe(-32602)
  })
})

describe('getAccountByAddress — the account-type lookup', () => {
  const ADDRESS = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'

  it('accepts one address', () => {
    const screened = screen(rpc('getAccountByAddress', [ADDRESS]))
    expect(screened).toMatchObject({ ok: true, method: 'getAccountByAddress', params: [ADDRESS] })
  })

  it('refuses anything else in the field', () => {
    expect(errorCode(screen(rpc('getAccountByAddress', [])))).toBe(-32602)
    expect(errorCode(screen(rpc('getAccountByAddress', [ADDRESS, 1])))).toBe(-32602)
    expect(errorCode(screen(rpc('getAccountByAddress', [{ address: ADDRESS }])))).toBe(-32602)
    expect(errorCode(screen(rpc('getAccountByAddress', ['<script>alert(1)</script>'])))).toBe(-32602)
  })
})
