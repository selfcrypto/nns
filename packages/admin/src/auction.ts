/**
 * `A` — Auction (§6, r28): the admin's auction of a still-reserved name.
 *
 * §6 `A` names two openers — the owner of a `REGISTERED` name, or
 * `ADMIN_ADDRESS` for a name still held in `RESERVED_NAMES` — and this command
 * is the second one only: the cold key opens a window on a withheld name, the
 * close registers it to the winner on `U`'s award terms (a full `TERM_LENGTH`
 * from the close, nothing set), the name enters the unreserved set, and both
 * legs of the sale land on `TREASURY_ADDRESS`. An owner auctions through the
 * app. The contract is `encodeAuction`'s and the reducer's, not restated here;
 * if a rule seems to be missing, it lives in `core`.
 *
 * **The reducer's `A` case has three rows the message cannot answer about
 * itself**, and each is a forfeit — mined, logged, unretractable:
 *
 * 1. *Which auction this is, and whether the admin may open it.* A name with
 *    a record is the owner's to auction (`NOT_OWNER` for anyone else, the
 *    admin included); a name with none must be `isReserved(state, name)` —
 *    on the list or short by rule, and not released by a fired `U` — or the
 *    `A` forfeits `NAME_NOT_FOUND`. The list half is a `core` constant; the
 *    state half is `GET /available/{name}`, the read `u` already makes for the
 *    same rule (`reservation.ts`).
 * 2. *`AUCTION_OPEN`.* A reserved name has no record, so `/available` answers
 *    `RESERVED` whether or not an auction is already running on it. `GET
 *    /auctions` is the one read that answers `state.auctions.has(name)`
 *    (`auctions.ts`).
 * 3. *The floor.* The starting price MUST be ≥ `MIN_PRICE`, which is `FEE_LONG` **as
 *    in effect** — `/params`'s `minPrice`, not the launch constant. The
 *    builder takes that floor as an argument and refuses below it, so the
 *    `/params` read comes first and a low starting price fails as the codec's own
 *    error, the way `BURN_ADDRESS` does for `u`.
 *
 * **The window is measured from the landing block** (§6 `A`: "measured from
 * inclusion like `P`'s notice, and forfeiting `INSUFFICIENT_NOTICE` on the
 * same terms"), so `end_height` gets the margin `p` gives an effective height
 * — `noticeChecks` with the `AUCTION_WINDOW` bound, a refusal, and the plan
 * prints the earliest end it will accept.
 *
 * **Dry-run by default, and the plan reads the name back out of the bytes.**
 * An `A` cannot be recalled: `K` does not cancel an auction (§6 `A`), so the
 * only exits are a close — with a bid, a sale — or an empty window. The
 * decoded payload is the fat-finger protection, as it is for `u`.
 */

import {
  CONSTANTS,
  encodeAuction,
  formatAddress,
  isReservedName,
  parse,
  type Address,
} from '@nns/core'

import {
  ADMIN_MIN_BALANCE,
  AUCTION_WINDOW,
  NOTICE_MARGIN,
  UsageError,
  formatLuna,
  hours,
  noticeChecks,
  noticeInWords,
  readBalance,
  type AdminCheck,
  type AdminRpc,
} from './cli.js'
import { auctionFor, type AuctionsSource, type OpenAuctions } from './auctions.js'
import { PARAMS_LAG_LIMIT } from './governance.js'
import type { ActiveParams, ParamsSource } from './params.js'
import {
  describeAvailability,
  isReservedNow,
  RESERVATION_LAG_LIMIT,
  type NameAvailability,
  type ReservationSource,
} from './reservation.js'

export interface AuctionParams {
  readonly name: string
  /** Luna. */
  readonly startingPrice: bigint
  readonly endHeight: number
}

export interface AuctionCommand {
  readonly params: AuctionParams
  /** Dry-run unless the caller passed `--send`. */
  readonly send: boolean
}

/** The three reads a plan is checked against, each stamped with its height. */
export interface AuctionSources {
  readonly params: ParamsSource
  readonly reservation: ReservationSource
  readonly auctions: AuctionsSource
}

/** What one admin `A` would do, against the current head. */
export interface AuctionPlan {
  readonly params: AuctionParams
  readonly sender: Address
  /** `PROTOCOL_ADDRESS` — where an `A` goes (§6 `A`). */
  readonly recipient: Address
  readonly data: string
  readonly value: bigint
  /** Chain head at planning time; doubles as the broadcast's `validityStartHeight`. */
  readonly head: number
  /** `ADMIN_ADDRESS`'s balance, in luna (§11.5). */
  readonly balance: bigint
  /** The prices in effect — `minPrice` is the starting price's floor. */
  readonly active: ActiveParams
  /** What the name currently is, and the height that was read at. */
  readonly availability: NameAvailability
  /** Every open auction, and the height that was read at. */
  readonly open: OpenAuctions
  readonly checks: readonly AdminCheck[]
}

