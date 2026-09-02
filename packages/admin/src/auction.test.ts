import { describe, expect, it } from 'vitest'
import { CodecError, CONSTANTS, encodeAuction, LUNA_PER_NIM } from '@nns/core'

import { describeAuctionPlan, parseAuctionArgs, planAuction, type AuctionPlan, type AuctionSources } from './auction.js'
import type { AuctionsSource, OpenAuction, OpenAuctions } from './auctions.js'
import { AdminRefusal, blockingChecks, broadcast, NOTICE_MARGIN, UsageError, type AdminRpc } from './cli.js'
import type { ActiveParams, ParamsSource } from './params.js'
import type { NameAvailability, ReservationSource } from './reservation.js'

const ADMIN = CONSTANTS.ADMIN_ADDRESS
const PROTOCOL = CONSTANTS.PROTOCOL_ADDRESS

const HEAD = 58_099_950
const HASH = 'c0ffee'.repeat(10) + 'c0ff'
/** Clears AUCTION_MIN_DURATION with the margin — the one end a plan accepts silently. */
const END = HEAD + CONSTANTS.AUCTION_MIN_DURATION + NOTICE_MARGIN
const MIN_PRICE = 400n * LUNA_PER_NIM

interface RecordedCall {
  readonly method: string
  readonly params: readonly unknown[]
}

/** 10 NIM — exactly ADMIN_MIN_BALANCE, so a healthy plan carries no warning. */
function fakeRpc(balance = 1_000_000): { rpc: AdminRpc; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const rpc: AdminRpc = {
    call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      calls.push({ method, params })
      switch (method) {
        case 'unlockAccount':
          return Promise.resolve(true as T)
        case 'getBlockNumber':
          return Promise.resolve(HEAD as T)
        case 'getAccountByAddress':
          return Promise.resolve({ balance } as T)
        case 'sendBasicTransactionWithData':
          return Promise.resolve(HASH as T)
        default:
          return Promise.reject(new Error(`unexpected RPC method ${method}`))
      }
    },
  }
  return { rpc, calls }
}

const AVAILABLE_URL = 'https://api.example/available/binance'
const PARAMS_URL = 'https://api.example/params'
const AUCTIONS_URL = 'https://api.example/auctions'

const ACTIVE: ActiveParams = Object.freeze({
  prices: { feeStandard: 2_000n * LUNA_PER_NIM, feeLong: MIN_PRICE, commissionBp: 250n },
  lastGovernanceHeight: null,
  pending: null,
  height: HEAD,
  url: PARAMS_URL,
})

const RESERVED: NameAvailability = Object.freeze({
  name: 'binance',
  available: false,
  reason: 'RESERVED',
  status: null,
  expiry: null,
  height: HEAD,
  url: AVAILABLE_URL,
})

/** What the API said about `nimiq` on 2026-08-21: released by a U, registered since. */
const TAKEN: Partial<NameAvailability> = { reason: 'TAKEN', status: 'REGISTERED', expiry: 59_765_881 }

const RUNNING: OpenAuction = Object.freeze({
  name: 'binance',
  seller: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
  reserve: MIN_PRICE,
  endHeight: HEAD + 90_000,
  bidder: null,
  bid: 0n,
})

interface Overrides {
  readonly params?: Partial<ActiveParams>
  readonly availability?: Partial<NameAvailability>
  readonly auctions?: readonly OpenAuction[]
  readonly auctionsHeight?: number
}

/** The three reads, each defaulting to the state in which an admin A lands. */
function fakeSources(overrides: Overrides = {}): AuctionSources & { fetched: string[] } {
  const fetched: string[] = []
  const params: ParamsSource = {
    fetchParams(): Promise<ActiveParams> {
      fetched.push('params')
      return Promise.resolve(Object.freeze({ ...ACTIVE, ...overrides.params }))
    },
  }
  const reservation: ReservationSource = {
    fetchAvailability(name: string): Promise<NameAvailability> {
      fetched.push('available')
      return Promise.resolve(Object.freeze({ ...RESERVED, name, ...overrides.availability }))
    },
  }
  const auctions: AuctionsSource = {
    fetchAuctions(): Promise<OpenAuctions> {
      fetched.push('auctions')
      return Promise.resolve(
        Object.freeze({ auctions: overrides.auctions ?? [], height: overrides.auctionsHeight ?? HEAD, url: AUCTIONS_URL }),
      )
    },
  }
  return { params, reservation, auctions, fetched }
}

