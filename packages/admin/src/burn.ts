/**
 * `f` — Burn attestation (§6 `F`): forward the treasury's `BURN_SHARE` to
 * `BURN_ADDRESS`, tagged so it enters the log and the §10.2 record.
 *
 * The most irreversible command in this CLI, on both axes at once: the
 * recipient is an address whose key is unknown and unobtainable (§10.2), and
 * the operand is not a name or a height but the **value field itself** — the
 * payload is a bare `NNS1F`, so there is nothing to decode a mistake out of
 * except the amount. The protections stack accordingly:
 *
 * 1. **The operator supplies the amount; the plan computes the ceiling.**
 *    `/burn` serves both halves of §10.2 — accepted revenue, owed
 *    (`BURN_SHARE` of it), burned so far — and a plan that would burn more
 *    than `owed − burned` is *refused*, not warned about. Unlike a large `P`,
 *    which is legal repricing someone might intend, an over-owed `F` has no
 *    legitimate routine use: burning exactly what is owed now and the
 *    remainder after more revenue accrues is never worse than over-burning,
 *    so the refusal costs nothing. This is also what catches the slipped
 *    decimal that still fits the balance.
 * 2. **A stale ceiling is a refusal too.** The `/burn` snapshot lags the
 *    chain, and the dangerous direction is a *recent `F` the snapshot has not
 *    counted*: `owed − burned` then proposes money already burned. So the
 *    plan sweeps `BURN_ADDRESS`'s recent transactions at the node and refuses
 *    outright when it finds an executed `F` above the snapshot height —
 *    rerun once the API has caught up. (An `F` still in the mempool is
 *    invisible to the sweep; the validity window bounds how long one can
 *    lurk, and confirm-by-effect below is why a crashed `--send` is noticed
 *    rather than repeated.)
 * 3. **§11.5 as a refusal, not a warning.** The sender is
 *    `TREASURY_ADDRESS` and the value is the whole burn, so balance < amount
 *    does not mean "top up soon" — it means this exact transaction is
 *    accepted by the RPC, returns a hash, and is never mined.
 * 4. **The remainder is checked against what the treasury still owes
 *    others.** Refund obligations are paid from the treasury (§6 `M`); a burn
 *    that leaves less than the outstanding refunds plus headroom warns.
 * 5. **Dry-run by default, decode-back-out, `--send`** — the house rules.
 *    What is printed is parsed from the built bytes, and the amount shown is
 *    the built transaction's value, not the argv echo.
 *
 * After `--send`, the command confirms **by effect**: it polls `/burn` until
 * the attestation appears under this transaction's hash, and otherwise exits
 * loudly unconfirmed — a returned hash is not confirmation (§5.3), and for a
 * burn "probably landed" is not a thing to print.
 */

import {
  BURN_ADDRESS,
  CONSTANTS,
  encodeBurn,
  formatAddress,
  parse,
  type Address,
} from '@nns/core'

import {
  AdminError,
  UsageError,
  formatLuna,
  hours,
  readBalance,
  type AdminCheck,
  type AdminRpc,
} from './cli.js'
import { apiBase, getJson, heightField, lunaField } from './api.js'

/** `NNS1F` in the lowercase hex the node returns as `recipientData`. */
const F_PREFIX = '4e4e533146'

/**
 * Headroom the treasury keeps beyond its outstanding refund obligations
 * before a burn stops warning. §10.6 asks that only an operational balance be
 * held here; 10 NIM of it is thousands of dust-and-fee sends.
 */
export const TREASURY_HEADROOM = 10n * 100_000n

/** How many recent `BURN_ADDRESS` transactions the freshness sweep reads. */
export const SWEEP_LIMIT = 100

export interface BurnParams {
  readonly amount: bigint
}

export interface BurnCommand {
  readonly params: BurnParams
  readonly send: boolean
}

/** `/burn`, as `f` needs it — both §10.2 halves plus the snapshot height. */
export interface BurnStatus {
  readonly revenue: bigint
  readonly owed: bigint
  readonly burned: bigint
  /** The API's "as of" stamp — what the ceiling was computed at. */
  readonly height: number
  /** The URL it came from, so the plan can name it. */
  readonly url: string
}