/** `a <name> <starting_price_luna> <end-height> [--send]`. */
export function parseAuctionArgs(argv: readonly string[]): AuctionCommand {
  const flags = argv.filter((arg) => arg.startsWith('-'))
  for (const flag of flags) {
    if (flag !== '--send') throw new UsageError(`unknown flag ${JSON.stringify(flag)} — the only flag is --send`)
  }
  const [name, startingPrice, endHeight, ...rest] = argv.filter((arg) => !arg.startsWith('-'))
  if (name === undefined || startingPrice === undefined || endHeight === undefined || rest.length > 0) {
    throw new UsageError('a takes a name, a starting price in luna and an end height')
  }
  if (!/^\d+$/.test(startingPrice)) {
    throw new UsageError(`starting price must be a whole number of luna (1 NIM = 100,000 luna), got ${JSON.stringify(startingPrice)}`)
  }
  if (!/^\d+$/.test(endHeight) || !Number.isSafeInteger(Number(endHeight))) {
    throw new UsageError(`end-height must be a non-negative integer, got ${JSON.stringify(endHeight)}`)
  }
  return {
    params: { name, startingPrice: BigInt(startingPrice), endHeight: Number(endHeight) },
    send: flags.length > 0,
  }
}

/**
 * Read the floor, build the transaction, then read the head, the balance,
 * the name's state and the open auctions. Read-only: two RPC calls
 * (`getBlockNumber`, `getAccountByAddress`) and three `GET`s. Unlike `u` and
 * `p` the builder does not run first: it needs `MIN_PRICE` as in effect,
 * which is `/params`'s to answer, so that read precedes it and a starting price
 * under the floor throws as the codec's own error before anything else is
 * fetched. A bad name throws there too.
 */
export async function planAuction(rpc: AdminRpc, sources: AuctionSources, params: AuctionParams): Promise<AuctionPlan> {
  const active = await sources.params.fetchParams()
  const tx = encodeAuction({
    ...params,
    minPrice: active.prices.feeLong,
    sender: CONSTANTS.ADMIN_ADDRESS,
  })
  const head = await rpc.call<number>('getBlockNumber')
  const balance = await readBalance(rpc, CONSTANTS.ADMIN_ADDRESS)
  const availability = await sources.reservation.fetchAvailability(params.name)
  const open = await sources.auctions.fetchAuctions()

  const checks: AdminCheck[] = []

  // Row 1 — which auction this is. The admin's is the reserved-name one, and
  // the reducer decides it by the name's state before it looks at the sender.
  // Both halves are refusals rather than warnings because neither is a
  // judgement call: with a record the admin is `NOT_OWNER`, without one and
  // unreserved the name is `NAME_NOT_FOUND`, and no chain state makes either
  // land.
  if (!isReservedName(params.name)) {
    checks.push({
      severity: 'refuse',
      message:
        `${JSON.stringify(params.name)} is not a reserved name — it is neither on RESERVED_NAMES nor short-reserved ` +
        'by §4.1, so an A from ADMIN_ADDRESS forfeits whatever the chain state is (NAME_NOT_FOUND if nobody holds ' +
        "it, NOT_OWNER if somebody does; §6 A). The admin auctions withheld names only — an owner's auction is the app's",
    })
  } else if (!isReservedNow(availability)) {
    checks.push({
      severity: 'refuse',
      message:
        `${JSON.stringify(params.name)} is on the reserved list but is no longer RESERVED: ` +
        `${availability.url} reads it as ${describeAvailability(availability)} at height ${availability.height}. ` +
        'A U already fired for it, so the admin cannot auction it — an A forfeits NAME_NOT_FOUND on a released ' +
        'name and NOT_OWNER on a registered one (§6 A)',
    })
  }

  // Row 2 — AUCTION_OPEN, from the one read that can see it.
  const running = auctionFor(open, params.name)
  if (running !== null) {
    const standing =
      running.bidder === null
        ? 'no bid yet'
        : `standing bid ${formatLuna(running.bid)} from ${running.bidder}`
    checks.push({
      severity: 'refuse',
      message:
        `${JSON.stringify(params.name)} is already under auction: ${open.url} lists it at height ${open.height} — ` +
        `starting price ${formatLuna(running.startingPrice)}, ends at ${running.endHeight}, ${standing}. A second A forfeits ` +
        'AUCTION_OPEN (§6 A), and K cannot cancel the running one',
    })
  }

  // The window — §6 A measures it from the landing block, like P's notice,
  // and forfeits the same token. Same check, same margin, same refusal.
  checks.push(...noticeChecks(params.endHeight, head, AUCTION_WINDOW))

  // §11.5 — an unfunded sender fails by silence, not by error. The same pair
  // of checks `p` and `u` run, at the same severities.
  if (balance < tx.value) {
    checks.push({
      severity: 'refuse',
      message:
        `§11.5: sender balance is ${formatLuna(balance)}, below the ${formatLuna(tx.value)} this costs — the RPC ` +
        'would accept the transaction, return a hash, and it would never be mined',
    })
  } else if (balance < ADMIN_MIN_BALANCE) {
    checks.push({
      severity: 'warn',
      message: `§11.5: sender balance is ${formatLuna(balance)}, below the ${formatLuna(ADMIN_MIN_BALANCE)} floor — top it up`,
    })
  }

  // Staleness is a warning on every read, never a refusal: the indexer
  // trails the chain by finality (§7.2 step 3), and the stale reading that
  // matters — a U, an A or a P accepted since — costs a forfeited message and
  // its dust, not a wrong registry.
  const lag = (label: string, url: string, height: number, limit: number, consequence: string): void => {
    const behind = head - height
    if (behind > limit) {
      checks.push({
        severity: 'warn',
        message: `${label} was read from ${url} at height ${height}, ${behind} blocks behind the node — ${consequence}`,
      })
    }
  }
  lag('the reservation', availability.url, availability.height, RESERVATION_LAG_LIMIT, 'a U accepted since is not reflected in it')
  lag('the open-auction list', open.url, open.height, RESERVATION_LAG_LIMIT, 'an A accepted since is not reflected in it')
  lag('MIN_PRICE', active.url, active.height, PARAMS_LAG_LIMIT, 'a P activated since is not the floor this starting price was checked against')

  return {
    params,
    sender: CONSTANTS.ADMIN_ADDRESS,
    recipient: tx.recipient,
    data: tx.data,
    value: tx.value,
    head,
    balance,
    active,
    availability,
    open,
    checks,
  }
}

