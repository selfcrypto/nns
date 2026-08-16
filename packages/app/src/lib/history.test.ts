import { describe, expect, it } from 'vitest'
import { HistoryError, fetchHistory, fetchTransport } from './history'

const sample = {
  hash: 'abc',
  blockNumber: 59_056_260,
  timestamp: 1_786_899_510_348,
  from: 'NQ81 C01N BASE 0000 0000 0000 0000 0000 0000',
  to: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
  recipientData: '',
  executionResult: true,
}

describe('fetchHistory', () => {
  it('reads the probed object shape and reports the honest window boundary', async () => {
    const page = await fetchHistory(
      () => Promise.resolve([sample, { ...sample, hash: 'def', blockNumber: 59_000_000 }]),
      sample.to,
    )
    expect(page.txs).toHaveLength(2)
    expect(page.oldestBlock).toBe(59_000_000)
  })

  it('skips malformed entries rather than failing the page', async () => {
    const page = await fetchHistory(() => Promise.resolve([sample, { hash: 42 }]), sample.to)
    expect(page.txs).toHaveLength(1)
  })

  it('a non-array result is an error, not an empty inbox', async () => {
    await expect(fetchHistory(() => Promise.resolve(null), sample.to)).rejects.toBeInstanceOf(HistoryError)
  })
})

describe('fetchTransport', () => {
  const response = (body: unknown, status = 200): Response =>
    ({ status, json: () => Promise.resolve(body) }) as Response

  it('unwraps the RPC envelope: result.data', async () => {
    const transport = fetchTransport('http://h', () =>
      Promise.resolve(response({ jsonrpc: '2.0', id: 1, result: { data: [sample], metadata: null } })),
    )
    const data = await transport('getTransactionsByAddress', [sample.to, 500, null])
    expect(Array.isArray(data) && data[0]).toEqual(sample)
  })

  it('surfaces an RPC error by its data field, like the SDK does', async () => {
    const transport = fetchTransport('http://h', () =>
      Promise.resolve(response({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope', data: 'Method not found' } })),
    )
    await expect(transport('getBlockNumber', [])).rejects.toThrow('Method not found')
  })

  it('a non-200 is an error', async () => {
    const transport = fetchTransport('http://h', () => Promise.resolve(response(null, 502)))
    await expect(transport('getBlockNumber', [])).rejects.toBeInstanceOf(HistoryError)
  })
})
