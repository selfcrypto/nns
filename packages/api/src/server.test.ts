/**
 * The transport's own behaviour: the headers every response carries whatever
 * the route decided, and the preflight the routes never see.
 *
 * Route status codes and bodies are `routes.test.ts`'s subject; nothing here
 * asserts one beyond what it takes to reach a header.
 */

import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import type { ApiResponse, RouteHandler } from './routes.js'
import { createServer } from './server.js'

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

async function start(handle: RouteHandler): Promise<string> {
  const server = createServer(handle)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

const ok: RouteHandler = () => Promise.resolve<ApiResponse>({ status: 200, body: { ok: true } })

describe('CORS', () => {
  it('opens every response to any origin — 200, 404 and 500 alike', async () => {
    const url = await start((_method, path) => {
      if (path === '/boom') throw new Error('boom')
      if (path === '/nope') return Promise.resolve<ApiResponse>({ status: 404, body: { error: 'UNKNOWN_ROUTE' } })
      return Promise.resolve<ApiResponse>({ status: 200, body: { ok: true } })
    })

    for (const [path, status] of [
      ['/params', 200],
      ['/nope', 404],
      ['/boom', 500],
    ] as const) {
      const response = await fetch(`${url}${path}`)
      expect(response.status, path).toBe(status)
      expect(response.headers.get('access-control-allow-origin'), path).toBe('*')
    }
  })

  it('answers a preflight itself, without consulting the routes', async () => {
    let calls = 0
    const url = await start((method, path) => {
      calls += 1
      return Promise.resolve<ApiResponse>({ status: 405, body: { error: 'METHOD_NOT_ALLOWED', method, path } })
    })

    const response = await fetch(url, { method: 'OPTIONS' })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS')
    expect(response.headers.get('access-control-allow-headers')).toBe('content-type, accept')
    expect(response.headers.get('access-control-max-age')).toBe('86400')
    expect(await response.text()).toBe('')
    expect(calls).toBe(0)
  })

  it('exposes the two headers §8.2 verification is carried in, and leaves them intact', async () => {
    // `/log`'s shape: raw bytes, a content type of its own, and the pair the
    // anchor publisher and any browser verifier read off the response.
    const url = await start(() =>
      Promise.resolve<ApiResponse>({
        status: 200,
        body: new TextEncoder().encode('58177017 0 aa11\n'),
        contentType: 'text/plain; charset=utf-8',
        headers: { 'x-nns-checkpoint-height': '58177020', 'x-nns-log-hash': `0x${'44'.repeat(32)}` },
      }),
    )

    const response = await fetch(`${url}/log`)

    const exposed = response.headers.get('access-control-expose-headers')?.split(',').map((part) => part.trim())
    expect(exposed).toEqual(['x-nns-checkpoint-height', 'x-nns-log-hash'])
    expect(response.headers.get('x-nns-checkpoint-height')).toBe('58177020')
    expect(response.headers.get('x-nns-log-hash')).toBe(`0x${'44'.repeat(32)}`)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await response.text()).toBe('58177017 0 aa11\n')
  })

  it('keeps cache-control on every answer — a pinned resolution is a wrong one', async () => {
    const url = await start(ok)
    const response = await fetch(`${url}/params`)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await fetch(url, { method: 'OPTIONS' })).headers.get('cache-control')).toBe('no-store')
  })

  it('answers HEAD with the headers and no body', async () => {
    const url = await start(ok)
    const response = await fetch(`${url}/params`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.text()).toBe('')
  })
})
