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
  defaultTtl: 300,
  names: {
    binance: { shop: addr(1), pay: { address: addr(2), ttl: 60 } },
    // A second name on the same host, so every check below runs against a
    // file that actually has a roster to keep separate.
    kraken: { shop: addr(7) },
  },
})

const routes = (options?: RouteOptions) => createRoutes(source(FILE), options)

describe('GET /{parent}/{label}', () => {
  it('answers §8.6 step 3 exactly — address and ttl, nothing else', () => {
    const response = routes()('GET', '/binance/shop')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ address: addr(1), ttl: 300 })
    // Not the §16.5 signed variant: no timestamp, no sig, not even empty.
    expect(Object.keys(response.body as object)).toEqual(['address', 'ttl'])
  })

  it("carries the label's own ttl into the body and the cache header", () => {
    const response = routes()('GET', '/binance/pay')
    expect(response.body).toEqual({ address: addr(2), ttl: 60 })
    expect(response.headers['cache-control']).toBe('public, max-age=60')
  })

  it('answers a label it does not hold with 404 NO_ANSWER, uncacheable', () => {
    const response = routes()('GET', '/binance/nope')
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'NO_ANSWER' })
    // An owner adding this label a minute from now must not be shadowed.
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('rejects a label that is not §4.4 syntax, with no case folding of its own', () => {
    for (const label of ['SHOP', '-shop', 'shop-', 'a--b', 'x'.repeat(25)]) {
      const response = routes()('GET', `/binance/${label}`)
      expect(response.status, label).toBe(400)
      expect(response.body).toEqual({ error: 'BAD_LABEL' })
    }
  })

  it('decodes a percent-escaped label, and rejects a malformed escape', () => {
    expect(routes()('GET', '/binance/%73hop').body).toEqual({ address: addr(1), ttl: 300 })
    expect(routes()('GET', '/binance/%zz').status).toBe(400)
  })

  it('ignores a query string', () => {
    expect(routes()('GET', '/binance/shop?t=1').status).toBe(200)
  })

  it('needs two segments — a shorter path is not a lookup', () => {
    expect(routes()('GET', '/binance/').status).toBe(404)
    expect(routes()('GET', '/binance').status).toBe(404)
    expect(routes()('GET', '/').status).toBe(404)
  })

  it('reads a longer path as a mount, and the last two segments as the lookup', () => {
    // Not a rejection, which is what it was through r24: with no marker to
    // scan for, depth is exactly what a mount looks like. `/binance/shop/extra`
    // is therefore a lookup for `extra` under a parent `shop`, and 404s
    // because this file holds no such name — not because the shape is wrong.
    const deep = routes()('GET', '/binance/shop/extra')
    expect(deep.status).toBe(404)
    expect(deep.body).toEqual({ error: 'NO_ANSWER' })
  })

  it('answers an r24 URL, because a `delegated` prefix is now just a mount', () => {
    // The marker r25 removed cannot come back as a *second shape* — there is
    // one shape, `<parent>/<label>`, and `/delegated/…` in front of it is a
    // path this server was told nothing about, exactly like `/alice/…`. So an
    // un-migrated client keeps working and no namespace is shared to do it:
    // the parent is still in the request, which is the property r23 bought and
    // the only one the no-fallback rule protects. The break that must stay
    // loud runs the other way — an r25 client against an r24 delegate, which
    // scans for a marker this URL no longer carries.
    expect(routes()('GET', '/delegated/binance/shop').body).toEqual({ address: addr(1), ttl: 300 })
    expect(routes()('GET', '/delegated/v1/binance/shop').body).toEqual({ address: addr(1), ttl: 300 })
  })

  it('does not answer the retired r22 label-only path', () => {
    // The break is deliberate and must stay loud: a client still speaking the
    // old shape gets nothing at all, rather than an answer that might belong
    // to another name. `@nns/resolver` never falls back to it — a downgrade on
    // 404 would keep the shared-namespace shape reachable forever. It reads as
    // a lookup for `shop` under a parent `resolve` now, which this file has no
    // more than it had the old route.
    expect(routes()('GET', '/nns/v1/resolve/shop').status).toBe(404)
    expect(routes()('GET', '/nns/v1/resolve/shop').body).toEqual({ error: 'NO_ANSWER' })
  })
})