/** What the treasury still owes others, summed from `/settlements`. */
export interface TreasuryOwes {
  readonly total: bigint
  readonly legs: number
}

export interface BurnSource {
  fetchBurn(): Promise<BurnStatus>
  /** Outstanding obligations owed **by** the treasury (refunds, §6 `M`). */
  fetchTreasuryOwes(): Promise<TreasuryOwes>
  /**
   * The attestation hashes, for confirm-by-effect — and **failure-tolerant**:
   * a transient fetch error answers `[]` rather than throwing, because this
   * runs *after* the money has left and aborting the poll on a blip would
   * trade the honest UNCONFIRMED report for a stack trace.
   */
  fetchAttestations(): Promise<readonly { readonly txHash: string }[]>
}

/** An executed `F` the node has seen but the `/burn` snapshot has not. */
export interface UncountedBurn {
  readonly hash: string
  readonly blockNumber: number
  readonly value: bigint
}

export interface BurnPlan {
  readonly params: BurnParams
  /** `BURN_ADDRESS`, from the builder — never restated here. */
  readonly sender: Address
  readonly recipient: Address
  readonly data: string
  readonly value: bigint
  readonly head: number
  /** `TREASURY_ADDRESS`'s balance, in luna (§11.5). */
  readonly balance: bigint
  readonly status: BurnStatus
  readonly owes: TreasuryOwes
  readonly uncounted: readonly UncountedBurn[]
  /** `false` when the sweep window did not provably reach the snapshot. */
  readonly sweepConclusive: boolean
  readonly checks: readonly AdminCheck[]
}

/** `f <amount_luna> [--send]`. */
export function parseBurnArgs(argv: readonly string[]): BurnCommand {
  const flags = argv.filter((arg) => arg.startsWith('-'))
  for (const flag of flags) {
    if (flag !== '--send') throw new UsageError(`unknown flag ${JSON.stringify(flag)} — the only flag is --send`)
  }
  const [amount, ...rest] = argv.filter((arg) => !arg.startsWith('-'))
  if (amount === undefined || rest.length > 0) {
    throw new UsageError('f takes one amount, in luna')
  }
  if (!/^\d+$/.test(amount)) {
    throw new UsageError(`the amount is a whole number of luna, got ${JSON.stringify(amount)}`)
  }
  const value = BigInt(amount)
  if (value === 0n) throw new UsageError('a value of 0 is rejected by the network (§5.4) — nothing to burn')
  return { params: { amount: value }, send: flags.length > 0 }
}

/** What the freshness sweep concluded — or that it could not conclude. */
interface Sweep {
  readonly found: readonly UncountedBurn[]
  /**
   * `true` only when the window provably reaches back to the snapshot: the
   * node returned fewer entries than asked for (so we saw everything), or at
   * least one entry at or below `asOf`. `BURN_ADDRESS` is public — anyone's
   * dust lands there — so a full window that is *all* newer than the snapshot
   * proves nothing about what fell off its end.
   */
  readonly conclusive: boolean
}

/**
 * The freshness sweep (protection 2). `getTransactionsByAddress` answers
 * latest-first with `executionResult` on each entry; a failed transaction is
 * still in a block and must be discarded before any rule. Only `F`-tagged,
 * executed entries above the snapshot height count — everything at or below
 * it is already inside `burned`.
 */
async function sweepUncounted(rpc: AdminRpc, asOf: number): Promise<Sweep> {
  interface HistoryTx {
    readonly hash?: unknown
    readonly blockNumber?: unknown
    readonly recipientData?: unknown
    readonly executionResult?: unknown
    readonly value?: unknown
  }
  const entries =
    (await rpc.call<readonly HistoryTx[]>('getTransactionsByAddress', [
      // The parsed export, not CONSTANTS.BURN_ADDRESS: that one is the raw
      // spaced string, and this parameter should be the same canonical form
      // every other RPC call in this CLI passes.
      BURN_ADDRESS,
      SWEEP_LIMIT,
      null,
    ])) ?? []
  const found: UncountedBurn[] = []
  let sawSnapshotOrOlder = false
  for (const entry of entries) {
    if (typeof entry?.blockNumber === 'number' && entry.blockNumber <= asOf) sawSnapshotOrOlder = true
    if (typeof entry?.recipientData !== 'string') continue
    if (!entry.recipientData.toLowerCase().startsWith(F_PREFIX)) continue
    if (entry.executionResult !== true) continue
    const { hash, blockNumber, value } = entry
    if (typeof hash !== 'string' || typeof blockNumber !== 'number' || typeof value !== 'number') {
      throw new AdminError(
        `getTransactionsByAddress returned an F entry missing hash/blockNumber/value: ${JSON.stringify(entry)}`,
      )
    }
    if (blockNumber > asOf) found.push({ hash, blockNumber, value: BigInt(value) })
  }
  return { found, conclusive: entries.length < SWEEP_LIMIT || sawSnapshotOrOlder }
}

