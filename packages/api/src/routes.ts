/**
 * The read-only endpoints, as a pure `(method, url) → {status, body}`
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

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  CONSTANTS,
  feeFor,
  formatAddress,
  isReservedName,
  logFile,
  minPrice,
  parse,
  parseLogLine,
  parseQuery,
  requiredBid,
  tryParseAddress,
  validateNameSyntax,
  type Address,
  type NameInvalidReason,
  type Prices,
} from '@nns/core'

import { inclusionDocument, nonInclusionDocument, type ProofContext } from './proofs.js'
import {
  NotSyncedError,
  type ApiAuction,
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

/**
 * A log payload as readable text, for `/log/decoded` only.
 *
 * Bytes outside printable ASCII become `%xx`, and `%` itself becomes `%25`, so
 * the rendering is unambiguous and a malformed payload cannot smuggle a
 * newline into anything downstream. Every legitimate NNS payload is drawn from
 * `a-z 0-9 | . - /` and survives untouched, which is the entire point:
 * `NNS1Dalice|delegated.example.com` rather than `4e4e53314461…`.
 *
 * Lossy in neither direction, but it is **not** the canonical encoding — §8.2
 * commits to the hex, and `data` is carried beside this so a reader can check
 * the rendering rather than trust it.
 */
function renderPayload(hex: string): string | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null
  let out = ''
  for (let i = 0; i < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16)
    out += byte < 0x20 || byte > 0x7e || byte === 0x25 ? `%${byte.toString(16).padStart(2, '0')}` : String.fromCharCode(byte)
  }
  return out
}

interface DecodedEntry {
  readonly blockHeight: number
  readonly txIndex: number
  readonly verdict: string
  readonly message: string | null
  readonly type: string | null
}

/**
 * The decoded log as an aligned table, for a person with a browser.
 *
 * **The preamble is a safety device, not decoration.** `/log` is `text/plain`
 * too, so of the two views this is the one genuinely easy to mistake for the
 * artifact — saved, hashed, and believed. Every §8.2 line begins with a decimal
 * height, so a leading `#` cannot appear in one: this file can neither be
 * parsed as a log nor hash to anything that matches, and the first line says
 * why in words. The canonical hash is printed so a reader can go and check the
 * real thing rather than take this one on trust.
 *
 * Returned as bytes rather than a string because `server.ts` JSON-stringifies
 * anything that is not a `Uint8Array` — a string body would arrive quoted, with
 * its newlines escaped.
 */
