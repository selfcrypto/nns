import { describe, expect, it, vi } from 'vitest'

import { INVALID_PARAMS, RpcClient, RpcError, RpcTransportError } from './rpc.js'

interface Call {
  url: string
  headers: Record<string, string>
  body: { jsonrpc: string; id: number; method: string; params: unknown[] }
}

/** A fetch stub that records calls and replays queued JSON-RPC responses. */
function stubFetch(responses: readonly unknown[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  let n = 0
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    })
    const next = responses[Math.min(n, responses.length - 1)]
    n += 1
    if (next instanceof Error) throw next
    if (typeof next === 'number') {
      return new Response('nope', { status: next, statusText: 'Error' })
    }
    return new Response(JSON.stringify(next), { status: 200 })
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

const ok = (data: unknown, metadata: unknown = null) => ({ jsonrpc: '2.0', id: 1, result: { data, metadata } })

function client(responses: readonly unknown[], overrides: Partial<ConstructorParameters<typeof RpcClient>[0]> = {}) {
  const stub = stubFetch(responses)
  return {
    stub,
    rpc: new RpcClient({
      url: 'http://127.0.0.1:6488',
      fetchImpl: stub.fetch,
      sleep: async () => {},
      ...overrides,
    }),
  }
}

describe('envelope', () => {
  it('unwraps result.data', async () => {
    const { rpc } = client([ok(58_177_017)])
    await expect(rpc.getBlockNumber()).resolves.toBe(58_177_017)
  })

  it('keeps the metadata stamp when asked', async () => {
    const { rpc } = client([ok({ balance: 1 }, { blockNumber: 58_174_400, blockHash: '2daca0c2' })])
    const response = await rpc.getAccountByAddress('NQ07 0000')
    expect(response.metadata).toEqual({ blockNumber: 58_174_400, blockHash: '2daca0c2' })
  })

  it('reports null metadata on chain-position calls', async () => {
    const { rpc } = client([ok(7)])
    const response = await rpc.callWithMetadata('getBatchNumber')
    expect(response.metadata).toBeNull()
  })

  it('throws rather than returning undefined when the envelope is missing', async () => {
    // This is the whole point: an unwrapped result must fail loudly. Reaching
    // through it optimistically returns `undefined`, which is how the first
    // probe run produced a false negative.
    const { rpc } = client([{ jsonrpc: '2.0', id: 1, result: 58_177_017 }])
    await expect(rpc.getBlockNumber()).rejects.toThrow(RpcTransportError)
    await expect(client([{ jsonrpc: '2.0', id: 1, result: { value: 1 } }]).rpc.getBlockNumber()).rejects.toThrow(
      /no "data" key/,
    )
  })

  it('passes a null data payload through', async () => {
    const { rpc } = client([ok(null)])
    await expect(rpc.call('getBlockByNumber', [1])).resolves.toBeNull()
  })
})

describe('auth and transport', () => {
  it('sends HTTP basic auth when a user is configured', async () => {
    const { rpc, stub } = client([ok(true)], { username: 'nns', password: 's3cret' })
    await rpc.isConsensusEstablished()
    expect(stub.calls[0]?.headers['Authorization']).toBe('Basic ' + Buffer.from('nns:s3cret').toString('base64'))
    expect(stub.calls[0]?.headers['Content-Type']).toBe('application/json')
  })

  it('omits the header when no user is configured', async () => {
    const { rpc, stub } = client([ok(true)])
    await rpc.isConsensusEstablished()
    expect(stub.calls[0]?.headers['Authorization']).toBeUndefined()
  })

  it('names the credentials on a 401 and does not retry it', async () => {
    const { rpc, stub } = client([401], { attempts: 4 })
    await expect(rpc.getBlockNumber()).rejects.toThrow(/NNS_RPC_USER/)
    expect(stub.calls).toHaveLength(1)
  })

  it('does retry a 503 — that one is the node, not the credentials', async () => {
    const { rpc, stub } = client([503], { attempts: 3 })
    await expect(rpc.getBlockNumber()).rejects.toThrow(/HTTP 503/)
    expect(stub.calls).toHaveLength(3)
  })

  it('sends a well-formed JSON-RPC 2.0 request with increasing ids', async () => {
    const { rpc, stub } = client([ok(1)])
    await rpc.getTransactionsByBatchNumber(42)
    await rpc.getBlockNumber()
    expect(stub.calls[0]?.body).toMatchObject({
      jsonrpc: '2.0',
      method: 'getTransactionsByBatchNumber',
      params: [42],
    })
    expect(stub.calls[1]?.body.id).toBe((stub.calls[0]?.body.id ?? 0) + 1)
  })
})

describe('retries', () => {
  it('retries transport failures and gives up after `attempts`', async () => {
    const sleep = vi.fn(async (_ms: number) => {})
    const { rpc, stub } = client([new Error('ECONNREFUSED')], { attempts: 3, sleep })
    await expect(rpc.getBlockNumber()).rejects.toThrow(/failed after 3 attempts/)
    expect(stub.calls).toHaveLength(3)
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([250, 500])
  })

  it('does not retry a JSON-RPC error — it is the node’s considered answer', async () => {
    const { rpc, stub } = client([{ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }], {
      attempts: 4,
    })
    await expect(rpc.call('nope')).rejects.toThrow(RpcError)
    expect(stub.calls).toHaveLength(1)
  })

  it('carries the error code', async () => {
    const { rpc } = client([{ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } }])
    await expect(rpc.call('getBlockByNumber')).rejects.toMatchObject({ code: INVALID_PARAMS })
  })
})

describe('getBlockByNumber parameter form', () => {
  it('uses the bare boolean when the node accepts it', async () => {
    const { rpc, stub } = client([ok({ number: 5, hash: 'aa', transactions: [] })])
    await rpc.getBlockByNumber(5, true)
    expect(stub.calls[0]?.body.params).toEqual([5, true])
  })

  it('falls back to the object form on -32602 and remembers it', async () => {
    const seen: Call['body'][] = []
    let call = 0
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      call += 1
      const body = JSON.parse(String(init?.body)) as Call['body']
      seen.push(body)
      if (typeof body.params[1] === 'boolean') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: call, error: { code: -32602, message: 'Invalid params' } }))
      }
      return new Response(JSON.stringify(ok({ number: 5, hash: 'aa', transactions: [] })))
    }) as unknown as typeof fetch

    const rpc = new RpcClient({ url: 'http://x', fetchImpl, sleep: async () => {} })
    await rpc.getBlockByNumber(5, true)
    await rpc.getBlockByNumber(6, true)
    expect(seen.map((body) => body.params)).toEqual([
      [5, true],
      [5, { includeBody: true }],
      [6, { includeBody: true }],
    ])
  })
})
