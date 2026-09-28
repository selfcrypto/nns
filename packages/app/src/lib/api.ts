/**
 * Raw NNS API reads, for non-address data only: `/name`, `/address/{addr}/names`,
 * `/offers`, `/auctions`, `/params`, `/burn`. Anything an address or an availability verdict
 * comes out of goes through `@nimiqnames/resolver` (`src/lib/nns.ts`) — never through here.
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
  /** The one governed price (§10.1): the yearly fee of a 12+ name, and MIN_PRICE. */
  readonly feeBase: bigint
  readonly commissionBp: bigint
}

/**
 * One §10.1 band as `/params.fees` serves it: a name of length at most
 * `upTo` (and above the previous row's) costs `yearly` for a term, or
 * `lifetime` for `LIFETIME_TERMS` of them (§10.4). The api prices the rows
 * through core; the app reads them and never multiplies.
 */
export interface FeeRow {
  readonly upTo: number
  readonly times: bigint
  readonly yearly: bigint
  readonly lifetime: bigint
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
  /** Seven rows in ascending length; the first two are reserved by rule. */
  readonly fees: readonly FeeRow[]
  readonly minPrice: bigint
  readonly listingFee: bigint
  readonly pendingGovernance: {
    readonly prices: FeePrices
    readonly fees: readonly FeeRow[]
    readonly effectiveHeight: number
  } | null
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
    feeBase: luna(body['feeBase'], `${path}.feeBase`),
    commissionBp: luna(body['commissionBp'], `${path}.commissionBp`),
  }
}

const readFees = (value: unknown, path: string): readonly FeeRow[] => {
  if (!Array.isArray(value) || value.length === 0) throw new ApiError('MALFORMED', `${path} is not a non-empty list`, 200)
  return value.map((item, index) => {
    const body = record(item, `${path}[${index}]`)
    return {
      upTo: num(body['upTo'], `${path}[${index}].upTo`),
      times: luna(body['times'], `${path}[${index}].times`),
      yearly: luna(body['yearly'], `${path}[${index}].yearly`),
      lifetime: luna(body['lifetime'], `${path}[${index}].lifetime`),
    }
  })
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
  /** The `G` carried `L`: the fee owed, and the share's base, was the lifetime fee. */
  readonly lifetime: boolean
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
        lifetime: bool(item['lifetime'], 'lifetime'),
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
    fees: readFees(body['fees'], 'fees'),
    minPrice: luna(body['minPrice'], 'minPrice'),
    listingFee: luna(body['listingFee'], 'listingFee'),
    pendingGovernance:
      body['pendingGovernance'] === null
        ? null
        : (() => {
            const pending = record(body['pendingGovernance'], 'pendingGovernance')
            return {
              prices: readPrices(pending['prices'], 'pendingGovernance.prices'),
              fees: readFees(pending['fees'], 'pendingGovernance.fees'),
              effectiveHeight: num(pending['effectiveHeight'], 'pendingGovernance.effectiveHeight'),
            }
          })(),
    height: num(body['height'], 'height'),
  }
}

// ── /stats ───────────────────────────────────────────────────────────────────

/** A count and the luna it carried. */
export interface Tally {
  readonly count: number
  readonly amount: bigint
}

/** One bucket of `/stats`' daily or hourly series; `bucket` counts from `LAUNCH_HEIGHT`. */
export interface StatsBucket {
  readonly bucket: number
  readonly lines: number
  readonly registrations: number
}

/**
 * `/stats`: the registry counted, for the Stats screen. Display material like
 * `/offers`, never a source of an address or a verdict.
 */
