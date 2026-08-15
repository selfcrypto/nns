/**
 * `node:http` around the route handler. Two routes earn a framework even less
 * than the API's six did; everything with behaviour worth testing is in
 * `routes.ts`, and this file only moves bytes.
 */

import { createServer as createHttpServer, type Server } from 'node:http'

import type { RouteHandler } from './routes.js'
import type { Logger } from './logger.js'

export function createServer(handle: RouteHandler, logger?: Logger): Server {
  return createHttpServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? '/'
    const started = Date.now()

    let status = 500
    try {
      const result = handle(method, url)
      status = result.status
      const payload = result.body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(result.body))
      response.writeHead(status, {
        ...(payload.length === 0 ? {} : { 'content-type': 'application/json; charset=utf-8' }),
        'content-length': payload.length,
        ...result.headers,
      })
      response.end(method === 'HEAD' ? undefined : payload)
    } catch (caught: unknown) {
      logger?.error('delegate.request.failed', {
        method,
        url,
        error: caught instanceof Error ? caught.message : String(caught),
      })
      if (!response.headersSent) {
        const payload = JSON.stringify({ error: 'INTERNAL' })
        response.writeHead(500, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        })
        response.end(method === 'HEAD' ? undefined : payload)
      } else {
        response.destroy()
      }
    }
    logger?.debug('delegate.request', { method, url, status, ms: Date.now() - started })
  })
}
