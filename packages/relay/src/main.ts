/**
 * Boot from environment. Fails fast on a missing upstream — a relay that
 * starts without one would answer 502 to everything and look like a node
 * outage.
 *
 * Defaults bind 127.0.0.1: exposure is an explicit opt-in via
 * NNS_RELAY_LISTEN_HOST, because the intended deployment puts a TLS
 * terminator (or tunnel) in front, and the node's own port stays LAN-bound
 * behind basic auth either way.
 */

import { createRelay } from './server.js'

const env = process.env

const required = (name: string): string => {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    console.error(`${name} is required`)
    process.exit(1)
  }
  return value
}

const optionalNumber = (name: string): number | undefined => {
  const value = env[name]
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`${name} must be a positive number`)
    process.exit(1)
  }
  return parsed
}

const flag = (name: string, fallback: boolean): boolean => {
  const value = env[name]
  if (value === undefined || value.trim() === '') return fallback
  return value !== '0' && value.toLowerCase() !== 'false'
}

const upstreamUrl = required('NNS_RELAY_UPSTREAM_URL')
const user = env['NNS_RELAY_UPSTREAM_USER']
const password = env['NNS_RELAY_UPSTREAM_PASSWORD']

const server = createRelay({
  upstreamUrl,
  ...(user === undefined ? {} : { upstreamUser: user }),
  ...(password === undefined ? {} : { upstreamPassword: password }),
  broadcastEnabled: flag('NNS_RELAY_BROADCAST', true),
  trustForwardedFor: flag('NNS_RELAY_TRUST_FORWARDED_FOR', false),
  ...(optionalNumber('NNS_RELAY_READ_PER_MINUTE') === undefined
    ? {}
    : { readRefillPerMinute: optionalNumber('NNS_RELAY_READ_PER_MINUTE') as number }),
  ...(optionalNumber('NNS_RELAY_BROADCAST_PER_MINUTE') === undefined
    ? {}
    : { broadcastRefillPerMinute: optionalNumber('NNS_RELAY_BROADCAST_PER_MINUTE') as number }),
})

const port = optionalNumber('NNS_RELAY_LISTEN_PORT') ?? 8641
const host = env['NNS_RELAY_LISTEN_HOST'] ?? '127.0.0.1'

server.listen(port, host, () => {
  console.log(`nns relay listening on ${host}:${port}, upstream ${new URL(upstreamUrl).host}`)
})
