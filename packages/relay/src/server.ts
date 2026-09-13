/**
 * The relay server. One POST endpoint; parse-and-reconstruct through
 * `allowlist.ts`; per-IP read and broadcast buckets plus a global broadcast
 * ceiling and a kill switch; CORS open (the clients are browsers); the node
 * credential attached upstream and nowhere else.
 *
 * Refusal semantics matter to the app's truthfulness rules — a broken
 * checker must never read as a negative result:
 * everything refused **before** the upstream call answers 4xx — a definite
 * "the node did not act" — while upstream trouble answers 502, which the
 * app correctly treats as ambiguous.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { screen } from './allowlist.js'
import { createBuckets, type Buckets } from './limits.js'

export interface RelayOptions {
  readonly upstreamUrl: string
  readonly upstreamUser?: string
  readonly upstreamPassword?: string
  /** The broadcast kill switch: reads stay up while sends are refused (403). */
  readonly broadcastEnabled?: boolean
  /** Trust x-forwarded-for only when something trustworthy actually sets it. */
  readonly trustForwardedFor?: boolean
  readonly readCapacity?: number
  readonly readRefillPerMinute?: number
  readonly broadcastCapacity?: number
  readonly broadcastRefillPerMinute?: number
  readonly globalBroadcastPerMinute?: number
  readonly maxBodyBytes?: number
  readonly maxConcurrentUpstream?: number
  readonly upstreamTimeoutMs?: number
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  /** Counters and status lines only — never request bodies. */
  readonly log?: (line: string) => void
}

const GLOBAL_KEY = '*'

export function createRelay(options: RelayOptions): Server {
  const {
    upstreamUrl,
    broadcastEnabled = true,
    trustForwardedFor = false,
    maxBodyBytes = 16_384,
    maxConcurrentUpstream = 8,
    upstreamTimeoutMs = 10_000,
    fetchImpl = fetch,
    log = (line) => console.log(line),
  } = options

  const nowOption = options.now === undefined ? {} : { now: options.now }
  const readBuckets: Buckets = createBuckets({
    capacity: options.readCapacity ?? 30,
    refillPerMinute: options.readRefillPerMinute ?? 60,
    ...nowOption,
  })
  const broadcastBuckets: Buckets = createBuckets({
    capacity: options.broadcastCapacity ?? 5,
    refillPerMinute: options.broadcastRefillPerMinute ?? 5,
    ...nowOption,
  })
  const globalBroadcast: Buckets = createBuckets({
    capacity: options.globalBroadcastPerMinute ?? 60,
    refillPerMinute: options.globalBroadcastPerMinute ?? 60,
    ...nowOption,
  })

  /**
   * Blank is absent, not empty.
   *
   * A node with no credentials configured leaves `NNS_RELAY_UPSTREAM_USER` and
   * `_PASSWORD` blank in the environment — the documented default — and `''`
   * is not `undefined`. Without this the relay sends `Basic Og==`, a
   * credential of `":"`, on every upstream call: a node that ignores it works,
   * and anything that validates a presented credential 401s the lot, which
   * the relay maps to 502 and the app reads as a node outage.
   *
   * Trimmed, not just emptied, because `packages/indexer/src/env.ts` reads the
   * same two values that way and a deployment points both at one node — the
   * same `.env` must not yield two different credentials.
   */
  const credential = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim()
    return trimmed === undefined || trimmed === '' ? undefined : trimmed
  }

  const upstreamUser = credential(options.upstreamUser)
  const upstreamPassword = credential(options.upstreamPassword)

  const authHeader =
    upstreamUser !== undefined && upstreamPassword !== undefined
      ? `Basic ${Buffer.from(`${upstreamUser}:${upstreamPassword}`).toString('base64')}`
      : null

  let inFlight = 0
  let served = 0

  const clientKey = (request: IncomingMessage): string => {
    if (trustForwardedFor) {
      const forwarded = request.headers['x-forwarded-for']
      const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
      if (first !== undefined && first !== '') return first
    }
    return request.socket.remoteAddress ?? 'unknown'
  }

  const respond = (response: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void => {
    response.writeHead(status, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      ...extra,
    })
    response.end(body)
  }

  return createServer((request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type, accept',
        'access-control-max-age': '86400',
      })
      response.end()
      return
    }
    if (request.method !== 'POST') {
      respond(response, 405, JSON.stringify({ error: 'POST only' }), { allow: 'POST' })
      return
    }

    const chunks: Buffer[] = []
    let received = 0
    let refused = false
    request.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > maxBodyBytes) {
        refused = true
        respond(response, 413, JSON.stringify({ error: `body over ${maxBodyBytes} bytes` }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (refused) return
      void handle(Buffer.concat(chunks).toString('utf8'), clientKey(request), response)
    })
  })

  async function handle(bodyText: string, key: string, response: ServerResponse): Promise<void> {
    const screened = screen(bodyText)
    if (!screened.ok) {
      log(`refused ${key} allowlist`)
      respond(response, 200, screened.body)
      return
    }

    const broadcast = screened.method === 'sendRawTransaction'
    if (broadcast && !broadcastEnabled) {
      // 403, deliberately: a pre-upstream refusal is a *definite* rejection
      // and the app may safely report the send as failed.
      log(`refused ${key} broadcast-disabled`)
      respond(response, 403, JSON.stringify({ error: 'broadcasting is disabled on this relay' }))
      return
    }

    const limit = broadcast
      ? [broadcastBuckets.take(key), globalBroadcast.take(GLOBAL_KEY)].reduce((a, b) => (a.ok ? b : a))
      : readBuckets.take(key)
    if (!limit.ok) {
      log(`refused ${key} rate ${screened.method}`)
      respond(response, 429, JSON.stringify({ error: 'rate limited' }), { 'retry-after': String(limit.retryAfterSec) })
      return
    }

    if (inFlight >= maxConcurrentUpstream) {
      respond(response, 429, JSON.stringify({ error: 'busy' }), { 'retry-after': '1' })
      return
    }

    inFlight += 1
    const startedAt = Date.now()
    try {
      const upstream = await fetchImpl(upstreamUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(authHeader === null ? {} : { authorization: authHeader }),
        },
        // Reconstructed from validated values — never the client's bytes.
        body: JSON.stringify({ jsonrpc: '2.0', id: screened.id, method: screened.method, params: screened.params }),
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      })
      const text = await upstream.text()
      if (upstream.status !== 200) {
        respond(response, 502, JSON.stringify({ error: 'upstream unavailable' }))
      } else {
        respond(response, 200, text)
      }
      served += 1
      if (served % 500 === 0) {
        readBuckets.prune()
        broadcastBuckets.prune()
      }
      log(`ok ${key} ${screened.method} ${upstream.status} ${Date.now() - startedAt}ms`)
    } catch {
      // Timeout or connection failure: ambiguous by nature, so 502 — the
      // app must not read it as a definite rejection.
      log(`upstream-error ${key} ${screened.method}`)
      respond(response, 502, JSON.stringify({ error: 'upstream unavailable' }))
    } finally {
      inFlight -= 1
    }
  }
}
