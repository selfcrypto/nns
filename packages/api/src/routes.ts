/**
 * The six read-only endpoints, as a pure `(method, url) → {status, body}`
 * function — testable without a socket, and the server file stays dumb.
 *
 * No protocol rules live here. Name syntax, address parsing and `MIN_PRICE`
 * all come from `@nns/core`; the one state-dependent judgement — that a name
 * resolves only while `REGISTERED` — is §7.3's rule as `core.resolve`
 * implements it, restated over a single row because the API reads rows, not
 * `NnsState`.
 *
 * Serialisation conventions, applied without exception:
 * - Luna amounts are decimal **strings** — `bigint` does not survive JSON,
 *   and a `number` would round.
 * - Heights are numbers.
 * - Addresses go out in the conventional spaced form; inputs are accepted
 *   with or without spaces (`parseAddress` handles both).
 * - Every state-derived response carries `height`, the snapshot it was read
 *   at (§8.7's first clock — what the answer is true *as of*).
 */

import {
  CONSTANTS,
  formatAddress,
  logFile,
  minPrice,
  parseQuery,
  tryParseAddress,
  validateName,
  type Address,
  type NameInvalidReason,
} from '@nns/core'

import { inclusionDocument, nonInclusionDocument, type ProofContext } from './proofs.js'
import {
  NotSyncedError,
  type ApiNameRecord,
  type ApiOffer,
  type LatestCheckpoint,
  type ProofBase,
  type Queries,
} from './queries.js'

export interface ApiResponse {
  readonly status: number
  /**
   * Already JSON-serialisable — no `bigint` may reach this field — or raw
   * bytes when `contentType` says so (`/log` serves the exact §8.2 file).
   */
  readonly body: unknown
  /** Defaults to JSON. */
  readonly contentType?: string
  readonly headers?: Readonly<Record<string, string>>
}

export interface RouteOptions {
  /** §4.1 rule 6 — must match the indexer's list. */
  readonly reservedNames: ReadonlySet<string>
  /** Listing fee for an `O` (§6 `O`), served by `/params`. */
  readonly listingFee: bigint
}

export type RouteHandler = (method: string, url: string) => Promise<ApiResponse>

/**
 * The six §8.1 digests, wire form. Shared by `/checkpoints/latest` and
 * `/checkpoints/{height}` so the two can never drift: a client that verifies
 * against one must be able to verify against the other with the same code,
 * and two copies of this object literal is exactly how that stops being true.
 */
function serialiseCheckpoint(value: LatestCheckpoint): Record<string, unknown> {
  return {
    height: value.height,
    layout: value.layout,
    nameRoot: `0x${value.nameRoot}`,
    pricesRoot: `0x${value.pricesRoot}`,
    pendingRoot: `0x${value.pendingRoot}`,
    unreservedRoot: value.unreservedRoot === null ? null : `0x${value.unreservedRoot}`,
    logHash: `0x${value.logHash}`,
    commitment: `0x${value.commitment}`,
  }
}

const respond = (status: number, body: unknown): ApiResponse => ({ status, body })

function serialiseRecord(record: ApiNameRecord): Record<string, unknown> {
  return {
    name: record.name,
    owner: formatAddress(record.owner),
    target: formatAddress(record.target),
    expiry: record.expiry,
    status: record.status,
    recovery: record.recovery === null ? null : formatAddress(record.recovery),
    host: record.host,
  }
}

function serialiseOffer(offer: ApiOffer): Record<string, unknown> {
  return {
    name: offer.name,
    seller: formatAddress(offer.seller),
    price: offer.price.toString(),
    openedHeight: offer.openedHeight,
    expiryHeight: offer.expiryHeight,
  }
}