describe('the parent segment, which is what r23 added', () => {
  it('answers for the name the file declares', () => {
    expect(routes()('GET', '/binance/shop').status).toBe(200)
  })

  it('refuses a parent this file does not answer for — with NO_ANSWER, not a distinguishable error', () => {
    // The whole defect r23 closed: through r22 this request was indistinguishable
    // from the one above, so a second name delegating to this host was served
    // binance's addresses. It must not be distinguishable from an unheld label
    // either, or a client could learn which names a host serves.
    const wrongParent = routes()('GET', '/coinbase/shop')
    const unheldLabel = routes()('GET', '/binance/nope')
    expect(wrongParent.status).toBe(404)
    expect(wrongParent.body).toEqual({ error: 'NO_ANSWER' })
    expect(wrongParent.body).toEqual(unheldLabel.body)
    expect(wrongParent.headers['cache-control']).toBe('no-store')
  })

  it('rejects a parent that is not §4.1 syntax', () => {
    for (const parent of ['BINANCE', '-binance', 'binance-', 'a--b', 'x'.repeat(25), '12345']) {
      const response = routes()('GET', `/${parent}/shop`)
      expect(response.status, parent).toBe(400)
      expect(response.body, parent).toEqual({ error: 'BAD_PARENT' })
    }
  })

  it('accepts a short parent a fired U released — validateNameSyntax, not validateName', () => {
    // `nq` is reserved by rule (§4.1, r18) and `validateName` would reject it,
    // but a fired `U` makes it an ordinary name a delegate may answer for.
    const file = parseLabelFile({ defaultTtl: 300, names: { nq: { shop: addr(1) } } })
    expect(createRoutes(source(file))('GET', '/nq/shop').status).toBe(200)
  })
})

describe('one host, many names — what r25 made the normal case', () => {
  it('answers each name from its own namespace, in one process', () => {
    expect(routes()('GET', '/binance/shop').body).toEqual({ address: addr(1), ttl: 300 })
    expect(routes()('GET', '/kraken/shop').body).toEqual({ address: addr(7), ttl: 300 })
  })

  it('does not leak a label across names', () => {
    // `pay` exists under binance only. Answering it for kraken is the r22
    // defect — one flat namespace behind a bare host, with a payment address
    // as the wrong answer.
    expect(routes()('GET', '/binance/pay').status).toBe(200)
    expect(routes()('GET', '/kraken/pay').status).toBe(404)
  })

  it('makes an unserved name and an unheld label the same answer, byte for byte', () => {
    // With a roster in one file this stops being theoretical: the host knows
    // which names it serves, and a caller must not be able to find out.
    const unservedName = routes()('GET', '/coinbase/shop')
    const unheldLabel = routes()('GET', '/binance/nope')
    const wrongName = routes()('GET', '/kraken/pay')
    expect(unservedName).toEqual(unheldLabel)
    expect(wrongName).toEqual(unheldLabel)
  })
})

