/**
 * `node:http` around the route handler. Six read-only routes do not earn a
 * framework dependency; everything with behaviour worth testing lives in
 * `routes.ts`, and this file only moves bytes.
 */

import { createServer as createHttpServer, type Server } from 'node:http'

import type { Logger } from '@nns/indexer'

import type { RouteHandler } from './routes.js'

export function createServer(handle: RouteHandler, logger?: Logger): Server {
  return createHttpServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? '/'
    const started = Date.now()

    void (async () => {
      const { status, body } = await handle(method, url)
      const payload = JSON.stringify(body)
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        // Resolution answers go stale a block later; never let a proxy pin one.
        'cache-control': 'no-store',
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
        })
        response.end(method === 'HEAD' ? undefined : payload)
      } else {
        response.destroy()
      }
    })
  })
}
