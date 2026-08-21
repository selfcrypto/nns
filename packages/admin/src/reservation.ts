/**
 * Where a `U` finds out whether the name it names is still reserved.
 *
 * **The gap this closes was measured, not imagined.** On 2026-08-21 a `u nimiq`
 * printed a clean plan — correct payload, correct recipient, no refusal — and
 * the broadcast forfeited `NAME_NOT_RESERVED` in block 59478946. The plan was
 * built entirely from the message: `encodeUnreserve` validates the name's
 * *shape*, and nothing anywhere read what the name currently **is**.
 *
 * The reducer's `U` case has two rows the message cannot answer on its own
 * (`reduce.ts`): `validateName` for §4.1, and `isReserved(state, name)` —
 * which is `isReservedName(name) && !state.unreserved.has(name)`. The first
 * half is a `core` constant and free; the second half is chain state, and the
 * CLI holds no state. Hence this module.
 *
 * **The source is the API's `GET /available/{name}`**, whose contract already
 * separates the two cases the reducer separates: `available: false` with
 * `reason: RESERVED` means "on the published list and not released by a fired
 * `U`" — `isReserved` exactly — while `TAKEN` (REGISTERED or GRACE), a §4.1
 * reason, or plain availability all mean the `U` would forfeit. No other
 * endpoint answers this: `/name/{name}` speaks only for REGISTERED names, and
 * a name released by a `U` and never registered is simply available.
 *
 * Like `params.ts`, this decides nothing protocol-shaped. It parses a
 * response and stamps it with the height it was read at.
 */

import { AdminError } from './cli.js'

/**
 * How far behind the node the answer may be before the plan says so, in
 * blocks (~17 min) — the sibling of `PARAMS_LAG_LIMIT`, for the same reason:
 * §7.2 step 3 has the indexer trail the chain by finality, so a small lag is
 * normal and a large one means the reservation was read from a state the
 * chain has moved past. A warning, never a refusal: the stale reading that
 * matters here — RESERVED when a `U` has since fired — costs a forfeited
 * message and its dust, and refusing on lag would block real work every time
 * the indexer falls behind.
 */
export const RESERVATION_LAG_LIMIT = 1_000

/** `GET /available/{name}`, as a `U` needs it. */
export interface NameAvailability {
  readonly name: string
  readonly available: boolean
  /** Present iff not available: a §4.1 reason code, `RESERVED`, or `TAKEN`. */
  readonly reason: string | null
  /** With `reason: TAKEN` — `REGISTERED` or `GRACE`. */
  readonly status: string | null
  /** With `reason: TAKEN` — when the current term ends. */
  readonly expiry: number | null
  /** The API's "as of" stamp — the indexer head the snapshot was read at. */
  readonly height: number
  /** The URL it came from, so the plan can name it. */
  readonly url: string
}

export interface ReservationSource {
  fetchAvailability(name: string): Promise<NameAvailability>
}

/**
 * The one state in which a `U` is not forfeited: on the reserved list (or
 * short-reserved by §4.1) and not yet released by a fired `U`. This is the
 * API's spelling of `core`'s `isReserved(state, name)`, and the mapping is
 * the endpoint's documented contract rather than a reading of ours.
 */
export function isReservedNow(availability: NameAvailability): boolean {
  return !availability.available && availability.reason === 'RESERVED'
}

/**
 * Why this name is not reservable, in the operator's words — the sentence a
 * plan prints instead of a bare token. `NAME_NOT_RESERVED` is what the log
 * will say; it does not say whether the name was never on the list, was
 * released last year, or belongs to somebody right now.
 */
export function describeAvailability(availability: NameAvailability): string {
  const { available, reason, status, expiry } = availability
  if (available) {
    return 'AVAILABLE — a fired U already released it, or it was never reserved; either way there is nothing left to release'
  }
  if (reason === 'TAKEN') {
    const owner = status === 'GRACE' ? 'in GRACE (renewable, so still taken)' : 'REGISTERED to somebody'
    return `TAKEN — ${owner}${expiry === null ? '' : `, term ends ${expiry}`}; it left RESERVED when a U fired for it`
  }
  if (reason === 'RESERVED') return 'RESERVED'
  return `not registrable: ${reason ?? 'no reason given'} (§4.1)`
}

function height(value: unknown, field: string, url: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AdminError(`${url} answered ${field} = ${JSON.stringify(value)} — expected a block height`)
  }
  return value
}

function optionalString(value: unknown, field: string, url: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new AdminError(`${url} answered ${field} = ${JSON.stringify(value)} — expected a string`)
  }
  return value
}

export function parseAvailability(body: unknown, url: string): NameAvailability {
  if (typeof body !== 'object' || body === null) {
    throw new AdminError(`${url} answered ${JSON.stringify(body)} — expected an /available document`)
  }
  const raw = body as Record<string, unknown>
  const available = raw['available']
  if (typeof available !== 'boolean') {
    throw new AdminError(`${url} answered available = ${JSON.stringify(available)} — expected a boolean`)
  }
  const name = raw['name']
  if (typeof name !== 'string') {
    throw new AdminError(`${url} answered name = ${JSON.stringify(name)} — expected the name it was asked about`)
  }
  const expiry = raw['expiry']
  return Object.freeze({
    name,
    available,
    reason: optionalString(raw['reason'], 'reason', url),
    status: optionalString(raw['status'], 'status', url),
    expiry: expiry === null || expiry === undefined ? null : height(expiry, 'expiry', url),
    height: height(raw['height'], 'height', url),
    url,
  })
}

/**
 * `GET {baseUrl}/available/{name}` over plain `fetch`. The error names the
 * URL, for `params.ts`'s reason: a bare `TypeError: fetch failed` naming
 * neither URL nor attempt is a defect this package does not need to repeat.
 */
export function createReservationSource(baseUrl: string): ReservationSource {
  const base = `${baseUrl.replace(/\/+$/, '')}/available`
  return {
    async fetchAvailability(name: string): Promise<NameAvailability> {
      const url = `${base}/${encodeURIComponent(name)}`
      let response: Response
      try {
        response = await fetch(url, { headers: { accept: 'application/json' } })
      } catch (cause) {
        throw new AdminError(`GET ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
      if (!response.ok) {
        throw new AdminError(`GET ${url} answered ${response.status} ${response.statusText}`)
      }
      let body: unknown
      try {
        body = await response.json()
      } catch (cause) {
        throw new AdminError(`GET ${url} did not answer JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
      return parseAvailability(body, url)
    },
  }
}