const open = { name: 'binance', reserve: MIN_PRICE, endHeight: END }

async function plan(
  params: Partial<typeof open> = {},
  overrides: Overrides = {},
  balanceNim = 10,
): Promise<AuctionPlan> {
  const { rpc } = fakeRpc(balanceNim * 100_000)
  return planAuction(rpc, fakeSources(overrides), { ...open, ...params })
}

const messages = (built: AuctionPlan): string => built.checks.map((check) => check.message).join('\n')

describe('planAuction', () => {
  it('plans a clean admin auction from head, balance and the three reads, and sends nothing', async () => {
    const { rpc, calls } = fakeRpc()
    const sources = fakeSources()
    const built = await planAuction(rpc, sources, open)

    const expected = encodeAuction({ ...open, minPrice: MIN_PRICE })
    expect(built).toEqual({
      params: open,
      sender: ADMIN,
      recipient: PROTOCOL,
      data: expected.data,
      value: CONSTANTS.DUST_VALUE,
      head: HEAD,
      balance: 1_000_000n,
      active: ACTIVE,
      availability: RESERVED,
      open: { auctions: [], height: HEAD, url: AUCTIONS_URL },
      checks: [],
    })
    // Planning is read-only, and the floor is read before the builder runs.
    expect(calls.map((c) => c.method)).toEqual(['getBlockNumber', 'getAccountByAddress'])
    expect(sources.fetched).toEqual(['params', 'available', 'auctions'])
  })

  it('builds the §6 A payload: name, reserve in luna, end height', async () => {
    const built = await plan()
    expect(Buffer.from(built.data, 'hex').toString('ascii')).toBe(`NNS1Abinance|${MIN_PRICE}|${END}`)
  })

  it('refuses a reserve under MIN_PRICE as in effect — the codec’s own error, before any other read', async () => {
    const { rpc, calls } = fakeRpc()
    const sources = fakeSources()
    await expect(planAuction(rpc, sources, { ...open, reserve: MIN_PRICE - 1n })).rejects.toThrow(CodecError)
    expect(calls).toEqual([])
    expect(sources.fetched).toEqual(['params'])
  })

  it('takes the floor from /params, not from the launch constant', async () => {
    // A P halved the long band: a reserve that the launch FEE_LONG would
    // refuse is legal against the active one, and the plan says which it used.
    const halved = MIN_PRICE / 2n
    const built = await plan({ reserve: halved }, { params: { prices: { ...ACTIVE.prices, feeLong: halved } } })
    expect(built.checks).toEqual([])
    expect(describeAuctionPlan(built).join('\n')).toContain(`MIN_PRICE is ${halved} luna`)
  })

  it('rejects an invalid name offline, like every builder (§7.4)', async () => {
    const { rpc, calls } = fakeRpc()
    await expect(planAuction(rpc, fakeSources(), { ...open, name: 'ab-' })).rejects.toThrow(CodecError)
    expect(calls).toEqual([])
  })

  // ── Row 1: which auction this is ─────────────────────────────────────────

  it('refuses a name that was never reserved, without needing the chain state', async () => {
    const built = await plan({ name: 'tempolonglived' }, { availability: { available: true, reason: null } })
    const refusals = blockingChecks(built.checks)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.message).toContain('not a reserved name')
    expect(refusals[0]?.message).toContain('NAME_NOT_FOUND')
    expect(refusals[0]?.message).toContain('NOT_OWNER')
  })

  it('refuses a listed name a U already released and somebody registered — the nimiq case', async () => {
    const built = await plan({ name: 'nimiq' }, { availability: TAKEN })
    const refusals = blockingChecks(built.checks)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.message).toContain('no longer RESERVED')
    expect(refusals[0]?.message).toContain('REGISTERED to somebody')
  })

  it('refuses a listed name a U released that nobody registered — AVAILABLE, so NAME_NOT_FOUND', async () => {
    const built = await plan({}, { availability: { available: true, reason: null } })
    expect(blockingChecks(built.checks)).toHaveLength(1)
    expect(messages(built)).toContain('AVAILABLE')
    expect(messages(built)).toContain('NAME_NOT_FOUND')
  })

  it('plans an auction of a short name — reserved by rule, no list entry needed (r18)', async () => {
    const built = await plan({ name: 'ab' })
    expect(built.checks).toEqual([])
    expect(describeAuctionPlan(built).join('\n')).toContain('reserved by rule')
  })

  // ── Row 2: AUCTION_OPEN ──────────────────────────────────────────────────

  it('refuses a name already under auction — the row /available cannot see', async () => {
    const built = await plan({}, { auctions: [RUNNING] })
    const refusals = blockingChecks(built.checks)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.message).toContain('AUCTION_OPEN')
    expect(refusals[0]?.message).toContain(`ends at ${RUNNING.endHeight}`)
    expect(refusals[0]?.message).toContain('no bid yet')
    await expect(broadcast(fakeRpc().rpc, built)).rejects.toThrow(AdminRefusal)
  })

  it('quotes the standing bid when there is one', async () => {
    const bidder = 'NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK'
    const built = await plan({}, { auctions: [{ ...RUNNING, bidder, bid: 2n * MIN_PRICE }] })
    expect(messages(built)).toContain(`standing bid ${2n * MIN_PRICE} luna`)
    expect(messages(built)).toContain(bidder)
  })

  it('ignores auctions on other names', async () => {
    const built = await plan({}, { auctions: [{ ...RUNNING, name: 'nns' }] })
    expect(built.checks).toEqual([])
  })

  // ── The window (§6 A) — measured from the landing block, like P’s notice ─

  it('refuses a certain forfeit: an end under AUCTION_MIN_DURATION from head', async () => {
    const built = await plan({ endHeight: HEAD + CONSTANTS.AUCTION_MIN_DURATION - 1 })
    expect(blockingChecks(built.checks)).toHaveLength(1)
    expect(messages(built)).toContain('§6 A window')
    expect(messages(built)).toContain('INSUFFICIENT_NOTICE')
    expect(messages(built)).toContain('AUCTION_MIN_DURATION')
  })

  it('refuses the bare minimum too, and names the end that carries the margin', async () => {
    const built = await plan({ endHeight: HEAD + CONSTANTS.AUCTION_MIN_DURATION })
    expect(blockingChecks(built.checks)).toHaveLength(1)
    expect(messages(built)).toContain('measured from the block this lands in')
    expect(messages(built)).toContain(String(END))
  })

  it('accepts AUCTION_MIN_DURATION plus the margin', async () => {
    expect(await plan({ endHeight: END }).then((built) => built.checks)).toEqual([])
  })

  // ── §11.5 and staleness ──────────────────────────────────────────────────

  it('refuses an unfunded sender — the silent-drop route §11.5 exists for', async () => {
    const built = await plan({}, {}, 0)
    expect(blockingChecks(built.checks)).toHaveLength(1)
    expect(messages(built)).toContain('§11.5')
    await expect(broadcast(fakeRpc(0).rpc, built)).rejects.toThrow(AdminRefusal)
  })

  it('warns under ADMIN_MIN_BALANCE without blocking the send', async () => {
    const built = await plan({}, {}, 5)
    expect(built.checks.map((check) => check.severity)).toEqual(['warn'])
    await expect(broadcast(fakeRpc(500_000).rpc, built)).resolves.toMatchObject({ hash: HASH })
  })

  it('warns, without refusing, on each read that was taken far behind the head', async () => {
    const built = await plan(
      {},
      { availability: { height: HEAD - 2_000 }, auctionsHeight: HEAD - 2_000, params: { height: HEAD - 2_000 } },
    )
    expect(blockingChecks(built.checks)).toEqual([])
    expect(built.checks.map((check) => check.severity)).toEqual(['warn', 'warn', 'warn'])
    expect(messages(built)).toContain('a U accepted since')
    expect(messages(built)).toContain('an A accepted since')
    expect(messages(built)).toContain('a P activated since')
  })
})

