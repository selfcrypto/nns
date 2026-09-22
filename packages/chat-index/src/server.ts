/**
 * The read endpoint. Three routes, CORS open to any origin — the app is a
 * static bundle anyone may host (§2.2), so an origin allowlist would break
 * the copies that mitigation exists to permit.
 *
 * The response carries `recipientData`, the payload exactly as it appeared on
 * chain, so the client re-parses with `@nns/chat` rather than trusting this
 * service's parse. `name` and `message` are here for readability and for this
 * service's own queries; they are not the client's source of truth.
 */

import { createServer, type Server, type ServerResponse } from 'node:http'

import type { Logger } from './logger.js'
import type { ChatRow, Store } from './store.js'

export interface ServerOptions {
  readonly store: Store
  readonly logger: Logger
  readonly maxPageSize: number
  /** Reported as the window: the height below which this index knows nothing. */
  readonly startHeight: number
  readonly scannedTo: () => number | undefined
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

/** A row as the client's parser takes it: the chain's shape. */
const wire = (row: ChatRow) => ({
  hash: row.txHash,
  blockNumber: row.blockNumber,
  timestamp: row.timestamp,
  from: row.sender,
  to: row.recipient,
  recipientData: row.recipientData,
  // Only executed transactions are ever stored, so this is constant — it is
  // here because the client's parser takes the chain's shape.
  executionResult: true,
})

const send = (response: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', ...CORS })
  response.end(text)
}

export function createChatServer(options: ServerOptions): Server {
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method === 'OPTIONS') {
        response.writeHead(204, CORS)
        response.end()
        return
      }
      if (request.method !== 'GET') {
        send(response, 405, { error: 'METHOD_NOT_ALLOWED', message: 'this service is read-only' })
        return
      }
      if (url.pathname === '/healthz') {
        send(response, 200, { ok: true, startHeight: options.startHeight, nextBatch: options.scannedTo() ?? null })
        return
      }

      const limitRaw = url.searchParams.get('limit')
      const limit = limitRaw === null ? options.maxPageSize : Number(limitRaw)
      if (!Number.isInteger(limit) || limit < 1) {
        send(response, 400, { error: 'BAD_LIMIT', message: 'limit must be a positive integer' })
        return
      }
      const capped = Math.min(limit, options.maxPageSize)

      // The forward tail: every message above a height, oldest first, for a
      // reader that follows the whole index rather than one address.
      if (url.pathname === '/messages') {
        const sinceRaw = url.searchParams.get('since')
        const since = sinceRaw === null ? Number.NaN : Number(sinceRaw)
        if (!Number.isInteger(since) || since < 0) {
          send(response, 400, { error: 'BAD_CURSOR', message: 'since must be a block height' })
          return
        }
        try {
          const rows = await options.store.messagesSince(since, capped)
          send(response, 200, {
            since,
            messages: rows.map(wire),
            window: { startHeight: options.startHeight, nextBatch: options.scannedTo() ?? null },
            // Where the next page starts, or null when this one was short.
            next: rows.length === capped ? (rows[rows.length - 1]?.blockNumber ?? null) : null,
          })
        } catch (error) {
          options.logger.error('chat.query.failed', { since, error })
          send(response, 500, { error: 'QUERY_FAILED', message: 'the index could not answer' })
        }
        return
      }

      const match = /^\/messages\/([^/]+)$/.exec(url.pathname)
      if (match === null) {
        send(response, 404, {
          error: 'UNKNOWN_ROUTE',
          message: 'this service serves /messages/{address}, /messages?since={height} and /healthz',
        })
        return
      }

      const address = decodeURIComponent(match[1] ?? '').toUpperCase()
      const beforeRaw = url.searchParams.get('before')
      const before = beforeRaw === null ? null : Number(beforeRaw)
      if (before !== null && (!Number.isInteger(before) || before < 0)) {
        send(response, 400, { error: 'BAD_CURSOR', message: 'before must be a block height' })
        return
      }

      try {
        const rows = await options.store.messagesFor(address, capped, before)
        const oldest = rows.length === capped ? (rows[rows.length - 1]?.blockNumber ?? null) : null
        send(response, 200, {
          address,
          messages: rows.map(wire),
          // What this index can honestly claim, always: never "no messages" as
          // if that were provable. Below `startHeight` it knows nothing, and
          // says so rather than implying an empty history.
          window: { startHeight: options.startHeight, nextBatch: options.scannedTo() ?? null },
          next: oldest,
        })
      } catch (error) {
        options.logger.error('chat.query.failed', { address, error })
        send(response, 500, { error: 'QUERY_FAILED', message: 'the index could not answer' })
      }
    })()
  })
}