describe('CORS and methods', () => {
  it('allows any origin — a delegate exists to be asked by anyone', () => {
    // Without this the whole flow fails in a browser and passes every test.
    for (const url of ['/binance/shop', '/binance/nope', '/healthz', '/nowhere']) {
      expect(routes()('GET', url).headers['access-control-allow-origin'], url).toBe('*')
    }
  })

  it('answers preflight with 204 and no body', () => {
    const response = routes()('OPTIONS', '/binance/shop')
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
    expect(response.headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS')
  })

  it('refuses a write method and says what it allows', () => {
    const response = routes()('POST', '/binance/shop')
    expect(response.status).toBe(405)
    expect(response.headers['allow']).toBe('GET, HEAD, OPTIONS')
  })
})

describe('where the server is mounted is not its business', () => {
  it('answers under any prefix, with nothing configured', () => {
    // A §6 `D` host may carry a short path, and the client builds the URL from
    // the recorded host, so the prefix arrives here and no proxy can strip it.
    // It says where the delegate listens, never which name is asked about —
    // and since r25 the word `delegated` is one such prefix rather than the
    // protocol's own, so the operator may choose it, another, or none.
    for (const url of [
      '/binance/shop',
      '/delegated/binance/shop',
      '/some/deep/mount/binance/shop',
    ]) {
      expect(routes()('GET', url).body, url).toEqual({ address: addr(1), ttl: 300 })
    }
  })

  it('takes the parent from the request, never from the prefix', () => {
    // The prefix cannot add to, contradict or stand in for the parent —
    // `/kraken/…` asking for `binance` is still a `binance` lookup.
    expect(routes()('GET', '/kraken/binance/shop').body).toEqual({ address: addr(1), ttl: 300 })
    expect(routes()('GET', '/binance/kraken/shop').body).toEqual({ address: addr(7), ttl: 300 })
  })

  it('resolves a name spelled like the mount, which counting from the end keeps apart', () => {
    // The reason the scan runs from the end and not the front: a name, a label
    // and a mount may all be spelled `delegated`, and only the position in the
    // path decides which is which.
    const file = parseLabelFile({ names: { delegated: { shop: addr(5) } } })
    const handle = createRoutes(source(file))
    expect(handle('GET', '/delegated/shop').body).toEqual({ address: addr(5), ttl: 300 })
    expect(handle('GET', '/delegated/delegated/shop').body).toEqual({ address: addr(5), ttl: 300 })
    expect(handle('GET', '/some/mount/delegated/shop').body).toEqual({ address: addr(5), ttl: 300 })
  })
})

describe('GET /healthz', () => {
  it('is the whole path, or it is not the probe', () => {
    expect(routes()('GET', '/healthz').status).toBe(200)
  })

  it('never shadows a label called healthz, because one segment is never a lookup', () => {
    // `healthz` is a valid §4.4 label, so an owner may hold `healthz.binance`,
    // and a lookup always carries a parent as well. Letting the probe match
    // under a prefix would answer that lookup with a health body — a wrong
    // address, silently — so the ambiguity falls to the lookup every time.
    const file = parseLabelFile({ names: { binance: { healthz: addr(6) } } })
    const handle = createRoutes(source(file))
    expect(handle('GET', '/binance/healthz').body).toEqual({ address: addr(6), ttl: 300 })
  })

  it('reads as a lookup under a mount the proxy did not strip, and 404s', () => {
    // The cost of the line above, stated so it is not discovered in
    // production: behind `location /delegated/` with no rewrite, the probe URL
    // is two segments and this server cannot tell it from a lookup for
    // `healthz` under a parent named after the mount. Probe the container —
    // which is what the compose healthcheck does — or the mount root behind a
    // proxy that strips.
    expect(routes()('GET', '/delegated/healthz').status).toBe(404)
    expect(routes()('GET', '/delegated/healthz').body).toEqual({ error: 'NO_ANSWER' })
  })

  it('reports counts, and never the names themselves', () => {
    const response = createRoutes(source(FILE, 1_700_000_000_000))('GET', '/healthz')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, names: 2, labels: 3, loadedAt: 1_700_000_000 })
    expect(response.headers['cache-control']).toBe('no-store')
    // The roster is not the caller's. A public vhost serves this endpoint, and
    // listing parents here would be the bulk listing endpoint this package
    // forbids — the same property the NO_ANSWER collapse protects.
    expect(JSON.stringify(response.body)).not.toContain('binance')
    expect(JSON.stringify(response.body)).not.toContain('kraken')
  })

  it('reads the current file on every request, not a snapshot taken at construction', () => {
    let file = FILE
    const handle = createRoutes({ current: () => file, loadedAt: () => 0 })
    file = parseLabelFile({ names: { binance: { shop: addr(9) } } })
    expect(handle('GET', '/binance/shop').body).toEqual({ address: addr(9), ttl: 300 })
    expect(handle('GET', '/healthz').body).toMatchObject({ names: 1, labels: 1 })
  })
})
