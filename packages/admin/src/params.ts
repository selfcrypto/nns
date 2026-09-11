/**
 * Where a `P` finds out what it is changing.
 *
 * One of §10.6's bounds is **relative** — the commission may move at most
 * `COMMISSION_MAX_STEP` from the one in effect — and it cannot be checked from
 * the message alone, so the CLI has to read the registry's current state before
 * it can say whether the message it just built would be accepted. The two price
 * rate limits that used to sit beside it (`PRICE_MAX_FACTOR`,
 * `PRICE_MIN_INTERVAL`) were removed in r20; what is left for the prices is a
 * range check the message carries its own answer to, plus the `LARGE_MOVE_FACTOR`
 * warning, which needs the active prices all the same.
 *
 * **The source is the API's `GET /params`**, not the indexer's database and
 * not a node: it already serves exactly these four values — the active prices
 * (one base fee and the commission since 2026-09-11; the bands are `core`'s
 * frozen multipliers, not state, so `/params.fees` is not read here),
 * `lastGovernanceHeight`, any pending change, and the height it read them at —
 * off a `READ ONLY` snapshot, and it is the same read every other client makes.
 * The height it stamps is what makes the answer checkable: the plan prints it,
 * so a dry run shows how far behind the node the bounds were checked.
 *
 * Nothing here decides anything protocol-shaped. It parses a response.
 */

import type { PendingGovernance, Prices } from '@nns/core'

import { apiBase, getJson, heightField, lunaField } from './api.js'
import { AdminError } from './cli.js'

/** `/params`, as a `P` needs it. */
export interface ActiveParams {
  /** The prices in effect at {@link height} — what §10.6's relative bounds are measured from. */
  readonly prices: Prices
  /** Height of the last accepted `P`, or `null` if none has been accepted since launch. */
  readonly lastGovernanceHeight: number | null
  /** A `P` already accepted and not yet in effect. */
  readonly pending: PendingGovernance | null
  /** The API's "as of" stamp — the indexer head the snapshot was read at. */
  readonly height: number
  /** The URL it came from, so the plan can name it. */
  readonly url: string
}

export interface ParamsSource {
  fetchParams(): Promise<ActiveParams>
}

function prices(value: unknown, field: string, url: string): Prices {
  if (typeof value !== 'object' || value === null) {
    throw new AdminError(`${url} answered ${field} = ${JSON.stringify(value)} — expected the base fee and the commission`)
  }
  const raw = value as Record<string, unknown>
  return {
    feeBase: lunaField(raw['feeBase'], `${field}.feeBase`, url),
    commissionBp: lunaField(raw['commissionBp'], `${field}.commissionBp`, url),
  }
}

export function parseParams(body: unknown, url: string): ActiveParams {
  if (typeof body !== 'object' || body === null) {
    throw new AdminError(`${url} answered ${JSON.stringify(body)} — expected a /params document`)
  }
  const raw = body as Record<string, unknown>
  const last = raw['lastGovernanceHeight']
  const pending = raw['pendingGovernance']
  return Object.freeze({
    prices: prices(raw['prices'], 'prices', url),
    lastGovernanceHeight: last === null || last === undefined ? null : heightField(last, 'lastGovernanceHeight', url),
    pending:
      pending === null || pending === undefined
        ? null
        : {
            prices: prices((pending as Record<string, unknown>)['prices'], 'pendingGovernance.prices', url),
            effectiveHeight: heightField(
              (pending as Record<string, unknown>)['effectiveHeight'],
              'pendingGovernance.effectiveHeight',
              url,
            ),
          },
    height: heightField(raw['height'], 'height', url),
    url,
  })
}

/** `GET {baseUrl}/params`. */
export function createParamsSource(baseUrl: string): ParamsSource {
  const url = `${apiBase(baseUrl)}/params`
  return {
    async fetchParams(): Promise<ActiveParams> {
      return parseParams(await getJson(url), url)
    },
  }
}