export interface Stats {
  readonly chain: { readonly launchHeight: number; readonly scannedThrough: number | null; readonly checkpointInterval: number }
  readonly checkpoints: {
    readonly retained: number
    readonly latest: { readonly height: number; readonly commitment: string; readonly createdAt: string } | null
  }
  readonly names: {
    readonly total: number
    readonly registered: number
    readonly grace: number
    readonly owners: number
    readonly withEvm: number
    readonly delegated: number
    readonly pointedElsewhere: number
    readonly renewSoon: number
    readonly released: number
    readonly lifetimeTerms: number
    readonly renewals: number
    readonly byLength: readonly { readonly length: number; readonly names: number }[]
    readonly topHolders: readonly { readonly owner: string; readonly names: number }[]
    readonly recent: readonly { readonly name: string; readonly height: number; readonly lifetime: boolean }[]
  }
  readonly market: {
    readonly openOffers: number
    readonly openAuctions: number
    readonly pendingTransfers: number
    readonly listings: number
    readonly sales: number
    readonly saleVolume: bigint
    readonly topSale: { readonly name: string; readonly price: bigint } | null
    readonly auctions: number
    readonly bids: number
    readonly topBid: { readonly name: string; readonly bid: bigint } | null
  }
  readonly log: {
    readonly lines: number
    readonly senders: number
    readonly byType: readonly { readonly type: string; readonly lines: number; readonly ok: number }[]
    readonly byVerdict: readonly { readonly verdict: string; readonly lines: number }[]
    readonly daily: readonly StatsBucket[]
    readonly hourly: readonly StatsBucket[]
    readonly dayBlocks: number
    readonly hourBlocks: number
  }
  readonly money: {
    readonly revenue: bigint
    readonly owed: bigint
    readonly burned: bigint
    readonly payouts: Tally
    readonly refunded: Tally
    readonly forfeited: Tally
    readonly outstanding: Tally
  }
  readonly referrals: {
    readonly registrations: number
    readonly referrers: number
    readonly top: readonly { readonly name: string; readonly registrations: number; readonly volume: bigint }[]
  }
  readonly height: number
}

const list = <T>(value: unknown, path: string, read: (item: unknown, path: string) => T): readonly T[] => {
  if (!Array.isArray(value)) throw shape(path)
  return value.map((item, index) => read(item, `${path}[${index}]`))
}

const nullableNum = (value: unknown, path: string): number | null => (value === null ? null : num(value, path))

const readTally = (value: unknown, path: string): Tally => {
  const body = record(value, path)
  return { count: num(body['count'], `${path}.count`), amount: luna(body['amount'], `${path}.amount`) }
}

const readBucket = (value: unknown, path: string): StatsBucket => {
  const body = record(value, path)
  return {
    bucket: num(body['bucket'], `${path}.bucket`),
    lines: num(body['lines'], `${path}.lines`),
    registrations: num(body['registrations'], `${path}.registrations`),
  }
}

