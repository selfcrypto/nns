/**
 * Raw NNS API reads, for non-address data only: `/name`, `/address/{addr}/names`,
 * `/offers`, `/auctions`, `/params`, `/burn`. Anything an address or an availability verdict
 * comes out of goes through `@nns/resolver` (`src/lib/nns.ts`) — never through here.
 *
 * Luna amounts arrive as decimal strings (the API's rule: `bigint` does not
 * survive JSON) and are parsed to `bigint` here, never to `number`.
 */

export class ApiError extends Error {
  override readonly name = 'ApiError'
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

export type JsonFetch = (url: string) => Promise<{ status: number; body: unknown }>

export const jsonFetch: JsonFetch = async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // A non-JSON body on an error status is still an answer; the status carries it.
  }
  return { status: response.status, body }
}

export type NameStatus = 'REGISTERED' | 'GRACE'

export interface ApiNameRecord {
  readonly name: string
  readonly owner: string
  readonly target: string
  /** §6 `E` record — lowercase `0x`-hex, `''` when unset. */
  readonly evm: string
  readonly expiry: number
  readonly status: NameStatus
  readonly host: string
}

export interface ApiPendingTransfer {
  readonly newOwner: string
  readonly effectiveHeight: number
}

export interface ApiOffer {
  readonly name: string
  readonly seller: string
  readonly price: bigint
  readonly openedHeight: number
  readonly expiryHeight: number
}

/**
 * An open auction (§6 `A`, r28). `bidder` is null with `bid` 0 until the
 * first bid stands. `minimumBid` is the API's `core.requiredBid` — the least
 * a `B` must carry to stand — and is what the Bid sheet builds against; the
 * app never restates the increment rule. The bid's ref is served too but not
 * read here: nothing on screen keys on it.
 */
export interface ApiAuction {
  readonly name: string
  readonly seller: string
  readonly startingPrice: bigint
  readonly endHeight: number
  readonly bidder: string | null
  readonly bid: bigint
  readonly minimumBid: bigint
}

/** `/name/{name}` — the pending object is `{transfer, offer, auction}` since r28. */
export interface NameInfo {
  readonly name: string
  readonly reserved: boolean
  readonly unreserved: boolean
  readonly record: ApiNameRecord | null
  readonly pending: {
    readonly transfer: ApiPendingTransfer | null
    readonly offer: ApiOffer | null
    /** Never set beside `offer`: an auction is exclusive while open. */
    readonly auction: ApiAuction | null
  }
  readonly height: number
}

export interface OwnedName {
  readonly name: string
  readonly target: string
  readonly expiry: number
  readonly status: NameStatus
  readonly host: string
}

export interface OwnedNames {
  readonly address: string
  readonly names: readonly OwnedName[]
  readonly height: number
}

export interface OpenOffers {
  readonly offers: readonly ApiOffer[]
  readonly height: number
}

export interface OpenAuctions {
  readonly auctions: readonly ApiAuction[]
  readonly height: number
}

export interface FeePrices {
  readonly feeStandard: bigint
  readonly feeLong: bigint
  readonly commissionBp: bigint
}

/** `/burn` — §10.2's two halves; the attestation list is served but not needed here. */
export interface BurnRecord {
  readonly revenue: bigint
  readonly owed: bigint
  readonly burned: bigint
  readonly height: number
}

export interface ApiParams {
  readonly prices: FeePrices
  readonly minPrice: bigint
  readonly listingFee: bigint
  readonly pendingGovernance: { readonly prices: FeePrices; readonly effectiveHeight: number } | null
  readonly height: number
}

// ── Shape readers ────────────────────────────────────────────────────────────

const shape = (path: string): ApiError =>
  new ApiError('MALFORMED_RESPONSE', `unexpected API response shape at ${path}`, 0)

const record = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw shape(path)
  return value as Record<string, unknown>
}

const str = (value: unknown, path: string): string => {
  if (typeof value !== 'string') throw shape(path)
  return value
}

const num = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw shape(path)
  return value
}

const bool = (value: unknown, path: string): boolean => {
  if (typeof value !== 'boolean') throw shape(path)
  return value
}