export function createRoutes(queries: Queries, options: RouteOptions): RouteHandler {
  /** Effectively reserved: on the list and not released by a fired `U`. */
  const reserved = (name: string, unreserved: boolean): boolean =>
    options.reservedNames.has(name) && !unreserved

  /** `null` when the base cannot back proofs — no checkpoint, or a snapshot that does not reproduce the root. */
  const contextOf = (base: ProofBase | null): ProofContext | null =>
    base === null || base.records === null
      ? null
      : { records: base.records, nimiqHeight: base.checkpoint.height, rootHex: base.checkpoint.nameRoot }

  async function resolveRoute(name: string): Promise<ApiResponse> {
    // No reserved set on purpose: a reserved name awarded by a `U` (§6 `U`)
    // is registered and must resolve like any other.
    const parsed = parseQuery(name)
    if (!parsed.ok) {
      return respond(400, { error: 'INVALID_NAME', reason: parsed.reason, detail: parsed.detail })
    }
    if (parsed.query.kind === 'dotted') {
      // §8.6: delegated resolution is the client's job — it fetches the
      // parent (with proof, once proofs ship) and queries the delegate host
      // itself. An API that proxied the answer would launder an unverified
      // delegate response through a verified-looking endpoint.
      return respond(400, {
        error: 'DOTTED_QUERY',
        parent: parsed.query.parent,
        detail: 'resolve the parent via /name/{parent} and query its delegate host (§8.6)',
      })
    }

    const { height, value: record } = await queries.record(name)
    if (record === null) return respond(404, { error: 'NOT_FOUND', name, height })
    if (record.status === 'GRACE') {
      // §7.3: resolution is off during GRACE. The record still exists — the
      // owner can renew — so say which of the two absences this is.
      return respond(404, { error: 'IN_GRACE', name, expiry: record.expiry, height })
    }
    // The proof rides on its own clock (§8.7): it derives from the latest
    // checkpoint, so a name registered since simply has `proof: null` until
    // the next boundary — pending depth, not an error. The §8.3 document
    // carries the *checkpoint's* record, which may lag the live fields above.
    const base = await queries.proofBase()
    const context = contextOf(base.value)
    return respond(200, {
      name,
      target: formatAddress(record.target),
      status: record.status,
      expiry: record.expiry,
      host: record.host,
      proof: context === null ? null : inclusionDocument(context, name),
      height,
    })
  }

  async function availableRoute(name: string): Promise<ApiResponse> {
    const no = (height: number, reason: NameInvalidReason | 'TAKEN', extra?: Record<string, unknown>): ApiResponse =>
      respond(200, { name, available: false, reason, ...extra, height })

    const { height, value } = await queries.detail(name)

    // §4.1 order: structure first, the reserved list last — then state.
    const structural = validateName(name)
    if (!structural.ok) return no(height, structural.reason)
    if (reserved(name, value.unreserved)) return no(height, 'RESERVED')
    if (value.record !== null) {
      return no(height, 'TAKEN', { status: value.record.status, expiry: value.record.expiry })
    }

    // §8.5: the app checks availability via non-inclusion proof before
    // letting a user pay. `null` when the name is still in the checkpoint
    // tree (released since the boundary) or no checkpoint backs proofs yet.
    const base = await queries.proofBase()
    const context = contextOf(base.value)
    return respond(200, {
      name,
      available: true,
      proof: context === null ? null : nonInclusionDocument(context, name),
      height,
    })
  }

  async function nameRoute(name: string): Promise<ApiResponse> {
    // Structural check only: reserved names are legitimate subjects here.
    const structural = validateName(name)
    if (!structural.ok) return respond(400, { error: 'INVALID_NAME', reason: structural.reason })

    const { height, value } = await queries.detail(name)
    const isReserved = reserved(name, value.unreserved)
    const nothingKnown =
      value.record === null &&
      value.transfer === null &&
      value.recovery === null &&
      value.offer === null &&
      value.unreserve === null &&
      !isReserved &&
      !value.unreserved
    if (nothingKnown) return respond(404, { error: 'NOT_FOUND', name, height })

    return respond(200, {
      name,
      reserved: isReserved,
      unreserved: value.unreserved,
      record: value.record === null ? null : serialiseRecord(value.record),
      pending: {
        transfer:
          value.transfer === null
            ? null
            : {
                newOwner: formatAddress(value.transfer.newOwner),
                effectiveHeight: value.transfer.effectiveHeight,
                viaRecovery: value.transfer.viaRecovery,
              },
        recovery:
          value.recovery === null
            ? null
            : {
                // null clears the recovery address (§6 `R`) — a value, not an absence.
                recovery: value.recovery.recovery === null ? null : formatAddress(value.recovery.recovery),
                effectiveHeight: value.recovery.effectiveHeight,
              },
        offer: value.offer === null ? null : serialiseOffer(value.offer),
        unreserve:
          value.unreserve === null
            ? null
            : {
                // null releases, an address awards (§6 `U`, r17).
                recipient: value.unreserve.recipient === null ? null : formatAddress(value.unreserve.recipient),
                effectiveHeight: value.unreserve.effectiveHeight,
              },
      },
      height,
    })
  }

  async function addressRoute(input: string): Promise<ApiResponse> {
    const owner: Address | null = tryParseAddress(input)
    if (owner === null) return respond(400, { error: 'INVALID_ADDRESS' })

    const { height, value } = await queries.byOwner(owner)
    return respond(200, {
      address: formatAddress(owner),
      names: value.map((record) => ({
        name: record.name,
        target: formatAddress(record.target),
        expiry: record.expiry,
        status: record.status,
        host: record.host,
      })),
      height,
    })
  }

  async function checkpointRoute(): Promise<ApiResponse> {
    const { height, value } = await queries.latestCheckpoint()
    if (value === null) return respond(404, { error: 'NO_CHECKPOINT', height })
    return respond(200, { checkpoint: serialiseCheckpoint(value), height })
  }

  /**
   * One checkpoint by exact height (§8.1).
   *
   * Two callers, one endpoint. The anchor publisher needs a **matched pair** —
   * the commitment at H and the log snapshot through H must describe the same
   * instant — and `/log` already stamps the height it served in
   * `x-nns-checkpoint-height`. So the publisher reads `/log` first and then
   * asks for that exact checkpoint, instead of fetch-latest / fetch-log /
   * compare / retry, which loses a race at every boundary and can quietly
   * anchor a mismatched pair. And §8.5 #2's root half needs it: two resolvers
   * a checkpoint apart cannot have their roots compared at all today, so the
   * behind party's height can now be asked of the ahead party.
   *
   * **Four outcomes, four statuses**, because they are four different things
   * to do about it and collapsing them into one 404 tells a client nothing:
   *
   * | Case | Status | Code |
   * |---|---|---|
   * | Not an absolute multiple of `CHECKPOINT_INTERVAL` | 400 | `NOT_A_CHECKPOINT_HEIGHT` |
   * | A boundary above the newest retained | 404 | `CHECKPOINT_PENDING` |
   * | A boundary below the oldest retained | 410 | `CHECKPOINT_NOT_RETAINED` |
   * | A boundary inside the range, with no row | 404 | `CHECKPOINT_MISSING` |
   *
   * The first is a **client error and not a 404 of a real thing**: no
   * checkpoint can ever exist off a boundary, so the request is malformed in
   * the same way a fractional block height would be, and answering 404 would
   * invite a client to retry forever. The second will exist — the response
   * carries `latest` so the caller can compute the wait rather than poll
   * blind. The third is `410 Gone` because the resource is real and this
   * server does not have it; the honest phrasing is *not retained*, since the
   * API cannot distinguish "pruned" from "before this database's
   * `LAUNCH_HEIGHT`" and should not guess. The fourth should never happen —
   * the indexer writes every boundary — and means a gap in the retained
   * range, so it is 404 rather than 500 (retrying will not help) but names
   * itself differently so it can be alerted on.
   */
  async function checkpointAtRoute(raw: string): Promise<ApiResponse> {
    if (!/^[0-9]+$/.test(raw)) {
      return respond(400, { error: 'INVALID_HEIGHT', detail: 'height must be a decimal integer' })
    }
    const height = Number(raw)
    if (!Number.isSafeInteger(height)) {
      return respond(400, { error: 'INVALID_HEIGHT', detail: 'height is out of range' })
    }
    // The interval is `core`'s, never a literal here: a checkpoint schedule
    // restated in the API is a second implementation of §8.1's boundary rule.
    const interval = CONSTANTS.CHECKPOINT_INTERVAL
    if (height % interval !== 0) {
      return respond(400, {
        error: 'NOT_A_CHECKPOINT_HEIGHT',
        detail: `checkpoints are cut at absolute multiples of ${interval} (§8.1); ${height} is not one`,
        interval,
        nearest: { below: height - (height % interval), above: height - (height % interval) + interval },
      })
    }

    const { height: stateHeight, value } = await queries.checkpointAt(height)
    if (value.checkpoint !== null) {
      return respond(200, { checkpoint: serialiseCheckpoint(value.checkpoint), height: stateHeight })
    }

    const retained = value.retained
    if (retained === null) {
      return respond(404, { error: 'NO_CHECKPOINT', detail: 'this database holds no checkpoints yet', height: stateHeight })
    }
    if (height > retained.newest) {
      return respond(404, {
        error: 'CHECKPOINT_PENDING',
        detail: `the indexer has not reached ${height} yet`,
        latest: retained.newest,
        height: stateHeight,
      })
    }
    if (height < retained.oldest) {
      return respond(410, {
        error: 'CHECKPOINT_NOT_RETAINED',
        detail: `this server retains checkpoints from ${retained.oldest}; ${height} is older`,
        oldest: retained.oldest,
        height: stateHeight,
      })
    }
    return respond(404, {
      error: 'CHECKPOINT_MISSING',
      detail: `no checkpoint at ${height}, which is inside the retained range — this database has a gap`,
      oldest: retained.oldest,
      latest: retained.newest,
      height: stateHeight,
    })
  }

  async function logRoute(): Promise<ApiResponse> {
    const { value } = await queries.logThroughCheckpoint()
    if (value === null) return respond(404, { error: 'NO_CHECKPOINT' })
    // The exact §8.2 file bytes through the checkpoint, assembled by core:
    // keccak256 of this body IS the checkpoint's committed log hash, which is
    // what makes this endpoint verifiable rather than merely informative.
    return {
      status: 200,
      body: logFile(value.lines),
      contentType: 'text/plain; charset=utf-8',
      headers: {
        'x-nns-checkpoint-height': String(value.checkpointHeight),
        'x-nns-log-hash': `0x${value.logHash}`,
      },
    }
  }

  async function settlementsRoute(owedTo: string | null): Promise<ApiResponse> {
    let filter: Address | null = null
    if (owedTo !== null) {
      filter = tryParseAddress(owedTo)
      if (filter === null) return respond(400, { error: 'INVALID_ADDRESS' })
    }
    const { height, value } = await queries.outstanding(filter)
    return respond(200, {
      outstanding: value.map((obligation) => ({
        ref: { height: obligation.refHeight, txIndex: obligation.refTxIndex },
        ordinal: obligation.ordinal,
        kind: obligation.kind,
        owedBy: formatAddress(obligation.owedBy),
        owedTo: formatAddress(obligation.owedTo),
        amount: obligation.amount.toString(),
      })),
      height,
    })
  }

  async function burnRoute(): Promise<ApiResponse> {
    const { height, value } = await queries.burn()
    // 'OK' is §8.2's published verdict token for an accepted message — a
    // wire constant, like 'REGISTERED'. Rejected lines stay listed: an
    // attestation that forfeited is part of the auditable record (§10.2).
    let burned = 0n
    for (const line of value) {
      if (line.verdict === 'OK') burned += line.value
    }
    return respond(200, {
      burned: burned.toString(),
      attestations: value.map((line) => ({
        height: line.height,
        txIndex: line.txIndex,
        txHash: line.txHash,
        sender: formatAddress(line.sender),
        value: line.value.toString(),
        verdict: line.verdict,
      })),
      height,
    })
  }

  async function offersRoute(): Promise<ApiResponse> {
    const { height, value } = await queries.offers()
    return respond(200, { offers: value.map(serialiseOffer), height })
  }

  async function paramsRoute(): Promise<ApiResponse> {
    const { height, value } = await queries.params()
    const prices = {
      feeStandard: value.feeStandard,
      feeLong: value.feeLong,
      commissionBp: value.commissionBp,
    }
    return respond(200, {
      prices: {
        feeStandard: value.feeStandard.toString(),
        feeLong: value.feeLong.toString(),
        commissionBp: value.commissionBp.toString(),
      },
      // §3 MIN_PRICE is FEE_LONG *as in effect at this height* — core's rule,
      // applied to the active prices, never a constant (§6 `O`).
      minPrice: minPrice(prices).toString(),
      listingFee: options.listingFee.toString(),
      lastGovernanceHeight: value.lastGovernanceHeight,
      pendingGovernance:
        value.pending === null
          ? null
          : {
              prices: {
                feeStandard: value.pending.feeStandard.toString(),
                feeLong: value.pending.feeLong.toString(),
                commissionBp: value.pending.commissionBp.toString(),
              },
              effectiveHeight: value.pending.effectiveHeight,
            },
      height,
    })
  }

  return async function handle(method: string, url: string): Promise<ApiResponse> {
    if (method !== 'GET' && method !== 'HEAD') {
      return respond(405, { error: 'METHOD_NOT_ALLOWED' })
    }

    let segments: string[]
    let searchParams: URLSearchParams
    try {
      const parsed = new URL(url, 'http://api.invalid')
      segments = parsed.pathname.split('/').filter((s) => s !== '').map(decodeURIComponent)
      searchParams = parsed.searchParams
    } catch {
      return respond(400, { error: 'BAD_REQUEST' })
    }

    try {
      const [head, a, b] = segments
      if (head === 'resolve' && a !== undefined && segments.length === 2) return await resolveRoute(a)
      if (head === 'available' && a !== undefined && segments.length === 2) return await availableRoute(a)
      if (head === 'name' && a !== undefined && segments.length === 2) return await nameRoute(a)
      if (head === 'address' && a !== undefined && b === 'names' && segments.length === 3) {
        return await addressRoute(a)
      }
      if (head === 'offers' && segments.length === 1) return await offersRoute()
      if (head === 'params' && segments.length === 1) return await paramsRoute()
      if (head === 'checkpoints' && a !== undefined && segments.length === 2) {
        return a === 'latest' ? await checkpointRoute() : await checkpointAtRoute(a)
      }
      if (head === 'log' && segments.length === 1) return await logRoute()
      if (head === 'settlements' && segments.length === 1) {
        return await settlementsRoute(searchParams.get('owed_to'))
      }
      if (head === 'burn' && segments.length === 1) return await burnRoute()
      return respond(404, { error: 'UNKNOWN_ROUTE' })
    } catch (error) {
      if (error instanceof NotSyncedError) {
        return respond(503, { error: 'NOT_SYNCED', detail: error.message })
      }
      throw error
    }
  }
}
