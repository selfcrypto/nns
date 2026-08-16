/**
 * The allowlist, enforced by parse-and-reconstruct — never inspect-and-
 * forward. The relay parses strict JSON-RPC, validates and clamps every
 * parameter, and the server builds a **fresh** upstream request from the
 * values returned here. Forwarding client bytes after inspection is how
 * aliasing bugs happen (duplicate JSON keys that two parsers read
 * differently, and the node's parser wins); reconstruction kills the class.
 *
 * What a wrong allowlist reaches on this node is why this file is tests,
 * not a regex: the node's wallet holds the battery roles and the validator
 * address, lock state is shared across connections, and `sendBasicTransaction`
 * spends from whatever is unlocked (docs/rpc-reference.md §5).
 */

export const ALLOWED_METHODS = [
  'getBlockNumber',
  'getTransactionByHash',
  'getTransactionsByAddress',
  'sendRawTransaction',
] as const

export type AllowedMethod = (typeof ALLOWED_METHODS)[number]

/** A signed basic transaction is ~166 bytes; 1 KB of hex is generous and refuses bulk. */
export const MAX_RAW_TX_HEX_CHARS = 2048
/** The node's own default page size; the clamp keeps a client from asking for more. */
export const MAX_HISTORY_RESULTS = 500

export type Screened =
  | { readonly ok: true; readonly method: AllowedMethod; readonly params: readonly unknown[]; readonly id: string | number | null }
  | { readonly ok: false; readonly body: string }

const HASH = /^[0-9a-f]{64}$/i
const RAW_TX = /^(?:[0-9a-f]{2})+$/i
// Loose on purpose: the node validates addresses for real. This bound only
// stops arbitrary payloads riding in the field.
const ADDRESS = /^[0-9A-Za-z ]{1,45}$/

const refusal = (id: string | number | null, code: number, message: string): Screened => ({
  ok: false,
  body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
})

const accepted = (id: string | number | null, method: AllowedMethod, params: readonly unknown[]): Screened => ({
  ok: true,
  method,
  params,
  id,
})

export function screen(bodyText: string): Screened {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return refusal(null, -32700, 'parse error')
  }
  // A JSON-RPC batch multiplies cost and slips past per-request limits.
  if (Array.isArray(parsed)) return refusal(null, -32600, 'batch requests are not accepted')
  if (typeof parsed !== 'object' || parsed === null) return refusal(null, -32600, 'expected a JSON-RPC request object')

  const request = parsed as Record<string, unknown>
  const rawId = request['id']
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null
  if (request['jsonrpc'] !== '2.0') return refusal(id, -32600, 'jsonrpc must be "2.0"')

  const method = request['method']
  if (typeof method !== 'string' || !(ALLOWED_METHODS as readonly string[]).includes(method)) {
    return refusal(id, -32601, `this relay serves exactly: ${ALLOWED_METHODS.join(', ')}`)
  }

  const params = request['params'] === undefined ? [] : request['params']
  if (!Array.isArray(params)) return refusal(id, -32602, 'params must be an array')

  switch (method as AllowedMethod) {
    case 'getBlockNumber': {
      if (params.length !== 0) return refusal(id, -32602, 'getBlockNumber takes no params')
      return accepted(id, 'getBlockNumber', [])
    }

    case 'getTransactionByHash': {
      const hash: unknown = params[0]
      if (params.length !== 1 || typeof hash !== 'string' || !HASH.test(hash)) {
        return refusal(id, -32602, 'getTransactionByHash takes one 64-hex transaction hash')
      }
      return accepted(id, 'getTransactionByHash', [hash.toLowerCase()])
    }

    case 'getTransactionsByAddress': {
      if (params.length < 1 || params.length > 3) {
        return refusal(id, -32602, 'getTransactionsByAddress takes [address, max?, startAt?]')
      }
      const address: unknown = params[0]
      if (typeof address !== 'string' || !ADDRESS.test(address)) {
        return refusal(id, -32602, 'address must be a Nimiq address string')
      }
      const rawMax: unknown = params.length >= 2 ? params[1] : MAX_HISTORY_RESULTS
      if (typeof rawMax !== 'number' || !Number.isInteger(rawMax) || rawMax < 1) {
        return refusal(id, -32602, `max must be an integer 1..${MAX_HISTORY_RESULTS}`)
      }
      const max = Math.min(rawMax, MAX_HISTORY_RESULTS)
      const startAt: unknown = params.length === 3 ? params[2] : null
      if (startAt !== null && (typeof startAt !== 'string' || !HASH.test(startAt))) {
        return refusal(id, -32602, 'startAt must be null or a 64-hex transaction hash')
      }
      return accepted(id, 'getTransactionsByAddress', [address, max, startAt === null ? null : startAt.toLowerCase()])
    }

    case 'sendRawTransaction': {
      const rawTx: unknown = params[0]
      if (params.length !== 1 || typeof rawTx !== 'string' || !RAW_TX.test(rawTx)) {
        return refusal(id, -32602, 'sendRawTransaction takes one hex-encoded signed transaction')
      }
      if (rawTx.length > MAX_RAW_TX_HEX_CHARS) {
        return refusal(id, -32602, `transaction exceeds ${MAX_RAW_TX_HEX_CHARS / 2} bytes`)
      }
      return accepted(id, 'sendRawTransaction', [rawTx.toLowerCase()])
    }
  }
}
