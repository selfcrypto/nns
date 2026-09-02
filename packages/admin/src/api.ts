/**
 * The one HTTP read every API source shares, and the two field parsers the
 * documents have in common. `params.ts`, `reservation.ts` and `burn.ts` each
 * carried their own copy of these until 2026-09-02; the copies were identical
 * to the character, which is what a shared module is for.
 *
 * The error names the URL: the first live run of the settlement reconciler
 * produced a bare `TypeError: fetch failed` naming neither URL nor attempt,
 * which is a defect this package does not need to repeat.
 */

import { AdminError } from './cli.js'

/** `NNS_API_URL` with any trailing slash gone, so paths join without doubling. */
export function apiBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** `GET url` as JSON; every failure is an `AdminError` naming the URL. */
export async function getJson(url: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } })
  } catch (cause) {
    throw new AdminError(`GET ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (!response.ok) throw new AdminError(`GET ${url} answered ${response.status} ${response.statusText}`)
  try {
    return await response.json()
  } catch (cause) {
    throw new AdminError(`GET ${url} did not answer JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** Luna and basis points cross the wire as decimal strings; `bigint` is the unit here. */
export function lunaField(value: unknown, field: string, url: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new AdminError(`${url} answered ${field} = ${JSON.stringify(value)} — expected a decimal string of luna`)
  }
  return BigInt(value)
}

export function heightField(value: unknown, field: string, url: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AdminError(`${url} answered ${field} = ${JSON.stringify(value)} — expected a block height`)
  }
  return value
}