function check(
  params: BurnParams,
  status: BurnStatus,
  owes: TreasuryOwes,
  sweep: Sweep,
  balance: bigint,
): AdminCheck[] {
  const checks: AdminCheck[] = []
  const refuse = (message: string): number => checks.push({ severity: 'refuse', message })
  const warn = (message: string): number => checks.push({ severity: 'warn', message })

  // Protection 2 first: if the ceiling is provably stale, the ceiling check
  // below would be arithmetic over a wrong number, so this refusal explains
  // the situation rather than letting that one misreport it.
  for (const burn of sweep.found) {
    refuse(
      `stale ceiling: the node shows an executed F of ${formatLuna(burn.value)} at height ${burn.blockNumber} ` +
        `(tx ${burn.hash}), above the /burn snapshot at ${status.height} — the ceiling cannot have counted it. ` +
        'Wait for the API to catch up and rerun',
    )
  }
  if (!sweep.conclusive) {
    // BURN_ADDRESS takes anyone's dust, so enough newer traffic pushes an
    // uncounted F off the end of the window — absence of evidence, not
    // evidence of absence, and the ceiling cannot be trusted on it.
    refuse(
      `inconclusive sweep: the latest ${SWEEP_LIMIT} transactions to BURN_ADDRESS are all above the /burn ` +
        `snapshot at ${status.height}, so an uncounted F may have fallen off the window. Wait for the API to ` +
        'catch up and rerun',
    )
  }

  // Protection 1 — the §10.2 ceiling. Owed is floored at the API, so this
  // comparison can only ever be conservative.
  const outstanding = status.owed - status.burned
  if (outstanding <= 0n) {
    refuse(
      `nothing is owed: burned ${formatLuna(status.burned)} already covers owed ${formatLuna(status.owed)} ` +
        `(BURN_SHARE ${CONSTANTS.BURN_SHARE_BP / 100n}% of ${formatLuna(status.revenue)} accepted revenue, per ${status.url})`,
    )
  } else if (params.amount > outstanding) {
    refuse(
      `over-owed: ${formatLuna(params.amount)} exceeds the ${formatLuna(outstanding)} outstanding ` +
        `(owed ${formatLuna(status.owed)} − burned ${formatLuna(status.burned)}). BURN_ADDRESS has no key: an ` +
        'overpayment is unrecoverable, and burning the remainder later is never worse than over-burning now',
    )
  }

  // Protection 3 — §11.5 rule 1, as a refusal: the value is the whole burn.
  if (balance < params.amount) {
    refuse(
      `§11.5: TREASURY_ADDRESS balance is ${formatLuna(balance)}, below the ${formatLuna(params.amount)} this ` +
        'burns — the RPC would accept the transaction, return a hash, and it would never be mined',
    )
  } else {
    // Protection 4 — the treasury spends on refunds too (§6 `M`), and a burn
    // that strands them is legal but worth a hard look.
    const remainder = balance - params.amount
    const floor = owes.total + TREASURY_HEADROOM
    if (remainder < floor) {
      warn(
        `the remainder ${formatLuna(remainder)} is below outstanding treasury obligations ` +
          `${formatLuna(owes.total)} (${owes.legs} leg${owes.legs === 1 ? '' : 's'}) plus ` +
          `${formatLuna(TREASURY_HEADROOM)} headroom — refunds are paid from this address`,
      )
    }
  }

  // `sendBasicTransactionWithData` takes value as a JSON number. Any realistic
  // burn is far inside 2^53, but the narrowing is asserted, not assumed.
  if (!Number.isSafeInteger(Number(params.amount))) {
    refuse(`${params.amount} luna does not survive the RPC's number type — split the burn`)
  }

  return checks
}

