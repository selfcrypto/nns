/**
 * The seam: this server answered by the client that will actually ask it.
 *
 * Everything else in this package tests the delegate against its own idea of
 * §8.6. This file runs the real `node:http` server and drives
 * `@nns/resolver`'s `askDelegate` at it — the reference host and the reference
 * client meeting over a socket, which is the only place a disagreement about
 * the URL shape or the body could show up.
 *
 * **The `https://` in `askDelegate` is not relaxed for this.** §8.6 fixes the
 * scheme and the client hardcodes it correctly; the test injects an
 * `HttpFetch` that rewrites the origin to loopback. An "allow http" flag would
 * be a flag someone eventually sets in production.
 *
 * What that rewrite does *not* cover is URL construction from a host recorded
 * on chain — `D` lands, the indexer stores the host, the client builds
 * `https://<host>/nns/v1/resolve/<label>` and fetches it. That step still has
 * never run end to end; `tasks/10-delegate.md` and the battery runbook say so
 * plainly rather than treating this file as the coverage.
 */

import { createServer as createHttpServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { addressFromBytes, formatAddress } from '@nns/core'
import { DelegateCache, DelegateError, MAX_DELEGATE_TTL_SEC, askDelegate, type HttpFetch } from '@nns/resolver'

import { parseLabelFile, type LabelFile } from './labels.js'
import { createRoutes, type RouteOptions } from './routes.js'
import { createServer } from './server.js'
import type { LabelSource } from './store.js'

const addr = (fill: number): string => formatAddress(addressFromBytes(new Uint8Array(20).fill(fill)))
const expected = (fill: number): string => addressFromBytes(new Uint8Array(20).fill(fill))

/** The host a `D` would name. Only the origin is rewritten; the path is the client's. */
const HOST = 'nns.example.com'

const FILE: LabelFile = parseLabelFile({
  version: 1,
  name: 'binance',
  defaultTtl: 300,
  labels: { shop: addr(1), pay: { address: addr(2), ttl: 60 }, forever: { address: addr(3), ttl: 86_400 } },
})

const source: LabelSource = { current: () => FILE, loadedAt: () => 0 }

const open: Server[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function listen(server: Server): Promise<number> {
  open.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

/** Requests the client builds, in full, so the URL shape is asserted rather than assumed. */
const asked: string[] = []

function rewriting(port: number): HttpFetch {
  return async (url, init) => {
    asked.push(url)
    const response = await fetch(url.replace(`https://${HOST}`, `http://127.0.0.1:${port}`), init)
    return { ok: response.ok, status: response.status, json: () => response.json() }
  }
}

async function delegate(options?: RouteOptions): Promise<HttpFetch> {
  return rewriting(await listen(createServer(createRoutes(source, options))))
}

const ask = async (fetchImpl: HttpFetch, label: string, host = HOST) =>
  await askDelegate(fetchImpl, new DelegateCache(), host, label, 5_000)

async function failure(fetchImpl: HttpFetch, label: string, host = HOST): Promise<DelegateError> {
  let caught: unknown
  try {
    await ask(fetchImpl, label, host)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(DelegateError)
  return caught as DelegateError
}

describe('the reference client against the reference host', () => {
  it('resolves a label, at the URL §8.6 fixes', async () => {
    asked.length = 0
    const result = await ask(await delegate(), 'shop')
    expect(asked).toEqual([`https://${HOST}/nns/v1/resolve/shop`])
    expect(result.response.address).toBe(expected(1))
    expect(result.ttl).toBe(300)
  })

  it("carries the label's own ttl", async () => {
    expect((await ask(await delegate(), 'pay')).ttl).toBe(60)
  })

  it('caps a long ttl at the client, not at the host', async () => {
    // The host is entitled to say a day; §8.6 step 4 is what refuses to
    // believe it for longer than an hour.
    const result = await ask(await delegate(), 'forever')
    expect(result.response.ttl).toBe(86_400)
    expect(result.ttl).toBe(MAX_DELEGATE_TTL_SEC)
  })

  it('reaches a host mounted under a path, as a §6 D host may name', async () => {
    asked.length = 0
    const fetchImpl = await delegate({ basePath: '/binance' })
    const result = await ask(fetchImpl, 'shop', `${HOST}/binance`)
    expect(asked).toEqual([`https://${HOST}/binance/nns/v1/resolve/shop`])
    expect(result.response.address).toBe(expected(1))
  })

  it('asks once and then serves from the cache', async () => {
    const fetchImpl = await delegate()
    const cache = new DelegateCache()
    asked.length = 0
    await askDelegate(fetchImpl, cache, HOST, 'shop', 5_000)
    await askDelegate(fetchImpl, cache, HOST, 'shop', 5_000)
    expect(asked).toHaveLength(1)
  })
})

describe('every failure is one outcome', () => {
  it('a label the host does not hold is DELEGATE_FAILED, not a missing subdomain', async () => {
    const error = await failure(await delegate(), 'nope')
    expect(error.code).toBe('DELEGATE_FAILED')
    expect(error.parent).toBeNull()
  })

  it('a host that is not listening is the same code, indistinguishable from the 404', async () => {
    // This is the property the whole design rests on: NNS can never report
    // that a subdomain does not exist, because it cannot tell that case from a
    // dead host.
    const server = createHttpServer(() => {})
    const port = await listen(server)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    open.length = 0

    const dead = await failure(rewriting(port), 'shop')
    const missing = await failure(await delegate(), 'nope')
    expect(dead.code).toBe(missing.code)
    expect(dead.code).toBe('DELEGATE_FAILED')
  })

  it('a body that is not §8.6 shape is the host failing, not a malformed document', async () => {
    // Left uncaught this reads as DOCUMENT_MALFORMED — the code a *resolver*
    // serving a broken §8.3 document earns — which would blame our own
    // infrastructure for a third party's mistake.
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ addr: addr(1), ttl: 300 }))
    })
    const error = await failure(rewriting(await listen(server)), 'shop')
    expect(error.code).toBe('DELEGATE_FAILED')
    expect(error.message).toContain("not §8.6's shape")
  })

  it('a host that answers 500 is the same code again', async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'INTERNAL' }))
    })
    expect((await failure(rewriting(await listen(server)), 'shop')).code).toBe('DELEGATE_FAILED')
  })

  it('a host that never answers times out into the same code', async () => {
    const server = createHttpServer(() => {
      // Deliberately no response: the timeout is the client's, not the host's.
    })
    const port = await listen(server)
    let caught: unknown
    try {
      await askDelegate(rewriting(port), new DelegateCache(), HOST, 'shop', 50)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DelegateError)
    expect((caught as DelegateError).code).toBe('DELEGATE_FAILED')
  })
})
