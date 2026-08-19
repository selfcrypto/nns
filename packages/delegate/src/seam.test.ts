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
 * `https://<host>/<parent>/<label>` and fetches it. That step still has
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

/** The parent the request carries since r23, and one of the names `FILE` serves. */
const PARENT = 'binance'
/** A second name on the same host — the arrangement r25 made the normal one. */
const OTHER = 'kraken'

const FILE: LabelFile = parseLabelFile({
  defaultTtl: 300,
  names: {
    binance: { shop: addr(1), pay: { address: addr(2), ttl: 60 }, forever: { address: addr(3), ttl: 86_400 } },
    kraken: { shop: addr(4) },
  },
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

const ask = async (fetchImpl: HttpFetch, label: string, host = HOST, parent = PARENT) =>
  await askDelegate(fetchImpl, new DelegateCache(), host, parent, label, 5_000)

async function failure(fetchImpl: HttpFetch, label: string, host = HOST, parent = PARENT): Promise<DelegateError> {
  let caught: unknown
  try {
    await ask(fetchImpl, label, host, parent)
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
    expect(asked).toEqual([`https://${HOST}/${PARENT}/shop`])
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
    // Nothing is configured on the server side: the prefix comes from the `D`
    // host, arrives in the URL the client builds, and is ignored as the
    // location it is.
    asked.length = 0
    const fetchImpl = await delegate()
    const result = await ask(fetchImpl, 'shop', `${HOST}/binance`)
    expect(asked).toEqual([`https://${HOST}/binance/${PARENT}/shop`])
    expect(result.response.address).toBe(expected(1))
  })

  it('asks once and then serves from the cache', async () => {
    const fetchImpl = await delegate()
    const cache = new DelegateCache()
    asked.length = 0
    await askDelegate(fetchImpl, cache, HOST, PARENT, 'shop', 5_000)
    await askDelegate(fetchImpl, cache, HOST, PARENT, 'shop', 5_000)
    expect(asked).toHaveLength(1)
  })
})

describe('two names, one host — the arrangement r23 enabled and r25 made ordinary', () => {
  it('serves each name its own address from a single process', async () => {
    const fetchImpl = await delegate()
    expect((await ask(fetchImpl, 'shop', HOST, PARENT)).response.address).toBe(expected(1))
    expect((await ask(fetchImpl, 'shop', HOST, OTHER)).response.address).toBe(expected(4))
  })

  it('keeps the client cache separate per parent, so one answer never serves the other', async () => {
    // The r22 defect end to end: one bare host, two names, `shop` meaning two
    // different payment addresses. Through r22 the second lookup returned the
    // first's answer — from the request shape *and* from a cache keyed on
    // host and label alone.
    const fetchImpl = await delegate()
    const cache = new DelegateCache()
    const first = await askDelegate(fetchImpl, cache, HOST, PARENT, 'shop', 5_000)
    const second = await askDelegate(fetchImpl, cache, HOST, OTHER, 'shop', 5_000)
    expect(first.response.address).toBe(expected(1))
    expect(second.response.address).toBe(expected(4))
  })

  it('reports a label held by the other name as the one failure code', async () => {
    // `pay` exists on this host, under `binance`. Asked under `kraken` it must
    // be indistinguishable from a host that is simply down.
    const fetchImpl = await delegate()
    expect((await failure(fetchImpl, 'pay', HOST, OTHER)).code).toBe('DELEGATE_FAILED')
  })

  it('reports a name the host does not serve at all as the same code', async () => {
    const fetchImpl = await delegate()
    expect((await failure(fetchImpl, 'shop', HOST, 'coinbase')).code).toBe('DELEGATE_FAILED')
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
      await askDelegate(rewriting(port), new DelegateCache(), HOST, PARENT, 'shop', 50)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DelegateError)
    expect((caught as DelegateError).code).toBe('DELEGATE_FAILED')
  })
})