function decodedTable(entries: readonly DecodedEntry[], checkpointHeight: number, logHash: string): Uint8Array {
  // Widths from the data, so the table stays tight instead of padded out to
  // MAX_DATA_BYTES for a log whose messages are mostly short.
  const width = (pick: (entry: DecodedEntry) => string, header: string): number =>
    entries.reduce((widest, entry) => Math.max(widest, pick(entry).length), header.length)

  const height = (entry: DecodedEntry): string => String(entry.blockHeight)
  const index = (entry: DecodedEntry): string => String(entry.txIndex)
  const message = (entry: DecodedEntry): string => entry.message ?? '(undecodable)'

  const wHeight = width(height, 'height')
  const wIndex = width(index, 'ix')
  const wMessage = width(message, 'message')

  const lines = [
    '# NNS log, DECODED — a derived view, NOT the §8.2 artifact.',
    `# Canonical bytes: /log   checkpoint ${checkpointHeight}   keccak256 0x${logHash}`,
    '#',
    `# ${'height'.padEnd(wHeight)}  ${'ix'.padStart(wIndex)}  type  ${'message'.padEnd(wMessage)}  verdict`,
  ]
  for (const entry of entries) {
    lines.push(
      `  ${height(entry).padEnd(wHeight)}  ${index(entry).padStart(wIndex)}  ` +
        `${(entry.type ?? '?').padEnd(4)}  ${message(entry).padEnd(wMessage)}  ${entry.verdict}`,
    )
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8')
}

/** Spaced for display where the address parses; the log's own bytes otherwise. */
const displayAddress = (compact: string): string => {
  const parsed = tryParseAddress(compact)
  return parsed === null ? compact : formatAddress(parsed)
}

/**
 * Every path this API serves, in one place.
 *
 * Two consumers, which is the point: the `UNKNOWN_ROUTE` body names them, so a
 * caller who guessed wrong is told what exists instead of being left to read
 * source; and `routes.test.ts` compares this list against `openapi.yaml`'s
 * `paths` and fails on any difference. A published contract that has quietly
 * stopped matching the server is worse than no published contract, and a
 * hand-maintained spec drifts the moment a route is added without one.
 *
 * Templated segments use OpenAPI's `{name}` form so the two lists compare
 * directly.
 */
export const ROUTES = Object.freeze([
  '/auctions',
  '/available/{name}',
  '/address/{addr}/names',
  '/burn',
  '/checkpoints/latest',
  '/checkpoints/{height}',
  '/log',
  '/log/decoded',
  '/name/{name}',
  '/offers',
  '/openapi.yaml',
  '/params',
  '/referrals/{name}',
  '/resolve/{name}',
  '/settlements',
])

/**
 * The OpenAPI document, read from the package rather than embedded.
 *
 * `../openapi.yaml` resolves the same from `src/` under Vitest and from
 * `dist/` in the container, which is why the path is built from
 * `import.meta.url` rather than `process.cwd()`. `openapi.yaml` is in the
 * package's `files`, so it ships.
 *
 * Read once and cached: it is static, and re-reading it per request would make
 * a documentation endpoint the only route that touches the disk on a hot path.
 * A read failure is a packaging error, so it throws and surfaces as a 500
 * rather than being reported as a missing route — the spec is not optional.
 */
let openapiDocument: Buffer | undefined
function openapiBytes(): Buffer {
  openapiDocument ??= readFileSync(fileURLToPath(new URL('../openapi.yaml', import.meta.url)))
  return openapiDocument
}

function serialiseRecord(record: ApiNameRecord): Record<string, unknown> {
  return {
    name: record.name,
    owner: formatAddress(record.owner),
    target: formatAddress(record.target),
    evm: record.evm,
    expiry: record.expiry,
    status: record.status,
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

/**
 * An open auction, plus `minimumBid` — the least a `B` must carry to stand
 * (§6 `A`): the starting price until a bid has met it, then the standing bid plus
 * `AUCTION_MIN_INCREMENT` of itself, floored. Served for the same reason
 * `/params` serves `minPrice`: a client cannot build a correct bid without
 * it, and the rule is `core.requiredBid`, never restated here.
 */
function serialiseAuction(auction: ApiAuction): Record<string, unknown> {
  return {
    name: auction.name,
    seller: formatAddress(auction.seller),
    startingPrice: auction.startingPrice.toString(),
    endHeight: auction.endHeight,
    bidder: auction.bidder === null ? null : formatAddress(auction.bidder),
    bid: auction.bid.toString(),
    bidRef: auction.bidRef === null ? null : { height: auction.bidRef.height, txIndex: auction.bidRef.txIndex },
    minimumBid: requiredBid(auction).toString(),
  }
}

export function createRoutes(queries: Queries): RouteHandler {
  /**
   * Effectively reserved: a `RESERVED_NAMES` member — on the published list,
   * or a 1–4 character name reserved by rule (§4.1, r18) — not released by a
   * fired `U`. Both routes are `core`'s since the launch freeze; this service
   * carries no list of its own, so it can no longer drift from the indexer's.
   */
  const reserved = (name: string, unreserved: boolean): boolean => isReservedName(name) && !unreserved

  /** `null` when the base cannot back proofs — no checkpoint, or a snapshot that does not reproduce the root. */
  const contextOf = (base: ProofBase | null): ProofContext | null =>
    base === null || base.records === null
      ? null
      : { records: base.records, nimiqHeight: base.checkpoint.height, rootHex: base.checkpoint.nameRoot }

  async function resolveRoute(name: string): Promise<ApiResponse> {
    // No reserved set on purpose: a reserved name awarded by a `U` (§6 `U`)
    // is registered and must resolve like any other. Since r18 short names
    // are reserved *by rule*, so the same neutrality needs one more step:
    // passing the candidate as `unreserved` makes reservation invisible to
    // the structural check, exactly as the omitted list always did.
    const dot = name.indexOf('.')
    const parsed = parseQuery(name, new Set([dot < 0 ? name : name.slice(dot + 1)]))
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
      evm: record.evm,
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

    // §4.1 order: structure first, reservation last — then state. Rule 6 is
    // deferred to the state-aware check below, which is what
    // `validateNameSyntax` is for: released-ness lives in state, and since r18
    // short names are reserved by rule, so a stateless check that applied rule
    // 6 would hold a released name forever.
    const structural = validateNameSyntax(name)
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
    // Structural check only: reserved names are legitimate subjects here —
    // short ones included, whose RESERVED comes by rule (§4.1, r18).
    const structural = validateNameSyntax(name)
    if (!structural.ok) {
      return respond(400, { error: 'INVALID_NAME', reason: structural.reason })
    }

    const { height, value } = await queries.detail(name)
    const isReserved = reserved(name, value.unreserved)
    const nothingKnown =
      value.record === null &&
      value.transfer === null &&
      value.offer === null &&
      value.auction === null &&
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
              },
        offer: value.offer === null ? null : serialiseOffer(value.offer),
        // r28 (§6 `A`): an open auction, never beside an offer. The close is
        // a height effect, so once `height` reaches `endHeight` the key is
        // null and the record's owner is whoever won.
        auction: value.auction === null ? null : serialiseAuction(value.auction),
        // `unreserve` was a third key here through r21. r22 made a `U` execute
        // in its landing block (§6 `U`), so nothing about one is ever pending;
        // the top-level `unreserved` flag above is the whole of what a caller
        // can learn about a `U` from this route. The key is **removed** rather
        // than pinned to null: a null would tell a client "no U is scheduled",
        // which under r22 is not a fact about this name but about every name.
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
        evm: record.evm,
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

  /**
   * The §8.2 log with its `data` field rendered as text — **a reading aid, not
   * the artifact.**
   *
   * §8.2 makes `data` lowercase hex so that a malformed but `NNS1`-prefixed
   * payload cannot forge a log line: nothing stops such a payload holding a
   * space or a newline, and written raw it would inject a whole line and
   * change the committed hash. That defence is right and the canonical bytes
   * keep it. What it costs is that every *legitimate* line is unreadable —
   * `4e4e5331446e696d69717c...` rather than `NNS1Dnimiq|delegated…` — and the
   * log is the artifact third parties are supposed to replay and audit.
   *
   * So this serves the same lines decoded, and `/log` keeps serving the bytes.
   * Two rules keep them from being confused, because hashing this by mistake
   * would produce a wrong answer confidently:
   *
   * - **JSON, not text.** It cannot be diffed against the canonical file or
   *   fed to keccak256 without noticing.
   * - **No `x-nns-log-hash` header**, and a `canonical` pointer in the body
   *   naming `/log` as the thing the checkpoint commits to.
   *
   * `data` is carried through unchanged beside the rendering, so a reader can
   * verify the decoding rather than trust it.
   */
  async function logDecodedRoute(format: string | null): Promise<ApiResponse> {
    if (format !== null && format !== 'json' && format !== 'text') {
      // Named rather than ignored: silently serving JSON to a caller who asked
      // for something else is how a typo becomes "the text view is broken".
      return respond(400, { error: 'UNKNOWN_FORMAT', accepted: ['json', 'text'] })
    }
    const { value } = await queries.logThroughCheckpoint()
    if (value === null) return respond(404, { error: 'NO_CHECKPOINT' })

    // One decode, both renderings — two loops is how the views drift.
    const entries = value.lines.map((line) => {
      const field = parseLogLine(line)
      const parsed = parse(field.data)
      return {
        blockHeight: field.blockHeight,
        txIndex: field.txIndex,
        txHash: field.txHash,
        sender: displayAddress(field.sender),
        recipient: displayAddress(field.recipient),
        value: field.value.toString(),
        verdict: field.verdict,
        data: field.data,
        message: renderPayload(field.data),
        type: parsed.ok ? parsed.message.type : null,
        parseFailure: parsed.ok ? null : parsed.reason,
      }
    })

    if (format === 'text') {
      return {
        status: 200,
        body: decodedTable(entries, value.checkpointHeight, value.logHash),
        contentType: 'text/plain; charset=utf-8',
      }
    }

    return respond(200, {
      canonical: {
        path: '/log',
        checkpointHeight: value.checkpointHeight,
        logHash: `0x${value.logHash}`,
        note: 'GET /log is the artifact the checkpoint commits to. This view is derived and is not hashed.',
      },
      entries,
      height: value.checkpointHeight,
    })
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

  /**
   * §10.7's referral facts for one name: the accepted registrations that
   * named it. No share is computed — the rate table is the treasury's
   * policy, published beside the docs, and a client applies it. Any §4.1
   * name is a valid question, registered or not: a name that has never
   * referred anyone has an empty list, which is an answer.
   */
  async function referralsRoute(name: string): Promise<ApiResponse> {
    const syntax = validateNameSyntax(name)
    if (!syntax.ok) return respond(400, { error: 'INVALID_NAME', reason: syntax.reason })
    const { height, value } = await queries.referrals(name)
    return respond(200, {
      name,
      count: value.length,
      registrations: value.map((item) => ({
        height: item.height,
        txIndex: item.txIndex,
        txHash: item.txHash,
        name: item.name,
        sender: formatAddress(item.sender),
        value: item.value.toString(10),
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
    for (const line of value.attestations) {
      if (line.verdict === 'OK') burned += line.value
    }
    // §10.2's whole identity in one response: `owed` is `BURN_SHARE` of the
    // accepted revenue, floored to whole luna — integer division is the only
    // rounding `bigint` has, and flooring under-states owed, which can only
    // ever under-burn. Serving `burned` without `owed` (as this route did
    // until 2026-08-17) made the section's "computable from the log" claim
    // true only of the half nobody needed to check.
    const owed = (value.revenue * CONSTANTS.BURN_SHARE_BP) / 10_000n
    return respond(200, {
      revenue: value.revenue.toString(),
      owed: owed.toString(),
      burned: burned.toString(),
      attestations: value.attestations.map((line) => ({
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

  function serialisePrices(prices: Prices): { feeBase: string; commissionBp: string } {
    return { feeBase: prices.feeBase.toString(), commissionBp: prices.commissionBp.toString() }
  }

  /**
   * One row per `FEE_MULTIPLIERS` band, priced by `core.feeFor` — the fee of
   * a name of the band's longest length, which is the fee of every length in
   * the band. The placeholder name is how the rule is asked without
   * restating it here.
   */
  function feeTable(prices: Prices): { upTo: number; times: string; yearly: string; lifetime: string }[] {
    return CONSTANTS.FEE_MULTIPLIERS.map((band) => {
      const sample = 'x'.repeat(band.upTo)
      return {
        upTo: band.upTo,
        times: band.times.toString(),
        yearly: feeFor(sample, prices).toString(),
        lifetime: feeFor(sample, prices, true).toString(),
      }
    })
  }

  async function offersRoute(): Promise<ApiResponse> {
    const { height, value } = await queries.offers()
    return respond(200, { offers: value.map(serialiseOffer), height })
  }

  async function auctionsRoute(): Promise<ApiResponse> {
    const { height, value } = await queries.auctions()
    return respond(200, { auctions: value.map(serialiseAuction), height })
  }

  async function paramsRoute(): Promise<ApiResponse> {
    const { height, value } = await queries.params()
    const prices: Prices = { feeBase: value.feeBase, commissionBp: value.commissionBp }
    return respond(200, {
      prices: serialisePrices(prices),
      // §3 MIN_PRICE is FEE_BASE *as in effect at this height* — core's rule,
      // applied to the active prices, never a constant (§6 `O`).
      minPrice: minPrice(prices).toString(),
      // §10.1's bands at the active prices, so no client multiplies: a name
      // of length ≤ `upTo` (and > the previous row's) costs `yearly` a term
      // or `lifetime` for LIFETIME_TERMS of them (§10.4). Seven rows, the
      // first two of which are reserved by rule — a released one is priced
      // by its band, so they are served, not skipped.
      fees: feeTable(prices),
      listingFee: CONSTANTS.LISTING_FEE.toString(),
      lastGovernanceHeight: value.lastGovernanceHeight,
      pendingGovernance:
        value.pending === null
          ? null
          : {
              prices: serialisePrices(value.pending),
              fees: feeTable(value.pending),
              effectiveHeight: value.pending.effectiveHeight,
            },
      // §8.4/§8.5 disclosure: which part of what this resolver serves it
      // derived from the chain itself. `verifiedFrom === LAUNCH_HEIGHT` with
      // `bootstrap: null` is the ordinary answer and the strong one.
      verification: value.verification,
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
      if (head === 'auctions' && segments.length === 1) return await auctionsRoute()
      if (head === 'params' && segments.length === 1) return await paramsRoute()
      if (head === 'checkpoints' && a !== undefined && segments.length === 2) {
        return a === 'latest' ? await checkpointRoute() : await checkpointAtRoute(a)
      }
      if (head === 'log' && segments.length === 1) return await logRoute()
      if (head === 'log' && a === 'decoded' && segments.length === 2) {
        return await logDecodedRoute(searchParams.get('format'))
      }
      if (head === 'settlements' && segments.length === 1) {
        return await settlementsRoute(searchParams.get('owed_to'))
      }
      if (head === 'burn' && segments.length === 1) return await burnRoute()
      if (head === 'referrals' && a !== undefined && segments.length === 2) return await referralsRoute(a)
      // Static, needs no snapshot, and deliberately answers before the
      // NOT_SYNCED gate every other route sits behind: the contract is true
      // whether or not the indexer has written state yet, and an integrator
      // reading it during a backfill should not be told the service is down.
      if (head === 'openapi.yaml' && segments.length === 1) {
        return {
          status: 200,
          body: openapiBytes(),
          contentType: 'application/yaml; charset=utf-8',
        }
      }
      // Name what exists. REST has no discovery mechanism of its own — no
      // introspection as in GraphQL, and OPTIONS reports methods rather than
      // paths — so the 404 is the only place a caller who guessed wrong is
      // already looking.
      return respond(404, { error: 'UNKNOWN_ROUTE', routes: ROUTES, spec: '/openapi.yaml' })
    } catch (error) {
      if (error instanceof NotSyncedError) {
        return respond(503, { error: 'NOT_SYNCED', detail: error.message })
      }
      throw error
    }
  }
}