/**
 * Build the transaction and gather everything the checks need. Read-only:
 * `getBlockNumber`, the balance, the sweep, and two API reads. The builder
 * runs first with `sender` supplied, so a malformed amount dies before the
 * node hears anything. The four independent reads run concurrently; only the
 * sweep waits, because it needs the snapshot height to sweep against.
 */
export async function planBurn(
  rpc: AdminRpc,
  source: BurnSource,
  params: BurnParams,
): Promise<BurnPlan> {
  const tx = encodeBurn({ amount: params.amount, sender: CONSTANTS.TREASURY_ADDRESS })
  const [head, status, owes, balance] = await Promise.all([
    rpc.call<number>('getBlockNumber'),
    source.fetchBurn(),
    source.fetchTreasuryOwes(),
    readBalance(rpc, CONSTANTS.TREASURY_ADDRESS),
  ])
  const sweep = await sweepUncounted(rpc, status.height)
  return {
    params,
    sender: CONSTANTS.TREASURY_ADDRESS,
    recipient: tx.recipient,
    data: tx.data,
    value: tx.value,
    head,
    balance,
    status,
    owes,
    uncounted: sweep.found,
    sweepConclusive: sweep.conclusive,
    checks: check(params, status, owes, sweep, balance),
  }
}

/**
 * The plan as lines for a human to read *before* deciding to `--send`.
 *
 * The amount is decoded from the built transaction — `parse` confirms the
 * payload is an `F`, and the value printed is the wire value — and the
 * ceiling line names what it was checked against **and how stale that was**:
 * the `/burn` height beside the current head, so an operator acting on old
 * data sees it here rather than discovering it afterwards.
 */
export function describeBurnPlan(plan: BurnPlan): string[] {
  const decoded = parse(plan.data)
  if (!decoded.ok || decoded.message.type !== 'F') {
    throw new Error(`built an F that does not parse back as one: ${plan.data}`)
  }
  const { status } = plan
  const outstanding = status.owed - status.burned
  const lag = plan.head - status.height
  // Two nodes: the API's indexer may be ahead of the node this CLI plans
  // against, and "-3 blocks behind" on the one line whose job is making
  // staleness legible would be worse than no line at all.
  const staleness =
    lag >= 0
      ? `${lag} block${lag === 1 ? '' : 's'} (${hours(lag)}) behind`
      : `${-lag} block${lag === -1 ? '' : 's'} AHEAD of this node's head — the API follows a different node`
  const within = outstanding >= plan.params.amount
  const lines = [
    `F burn: ${formatLuna(plan.value)}`,
    `  to            ${formatAddress(plan.recipient)} (BURN_ADDRESS — no key exists; §10.2)`,
    `  from          ${formatAddress(plan.sender)} (TREASURY_ADDRESS), balance ${formatLuna(plan.balance)}`,
    `  payload       ${plan.data} — decoded: F, no fields; the value above is the whole operand`,
    `  ceiling from  ${status.url} at height ${status.height} — head is ${plan.head}, so ${staleness}:`,
    `    revenue     ${formatLuna(status.revenue)} accepted (§10.2 base)`,
    `    owed        ${formatLuna(status.owed)} (BURN_SHARE ${CONSTANTS.BURN_SHARE_BP / 100n}%)`,
    `    burned      ${formatLuna(status.burned)}`,
    `    outstanding ${formatLuna(outstanding < 0n ? 0n : outstanding)}` +
      (within ? ` — this burn leaves ${formatLuna(outstanding - plan.params.amount)}` : ''),
    `  treasury owes ${formatLuna(plan.owes.total)} in ${plan.owes.legs} outstanding leg${plan.owes.legs === 1 ? '' : 's'} (refunds are paid from this address)`,
    !plan.sweepConclusive
      ? `  node sweep    inconclusive — the whole window is above height ${status.height}; see REFUSED below`
      : plan.uncounted.length === 0
        ? `  node sweep    no executed F above height ${status.height} — the ceiling counted every burn the node has`
        : `  node sweep    ${plan.uncounted.length} executed F above height ${status.height} — see REFUSED below`,
    `  IRREVERSIBLE: BURN_ADDRESS has no key. This is the last point it can be stopped.`,
  ]
  for (const { severity, message } of plan.checks) {
    lines.push(`  ${severity === 'refuse' ? 'REFUSED' : 'WARNING'}: ${message}`)
  }
  return lines
}