export async function getStats(base: string, fetchJson: JsonFetch = jsonFetch): Promise<Stats> {
  const body = record(await request(fetchJson, base, '/stats'), 'response')
  const chain = record(body['chain'], 'chain')
  const checkpoints = record(body['checkpoints'], 'checkpoints')
  const names = record(body['names'], 'names')
  const market = record(body['market'], 'market')
  const log = record(body['log'], 'log')
  const money = record(body['money'], 'money')
  const referrals = record(body['referrals'], 'referrals')
  const latest = checkpoints['latest'] === null ? null : record(checkpoints['latest'], 'checkpoints.latest')
  const topSale = market['topSale'] === null ? null : record(market['topSale'], 'market.topSale')
  const topBid = market['topBid'] === null ? null : record(market['topBid'], 'market.topBid')
  return {
    chain: {
      launchHeight: num(chain['launchHeight'], 'chain.launchHeight'),
      scannedThrough: nullableNum(chain['scannedThrough'], 'chain.scannedThrough'),
      checkpointInterval: num(chain['checkpointInterval'], 'chain.checkpointInterval'),
    },
    checkpoints: {
      retained: num(checkpoints['retained'], 'checkpoints.retained'),
      latest:
        latest === null
          ? null
          : {
              height: num(latest['height'], 'checkpoints.latest.height'),
              commitment: str(latest['commitment'], 'checkpoints.latest.commitment'),
              createdAt: str(latest['createdAt'], 'checkpoints.latest.createdAt'),
            },
    },
    names: {
      total: num(names['total'], 'names.total'),
      registered: num(names['registered'], 'names.registered'),
      grace: num(names['grace'], 'names.grace'),
      owners: num(names['owners'], 'names.owners'),
      withEvm: num(names['withEvm'], 'names.withEvm'),
      delegated: num(names['delegated'], 'names.delegated'),
      pointedElsewhere: num(names['pointedElsewhere'], 'names.pointedElsewhere'),
      renewSoon: num(names['renewSoon'], 'names.renewSoon'),
      released: num(names['released'], 'names.released'),
      lifetimeTerms: num(names['lifetimeTerms'], 'names.lifetimeTerms'),
      renewals: num(names['renewals'], 'names.renewals'),
      byLength: list(names['byLength'], 'names.byLength', (item, path) => {
        const row = record(item, path)
        return { length: num(row['length'], `${path}.length`), names: num(row['names'], `${path}.names`) }
      }),
      topHolders: list(names['topHolders'], 'names.topHolders', (item, path) => {
        const row = record(item, path)
        return { owner: str(row['owner'], `${path}.owner`), names: num(row['names'], `${path}.names`) }
      }),
      recent: list(names['recent'], 'names.recent', (item, path) => {
        const row = record(item, path)
        return { name: str(row['name'], `${path}.name`), height: num(row['height'], `${path}.height`), lifetime: bool(row['lifetime'], `${path}.lifetime`) }
      }),
    },
    market: {
      openOffers: num(market['openOffers'], 'market.openOffers'),
      openAuctions: num(market['openAuctions'], 'market.openAuctions'),
      pendingTransfers: num(market['pendingTransfers'], 'market.pendingTransfers'),
      listings: num(market['listings'], 'market.listings'),
      sales: num(market['sales'], 'market.sales'),
      saleVolume: luna(market['saleVolume'], 'market.saleVolume'),
      topSale: topSale === null ? null : { name: str(topSale['name'], 'market.topSale.name'), price: luna(topSale['price'], 'market.topSale.price') },
      auctions: num(market['auctions'], 'market.auctions'),
      bids: num(market['bids'], 'market.bids'),
      topBid: topBid === null ? null : { name: str(topBid['name'], 'market.topBid.name'), bid: luna(topBid['bid'], 'market.topBid.bid') },
    },
    log: {
      lines: num(log['lines'], 'log.lines'),
      senders: num(log['senders'], 'log.senders'),
      byType: list(log['byType'], 'log.byType', (item, path) => {
        const row = record(item, path)
        return { type: str(row['type'], `${path}.type`), lines: num(row['lines'], `${path}.lines`), ok: num(row['ok'], `${path}.ok`) }
      }),
      byVerdict: list(log['byVerdict'], 'log.byVerdict', (item, path) => {
        const row = record(item, path)
        return { verdict: str(row['verdict'], `${path}.verdict`), lines: num(row['lines'], `${path}.lines`) }
      }),
      daily: list(log['daily'], 'log.daily', readBucket),
      hourly: list(log['hourly'], 'log.hourly', readBucket),
      dayBlocks: num(log['dayBlocks'], 'log.dayBlocks'),
      hourBlocks: num(log['hourBlocks'], 'log.hourBlocks'),
    },
    money: {
      revenue: luna(money['revenue'], 'money.revenue'),
      owed: luna(money['owed'], 'money.owed'),
      burned: luna(money['burned'], 'money.burned'),
      payouts: readTally(money['payouts'], 'money.payouts'),
      refunded: readTally(money['refunded'], 'money.refunded'),
      forfeited: readTally(money['forfeited'], 'money.forfeited'),
      outstanding: readTally(money['outstanding'], 'money.outstanding'),
    },
    referrals: {
      registrations: num(referrals['registrations'], 'referrals.registrations'),
      referrers: num(referrals['referrers'], 'referrals.referrers'),
      top: list(referrals['top'], 'referrals.top', (item, path) => {
        const row = record(item, path)
        return { name: str(row['name'], `${path}.name`), registrations: num(row['registrations'], `${path}.registrations`), volume: luna(row['volume'], `${path}.volume`) }
      }),
    },
    height: num(body['height'], 'height'),
  }
}
