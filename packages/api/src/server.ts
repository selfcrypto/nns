/**
 * `node:http` around the route handler. Six read-only routes do not earn a
 * framework dependency; everything with behaviour worth testing lives in
 * `routes.ts`, and this file only moves bytes.
 *
 * The cross-cutting response headers live here, not there — `content-type`,
 * `cache-control` and now CORS are true of every response whatever the route
 * decided, and threading them through a pure `(method, url) → {status, body}`
 * function would put them in the assertion of every route test that has
 * nothing to say about them.
 */

import { createServer as createHttpServer, type Server } from 'node:http'

import type { Logger } from '@nns/indexer'

import type { RouteHandler } from './routes.js'

/**
 * Open to any origin, because a resolver whose answers a browser cannot read
 * is a resolver that cannot be in anyone's quorum.
 *
 * §8.5 asks a client to ask **several independent endpoints** and compare; in
 * a browser every one of them but its own origin is a cross-origin fetch. An
 * operator who publishes an endpoint without this gets the worst failure
 * available: `curl` answers perfectly, the service looks healthy, and it is
 * invisible to every page that tries to use it. Nothing here is private —
 * public read-only chain data, no credentials, no cookies — so there is no
 * origin worth naming, and this is the posture `packages/relay` and
 * `packages/delegate` already take.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'content-type, accept',
  'access-control-max-age': '86400',
  /**
   * A browser reads no response header it was not told to. Without this a page
   * can fetch `/log` and not learn which checkpoint the bytes end at or what
   * hash was committed for them — the whole of §8.2 verification, unreachable
   * from the client the spec is written for.
   */
  'access-control-expose-headers': 'x-nns-checkpoint-height, x-nns-log-hash',
} as const

export function createServer(handle: RouteHandler, logger?: Logger): Server {
  return createHttpServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? '/'
    const started = Date.now()

    // Answered here rather than by the routes: a preflight asks about the
    // transport, names no resource, and the handler would call it a 405.
    if (method === 'OPTIONS') {
      response.writeHead(204, { ...CORS, 'cache-control': 'no-store' })
      response.end()
      logger?.debug('api.request', { method, url, status: 204, ms: Date.now() - started })
      return
    }

    void (async () => {
      const { status, body, contentType, headers } = await handle(method, url)
      const payload = body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(JSON.stringify(body))
      response.writeHead(status, {
        'content-type': contentType ?? 'application/json; charset=utf-8',
        'content-length': payload.length,
        // Resolution answers go stale a block later; never let a proxy pin one.
        'cache-control': 'no-store',
        ...CORS,
        ...headers,
      })
      response.end(method === 'HEAD' ? undefined : payload)
      logger?.debug('api.request', { method, url, status, ms: Date.now() - started })
    })().catch((error: unknown) => {
      logger?.error('api.request.failed', {
        method,
        url,
        error: error instanceof Error ? error.message : String(error),
      })
      if (!response.headersSent) {
        const payload = JSON.stringify({ error: 'INTERNAL' })
        response.writeHead(500, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
          // A 500 a page cannot read is a 500 that reads as a network failure,
          // and §8.5's client is required to tell those apart.
          ...CORS,
        })
        response.end(method === 'HEAD' ? undefined : payload)
      } else {
        response.destroy()
      }
    })
  })
}