/**
 * Confirm by effect (§5.3): poll `/burn` until an attestation with this hash
 * appears, or give up after `attempts` and let the caller say *unconfirmed*
 * honestly. The hash comparison is case-insensitive because the node and the
 * log do not owe each other a case.
 */
export async function confirmBurn(
  fetchAttestations: () => Promise<readonly { readonly txHash: string }[]>,
  hash: string,
  options: { readonly attempts?: number; readonly delayMs?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 30
  const delayMs = options.delayMs ?? 6_000
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const wanted = hash.toLowerCase()
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(delayMs)
    const attestations = await fetchAttestations()
    if (attestations.some((line) => line.txHash.toLowerCase() === wanted)) return true
  }
  return false
}

// ── The API source ───────────────────────────────────────────────────────────

export function parseBurnStatus(body: unknown, url: string): BurnStatus {
  if (typeof body !== 'object' || body === null) {
    throw new AdminError(`${url} answered ${JSON.stringify(body)} — expected a /burn document`)
  }
  const raw = body as Record<string, unknown>
  // `revenue` and `owed` arrived on 2026-08-17; an API without them is one
  // whose ceiling this command cannot compute, and saying so beats a
  // TypeError three lines later.
  if (raw['owed'] === undefined) {
    throw new AdminError(
      `${url} serves no "owed" field — the API predates the 2026-08-17 /burn extension, and without the owed ` +
        'half of §10.2 there is no ceiling to check a burn against. Upgrade the API first',
    )
  }
  return Object.freeze({
    revenue: lunaField(raw['revenue'], 'revenue', url),
    owed: lunaField(raw['owed'], 'owed', url),
    burned: lunaField(raw['burned'], 'burned', url),
    height: heightField(raw['height'], 'height', url),
    url,
  })
}

/**
 * `GET {base}/burn` and `GET {base}/settlements`, over plain `fetch`. The
 * settlements read filters to legs owed **by** the treasury client-side — the
 * route's only filter is `owed_to`, and the outstanding set is small by
 * §10.2's own economics.
 */
export function createBurnSource(baseUrl: string): BurnSource {
  const base = apiBase(baseUrl)
  const treasury = formatAddress(CONSTANTS.TREASURY_ADDRESS)
  return {
    async fetchBurn(): Promise<BurnStatus> {
      const url = `${base}/burn`
      return parseBurnStatus(await getJson(url), url)
    },
    async fetchAttestations(): Promise<readonly { readonly txHash: string }[]> {
      // Failure-tolerant on purpose (see BurnSource): this runs after the
      // money has left, and a transient error must read as "not seen yet",
      // never abort the poll into a stack trace.
      try {
        const body = await getJson(`${base}/burn`)
        const attestations = (body as { attestations?: unknown })?.attestations
        if (!Array.isArray(attestations)) return []
        return attestations.filter(
          (entry): entry is { txHash: string } =>
            typeof entry === 'object' && entry !== null && typeof (entry as { txHash?: unknown }).txHash === 'string',
        )
      } catch {
        return []
      }
    },
    async fetchTreasuryOwes(): Promise<TreasuryOwes> {
      const url = `${base}/settlements`
      const body = await getJson(url)
      if (typeof body !== 'object' || body === null) {
        throw new AdminError(`${url} answered ${JSON.stringify(body)} — expected a /settlements document`)
      }
      const outstanding = (body as Record<string, unknown>)['outstanding']
      if (!Array.isArray(outstanding)) {
        throw new AdminError(`${url} answered outstanding = ${JSON.stringify(outstanding)} — expected an array`)
      }
      let total = 0n
      let legs = 0
      for (const [index, entry] of outstanding.entries()) {
        if (typeof entry !== 'object' || entry === null) {
          throw new AdminError(`${url} outstanding[${index}] is not an object`)
        }
        const leg = entry as Record<string, unknown>
        if (leg['owedBy'] !== treasury) continue
        total += lunaField(leg['amount'], `outstanding[${index}].amount`, url)
        legs += 1
      }
      return { total, legs }
    },
  }
}