/**
 * The plan as lines for a human to read *before* deciding to `--send`.
 *
 * Name, starting price and end are read back out of the built payload rather than
 * out of `params`, so what is printed is what will be on the wire — the only
 * thing between a typo and a window nobody can close early.
 */
export function describeAuctionPlan(plan: AuctionPlan): string[] {
  const decoded = parse(plan.data)
  if (!decoded.ok || decoded.message.type !== 'A') {
    throw new Error(`built an A that does not parse back as one: ${plan.data}`)
  }
  const { head, active, availability } = plan
  const { name, startingPrice, endHeight } = decoded.message
  const byRule = name.length < CONSTANTS.MIN_NAME_LEN
  return [
    `A admin auction: ${name}`,
    // First after the verb, because it is the row that decides whether this
    // message lands at all, and the one a plan built from the message alone
    // could not show.
    `  state       ${describeAvailability(availability)}${isReservedNow(availability) ? (byRule ? ' (short, reserved by rule — §4.1)' : ' (on RESERVED_NAMES)') : ''} — ` +
      `read from ${availability.url} at height ${availability.height} (${head - availability.height} blocks behind head)`,
    `  auctions    ${plan.open.auctions.length} open at ${plan.open.url}, height ${plan.open.height} — ` +
      (auctionFor(plan.open, name) === null ? `none for ${JSON.stringify(name)}` : `ONE OF THEM IS ${JSON.stringify(name)}`),
    `  starting price  ${formatLuna(startingPrice)} — MIN_PRICE is ${formatLuna(active.prices.feeLong)} at ${active.url}, height ${active.height}; ` +
      'the first bid must reach the starting price, each later one the standing bid plus ' +
      `${CONSTANTS.AUCTION_MIN_INCREMENT_BP} bp of itself`,
    `  ends at     height ${endHeight} — head is ${head}, so ${noticeInWords(endHeight, head)}; a bid inside the last ` +
      `${CONSTANTS.AUCTION_EXTENSION} blocks (${hours(CONSTANTS.AUCTION_EXTENSION)}) moves the end to that bid + ${CONSTANTS.AUCTION_EXTENSION}`,
    `  earliest usable ${head + CONSTANTS.AUCTION_MIN_DURATION + NOTICE_MARGIN} — AUCTION_MIN_DURATION (${CONSTANTS.AUCTION_MIN_DURATION}) ` +
      `plus ${NOTICE_MARGIN} blocks (${hours(NOTICE_MARGIN)}) of landing margin, since the window runs from the block this lands in`,
    `  payload     ${plan.data} — decoded: name ${JSON.stringify(name)}, starting price ${startingPrice} luna, end ${endHeight}`,
    `  to          ${formatAddress(plan.recipient)} (PROTOCOL_ADDRESS), value ${formatLuna(plan.value)}, fee 0`,
    `  from        ${formatAddress(plan.sender)} (ADMIN_ADDRESS), balance ${formatLuna(plan.balance)}`,
    `  seller      ${formatAddress(CONSTANTS.TREASURY_ADDRESS)} (TREASURY_ADDRESS) — at the close both legs land there: ` +
      'SALE_PROCEEDS less commission at the rate then in effect, and COMMISSION, told apart by amount (§6 A, §6 M)',
    `  at the close  with a standing bid the name is REGISTERED to the winner for a full TERM_LENGTH (${CONSTANTS.TERM_LENGTH}) ` +
      'from the close height, nothing set, and leaves the reserved set; with none the auction ends and the name stays reserved',
    '  IRREVERSIBLE: K cannot cancel an auction and no message closes one early — the window runs to its end.',
    ...plan.checks.map(({ severity, message }) => `  ${severity === 'refuse' ? 'REFUSED' : 'WARNING'}: ${message}`),
  ]
}
