import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createRelay, type RelayOptions } from './server.js'

interface UpstreamCall {
  readonly url: string
  readonly body: unknown
  readonly authorization: string | undefined
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

async function startRelay(options?: Partial<RelayOptions>): Promise<{
  url: string
  calls: UpstreamCall[]
}> {
  const calls: UpstreamCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      authorization: headers.get('authorization') ?? undefined,
    })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { data: 42, metadata: null } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const server = createRelay({
    upstreamUrl: 'http://upstream.test/rpc',
    upstreamUser: 'nimiq',
    upstreamPassword: 'hunter2',
    fetchImpl,
    log: () => {},
    ...options,
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, calls }
}

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const rpc = (method: string, params: unknown[] = []) => ({ jsonrpc: '2.0', id: 7, method, params })

describe('the relay end to end', () => {
  it('forwards an allowed method as a reconstructed request with the upstream credential', async () => {
    const { url, calls } = await startRelay()
    const response = await post(url, {
      ...rpc('getBlockNumber'),
      // Junk the reconstruction must drop: extra fields never reach the node.
      extra: 'field',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { data: 42, metadata: null } })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toEqual({ jsonrpc: '2.0', id: 7, method: 'getBlockNumber', params: [] })
    expect(calls[0]?.authorization).toBe(`Basic ${Buffer.from('nimiq:hunter2').toString('base64')}`)
  })

  it('answers -32601 to a method outside the four, and nothing reaches upstream', async () => {
    const { url, calls } = await startRelay()
    const response = await post(url, rpc('unlockAccount', ['NQ...', 'pass', 0]))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32601)
    expect(calls).toHaveLength(0)
  })

  it('refuses batches, GETs, oversized bodies, and answers preflight', async () => {
    const { url, calls } = await startRelay({ maxBodyBytes: 200 })
    expect((await post(url, [rpc('getBlockNumber')])).status).toBe(200) // JSON-RPC error, not HTTP
    expect((await fetch(url)).status).toBe(405)
    expect((await post(url, JSON.stringify(rpc('getTransactionByHash', ['ab'.repeat(200)])))).status).toBe(413)
    const preflight = await fetch(url, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST')
    expect(calls).toHaveLength(0)
  })

  it('rate limits per client with 429 + Retry-After', async () => {
    const { url } = await startRelay({ readCapacity: 2, readRefillPerMinute: 1 })
    expect((await post(url, rpc('getBlockNumber'))).status).toBe(200)
    expect((await post(url, rpc('getBlockNumber'))).status).toBe(200)
    const limited = await post(url, rpc('getBlockNumber'))
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
  })

  it('broadcast has its own tighter bucket and a kill switch that answers 403 — a definite rejection', async () => {
    const raw = '00'.repeat(166)
    const off = await startRelay({ broadcastEnabled: false })
    expect((await post(off.url, rpc('sendRawTransaction', [raw]))).status).toBe(403)
    expect(off.calls).toHaveLength(0)

    const tight = await startRelay({ broadcastCapacity: 1, broadcastRefillPerMinute: 1 })
    expect((await post(tight.url, rpc('sendRawTransaction', [raw]))).status).toBe(200)
    expect((await post(tight.url, rpc('sendRawTransaction', [raw]))).status).toBe(429)
    // Reads are untouched by the broadcast bucket.
    expect((await post(tight.url, rpc('getBlockNumber'))).status).toBe(200)
  })

  it('upstream trouble is 502 — ambiguous to the app, never a definite rejection', async () => {
    const down = await startRelay({
      fetchImpl: () => Promise.reject(new Error('connect refused')),
    })
    expect((await post(down.url, rpc('getBlockNumber'))).status).toBe(502)

    const flaky = await startRelay({
      fetchImpl: () => Promise.resolve(new Response('teapot', { status: 500 })),
    })
    expect((await post(flaky.url, rpc('getBlockNumber'))).status).toBe(502)
  })
})