const luna = (value: unknown, path: string): bigint => {
  const text = str(value, path)
  if (!/^[0-9]+$/.test(text)) throw shape(path)
  return BigInt(text)
}

const status = (value: unknown, path: string): NameStatus => {
  const text = str(value, path)
  if (text !== 'REGISTERED' && text !== 'GRACE') throw shape(path)
  return text
}

const readNameRecord = (value: unknown, path: string): ApiNameRecord => {
  const body = record(value, path)
  return {
    name: str(body['name'], `${path}.name`),
    owner: str(body['owner'], `${path}.owner`),
    target: str(body['target'], `${path}.target`),
    evm: str(body['evm'], `${path}.evm`),
    expiry: num(body['expiry'], `${path}.expiry`),
    status: status(body['status'], `${path}.status`),
    host: str(body['host'], `${path}.host`),
  }
}

const readOffer = (value: unknown, path: string): ApiOffer => {
  const body = record(value, path)
  return {
    name: str(body['name'], `${path}.name`),
    seller: str(body['seller'], `${path}.seller`),
    price: luna(body['price'], `${path}.price`),
    openedHeight: num(body['openedHeight'], `${path}.openedHeight`),
    expiryHeight: num(body['expiryHeight'], `${path}.expiryHeight`),
  }
}

const readAuction = (value: unknown, path: string): ApiAuction => {
  const body = record(value, path)
  return {
    name: str(body['name'], `${path}.name`),
    seller: str(body['seller'], `${path}.seller`),
    startingPrice: luna(body['startingPrice'], `${path}.startingPrice`),
    endHeight: num(body['endHeight'], `${path}.endHeight`),
    bidder: body['bidder'] === null ? null : str(body['bidder'], `${path}.bidder`),
    bid: luna(body['bid'], `${path}.bid`),
    minimumBid: luna(body['minimumBid'], `${path}.minimumBid`),
  }
}

const readPrices = (value: unknown, path: string): FeePrices => {
  const body = record(value, path)
  return {
    feeStandard: luna(body['feeStandard'], `${path}.feeStandard`),
    feeLong: luna(body['feeLong'], `${path}.feeLong`),
    commissionBp: luna(body['commissionBp'], `${path}.commissionBp`),
  }
}

const errorCode = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null) return null
  const code = (body as Record<string, unknown>)['error']
  return typeof code === 'string' ? code : null
}

const request = async (fetchJson: JsonFetch, base: string, path: string): Promise<unknown> => {
  const { status: httpStatus, body } = await fetchJson(`${base.replace(/\/+$/, '')}${path}`)
  if (httpStatus === 200) return body
  const code = errorCode(body) ?? `HTTP_${httpStatus}`
  throw new ApiError(code, `NNS API answered ${httpStatus} (${code}) for ${path}`, httpStatus)
}

// ── Endpoints ────────────────────────────────────────────────────────────────

