import { describe, expect, it } from 'vitest'

import { addressFromBytes, formatAddress } from '@nns/core'

import { parseLabelFile, type LabelFile } from './labels.js'
import { createRoutes, type RouteOptions } from './routes.js'
import type { LabelSource } from './store.js'

const addr = (fill: number): string => formatAddress(addressFromBytes(new Uint8Array(20).fill(fill)))

const source = (file: LabelFile, loadedAt = 1_700_000_000_000): LabelSource => ({
  current: () => file,
  loadedAt: () => loadedAt,
})

const FILE = parseLabelFile({
  version: 1,
  name: 'binance',
  defaultTtl: 300,
  labels: { shop: addr(1), pay: { address: addr(2), ttl: 60 } },
})

const routes = (options?: RouteOptions) => createRoutes(source(FILE), options)

describe('GET /delegated/v1/{parent}/{label}', () => {
  it('answers §8.6 step 3 exactly — address and ttl, nothing else', () => {
    const response = routes()('GET', '/delegated/v1/binance/shop')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ address: addr(1), ttl: 300 })
    // Not the §16.5 signed variant: no timestamp, no sig, not even empty.
    expect(Object.keys(response.body as object)).toEqual(['address', 'ttl'])
  })

  it("carries the label's own ttl into the body and the cache header", () => {
    const response = routes()('GET', '/delegated/v1/binance/pay')
    expect(response.body).toEqual({ address: addr(2), ttl: 60 })
    expect(response.headers['cache-control']).toBe('public, max-age=60')
  })

  it('answers a label it does not hold with 404 NO_ANSWER, uncacheable', () => {
    const response = routes()('GET', '/delegated/v1/binance/nope')
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'NO_ANSWER' })
    // An owner adding this label a minute from now must not be shadowed.
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('rejects a label that is not §4.4 syntax, with no case folding of its own', () => {
    for (const label of ['SHOP', '-shop', 'shop-', 'a--b', 'x'.repeat(25)]) {
      const response = routes()('GET', `/delegated/v1/binance/${label}`)
      expect(response.status, label).toBe(400)
      expect(response.body).toEqual({ error: 'BAD_LABEL' })
    }
  })

  it('decodes a percent-escaped label, and rejects a malformed escape', () => {
    expect(routes()('GET', '/delegated/v1/binance/%73hop').body).toEqual({ address: addr(1), ttl: 300 })
    expect(routes()('GET', '/delegated/v1/binance/%zz').status).toBe(400)
  })

  it('ignores a query string', () => {
    expect(routes()('GET', '/delegated/v1/binance/shop?t=1').status).toBe(200)
  })

  it('does not answer a deeper or shorter path', () => {
    expect(routes()('GET', '/delegated/v1/binance/shop/extra').status).toBe(404)
    expect(routes()('GET', '/delegated/v1/binance/').status).toBe(404)
    expect(routes()('GET', '/delegated/v2/binance/shop').status).toBe(404)
    expect(routes()('GET', '/delegated/binance/shop').status).toBe(404)
    expect(routes()('GET', '/resolve/shop').status).toBe(404)
  })

  it('does not answer the retired r22 label-only path', () => {
    // The break is deliberate and must stay loud: a client still speaking the
    // old shape gets nothing at all, rather than an answer that might belong
    // to another name. `@nns/resolver` never falls back to it — a downgrade on
    // 404 would keep the shared-namespace shape reachable forever.
    expect(routes()('GET', '/nns/v1/resolve/shop').status).toBe(404)
    expect(routes()('GET', '/nns/v1/resolve/shop').body).toEqual({ error: 'NOT_FOUND' })
  })
})

describe('the parent segment, which is what r23 added', () => {
  it('answers for the name the file declares', () => {
    expect(routes()('GET', '/delegated/v1/binance/shop').status).toBe(200)
  })

  it('refuses a parent this file does not answer for — with NO_ANSWER, not a distinguishable error', () => {
    // The whole defect r23 closed: through r22 this request was indistinguishable
    // from the one above, so a second name delegating to this host was served
    // binance's addresses. It must not be distinguishable from an unheld label
    // either, or a client could learn which names a host serves.
    const wrongParent = routes()('GET', '/delegated/v1/kraken/shop')
    const unheldLabel = routes()('GET', '/delegated/v1/binance/nope')
    expect(wrongParent.status).toBe(404)
    expect(wrongParent.body).toEqual({ error: 'NO_ANSWER' })
    expect(wrongParent.body).toEqual(unheldLabel.body)
    expect(wrongParent.headers['cache-control']).toBe('no-store')
  })

  it('rejects a parent that is not §4.1 syntax', () => {
    for (const parent of ['BINANCE', '-binance', 'binance-', 'a--b', 'x'.repeat(25), '12345']) {
      const response = routes()('GET', `/delegated/v1/${parent}/shop`)
      expect(response.status, parent).toBe(400)
      expect(response.body, parent).toEqual({ error: 'BAD_PARENT' })
    }
  })

  it('accepts a short parent a fired U released — validateNameSyntax, not validateName', () => {
    // `nq` is reserved by rule (§4.1, r18) and `validateName` would reject it,
    // but a fired `U` makes it an ordinary name a delegate may answer for.
    const file = parseLabelFile({ version: 1, name: 'nq', defaultTtl: 300, labels: { shop: addr(1) } })
    expect(createRoutes(source(file))('GET', '/delegated/v1/nq/shop').status).toBe(200)
  })
})

describe('CORS and methods', () => {
  it('allows any origin — a delegate exists to be asked by anyone', () => {
    // Without this the whole flow fails in a browser and passes every test.
    for (const url of ['/delegated/v1/binance/shop', '/delegated/v1/binance/nope', '/healthz', '/nowhere']) {
      expect(routes()('GET', url).headers['access-control-allow-origin'], url).toBe('*')
    }
  })

  it('answers preflight with 204 and no body', () => {
    const response = routes()('OPTIONS', '/delegated/v1/binance/shop')
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
    expect(response.headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS')
  })

  it('refuses a write method and says what it allows', () => {
    const response = routes()('POST', '/delegated/v1/binance/shop')
    expect(response.status).toBe(405)
    expect(response.headers['allow']).toBe('GET, HEAD, OPTIONS')
  })
})

describe('base path', () => {
  it('serves under a prefix a §6 D host may name', () => {
    const handle = routes({ basePath: '/binance' })
    expect(handle('GET', '/binance/delegated/v1/binance/shop').status).toBe(200)
    // Unprefixed is not this delegate's namespace.
    expect(handle('GET', '/delegated/v1/binance/shop').status).toBe(404)
  })

  it('puts healthz under the prefix too, so two delegates behind one proxy are distinguishable', () => {
    const handle = routes({ basePath: '/binance' })
    expect(handle('GET', '/binance/healthz').status).toBe(200)
    expect(handle('GET', '/healthz').status).toBe(404)
  })
})

describe('GET /healthz', () => {
  it('reports the file being served', () => {
    const response = createRoutes(source(FILE, 1_700_000_000_000))('GET', '/healthz')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, name: 'binance', labels: 2, loadedAt: 1_700_000_000 })
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('reads the current file on every request, not a snapshot taken at construction', () => {
    let file = FILE
    const handle = createRoutes({ current: () => file, loadedAt: () => 0 })
    file = parseLabelFile({ version: 1, name: 'binance', labels: { shop: addr(9) } })
    expect(handle('GET', '/delegated/v1/binance/shop').body).toEqual({ address: addr(9), ttl: 300 })
    expect(handle('GET', '/healthz').body).toMatchObject({ labels: 1 })
  })
})