describe('describeAuctionPlan', () => {
  it('decodes the payload it built rather than echoing the arguments back', async () => {
    const built = await plan()
    const lines = describeAuctionPlan(built).join('\n')
    expect(lines).toContain('A admin auction: binance')
    expect(lines).toContain(`decoded: name "binance", reserve ${MIN_PRICE} luna, end ${END}`)
  })

  it('prints the state it checked, the floor, the end in hours and the earliest usable end', async () => {
    const lines = describeAuctionPlan(await plan()).join('\n')
    expect(lines).toContain('state       RESERVED (on RESERVED_NAMES)')
    expect(lines).toContain(`read from ${AVAILABLE_URL} at height ${HEAD} (0 blocks behind head)`)
    expect(lines).toContain(`MIN_PRICE is ${MIN_PRICE} luna (400 NIM) at ${PARAMS_URL}`)
    expect(lines).toContain('~25.0 h from now')
    expect(lines).toContain(`earliest usable ${END}`)
    expect(lines).toContain('none for "binance"')
  })

  it('says who the seller is, what the close does, and that nothing cancels it', async () => {
    const lines = describeAuctionPlan(await plan()).join('\n')
    expect(lines).toContain('TREASURY_ADDRESS')
    expect(lines).toContain('SALE_PROCEEDS')
    expect(lines).toContain(`full TERM_LENGTH (${CONSTANTS.TERM_LENGTH})`)
    expect(lines).toContain('leaves the reserved set')
    expect(lines).toContain('IRREVERSIBLE: K cannot cancel an auction')
  })

  it('prints every check with its severity', async () => {
    const lines = describeAuctionPlan(await plan({}, { auctions: [RUNNING] }, 5)).join('\n')
    expect(lines).toContain('REFUSED: "binance" is already under auction')
    expect(lines).toContain('WARNING: §11.5')
    expect(lines).toContain('ONE OF THEM IS "binance"')
  })

  it('throws rather than print a plan whose payload is not an A', async () => {
    const built = await plan()
    expect(() => describeAuctionPlan({ ...built, data: encodeAuction({ ...open, minPrice: MIN_PRICE }).data.slice(0, 10) })).toThrow(
      /does not parse back as one/,
    )
  })
})