/** `null` when the API knows nothing about a valid name (404 NOT_FOUND). */
export async function getNameInfo(base: string, name: string, fetchJson: JsonFetch = jsonFetch): Promise<NameInfo | null> {
  let body: unknown
  try {
    body = await request(fetchJson, base, `/name/${encodeURIComponent(name)}`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
  const top = record(body, 'response')
  const pending = record(top['pending'], 'pending')
  return {
    name: str(top['name'], 'name'),
    reserved: bool(top['reserved'], 'reserved'),
    unreserved: bool(top['unreserved'], 'unreserved'),
    record: top['record'] === null ? null : readNameRecord(top['record'], 'record'),
    pending: {
      transfer:
        pending['transfer'] === null
          ? null
          : (() => {
              const transfer = record(pending['transfer'], 'pending.transfer')
              return {
                newOwner: str(transfer['newOwner'], 'pending.transfer.newOwner'),
                effectiveHeight: num(transfer['effectiveHeight'], 'pending.transfer.effectiveHeight'),
              }
            })(),
      offer: pending['offer'] === null ? null : readOffer(pending['offer'], 'pending.offer'),
      auction: pending['auction'] === null ? null : readAuction(pending['auction'], 'pending.auction'),
    },
    height: num(top['height'], 'height'),
  }
}

export async function getOwnedNames(base: string, address: string, fetchJson: JsonFetch = jsonFetch): Promise<OwnedNames> {
  const body = record(await request(fetchJson, base, `/address/${encodeURIComponent(address)}/names`), 'response')
  const names = body['names']
  if (!Array.isArray(names)) throw shape('names')
  return {
    address: str(body['address'], 'address'),
    names: names.map((entry, index) => {
      const owned = record(entry, `names[${index}]`)
      return {
        name: str(owned['name'], `names[${index}].name`),
        target: str(owned['target'], `names[${index}].target`),
        expiry: num(owned['expiry'], `names[${index}].expiry`),
        status: status(owned['status'], `names[${index}].status`),
        host: str(owned['host'], `names[${index}].host`),
      }
    }),
    height: num(body['height'], 'height'),
  }
}

export async function getOffers(base: string, fetchJson: JsonFetch = jsonFetch): Promise<OpenOffers> {
  const body = record(await request(fetchJson, base, '/offers'), 'response')
  const offers = body['offers']
  if (!Array.isArray(offers)) throw shape('offers')
  return {
    offers: offers.map((entry, index) => readOffer(entry, `offers[${index}]`)),
    height: num(body['height'], 'height'),
  }
}

export async function getAuctions(base: string, fetchJson: JsonFetch = jsonFetch): Promise<OpenAuctions> {
  const body = record(await request(fetchJson, base, '/auctions'), 'response')
  const auctions = body['auctions']
  if (!Array.isArray(auctions)) throw shape('auctions')
  return {
    auctions: auctions.map((entry, index) => readAuction(entry, `auctions[${index}]`)),
    height: num(body['height'], 'height'),
  }
}

export interface ApiReferral {
  readonly height: number
  readonly txIndex: number
  readonly txHash: string
  /** The name registered. */
  readonly name: string
  readonly sender: string
  readonly value: bigint
}

export interface Referrals {
  readonly name: string
  readonly count: number
  readonly registrations: readonly ApiReferral[]
  readonly height: number
}

/** `/referrals/{name}` (§10.7): the accepted registrations that named this name. Facts only; the share is applied client-side from the published table. */
export async function getReferrals(base: string, name: string, fetchJson: JsonFetch = jsonFetch): Promise<Referrals> {
  const body = await request(fetchJson, base, `/referrals/${encodeURIComponent(name)}`)
  const top = record(body, 'response')
  const rows = top['registrations']
  if (!Array.isArray(rows)) throw new ApiError('MALFORMED', 'registrations is not a list', 200)
  return {
    name: str(top['name'], 'name'),
    count: num(top['count'], 'count'),
    registrations: rows.map((row, index) => {
      const item = record(row, `registrations[${index}]`)
      return {
        height: num(item['height'], 'height'),
        txIndex: num(item['txIndex'], 'txIndex'),
        txHash: str(item['txHash'], 'txHash'),
        name: str(item['name'], 'name'),
        sender: str(item['sender'], 'sender'),
        value: luna(item['value'], 'value'),
      }
    }),
    height: num(top['height'], 'height'),
  }
}

export async function getBurn(base: string, fetchJson: JsonFetch = jsonFetch): Promise<BurnRecord> {
  const body = record(await request(fetchJson, base, '/burn'), 'response')
  return {
    revenue: luna(body['revenue'], 'revenue'),
    owed: luna(body['owed'], 'owed'),
    burned: luna(body['burned'], 'burned'),
    height: num(body['height'], 'height'),
  }
}

export async function getParams(base: string, fetchJson: JsonFetch = jsonFetch): Promise<ApiParams> {
  const body = record(await request(fetchJson, base, '/params'), 'response')
  return {
    prices: readPrices(body['prices'], 'prices'),
    minPrice: luna(body['minPrice'], 'minPrice'),
    listingFee: luna(body['listingFee'], 'listingFee'),
    pendingGovernance:
      body['pendingGovernance'] === null
        ? null
        : (() => {
            const pending = record(body['pendingGovernance'], 'pendingGovernance')
            return {
              prices: readPrices(pending['prices'], 'pendingGovernance.prices'),
              effectiveHeight: num(pending['effectiveHeight'], 'pendingGovernance.effectiveHeight'),
            }
          })(),
    height: num(body['height'], 'height'),
  }
}