describe('broadcast', () => {
  it('unlocks by address, then sends the plan with dust and the plan head', async () => {
    const { rpc, calls } = fakeRpc()
    const built = await planAuction(rpc, fakeSources(), open)
    const sent = await broadcast(rpc, built)
    expect(sent).toEqual({ validityStartHeight: HEAD, hash: HASH })
    expect(calls.slice(2)).toEqual([
      { method: 'unlockAccount', params: [ADMIN, null, null] },
      { method: 'sendBasicTransactionWithData', params: [ADMIN, PROTOCOL, built.data, 1, 0, HEAD] },
    ])
  })
})

describe('parseAuctionArgs', () => {
  it('reads name, reserve in luna and end height; dry run unless --send', () => {
    expect(parseAuctionArgs(['binance', '40000000', '58200000'])).toEqual({
      params: { name: 'binance', reserve: 40_000_000n, endHeight: 58_200_000 },
      send: false,
    })
    expect(parseAuctionArgs(['binance', '40000000', '58200000', '--send']).send).toBe(true)
  })

  it('rejects a missing or extra argument, a non-integer amount, and any flag that is not --send', () => {
    expect(() => parseAuctionArgs(['binance', '40000000'])).toThrow(UsageError)
    expect(() => parseAuctionArgs(['binance', '40000000', '58200000', 'extra'])).toThrow(UsageError)
    expect(() => parseAuctionArgs(['binance', '400.5', '58200000'])).toThrow(/whole number of luna/)
    expect(() => parseAuctionArgs(['binance', '40000000', '+86400'])).toThrow(/end-height must be/)
    expect(() => parseAuctionArgs(['binance', '40000000', '58200000', '--dry'])).toThrow(/unknown flag/)
  })
})
