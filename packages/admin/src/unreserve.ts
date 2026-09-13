/**
 * `U` — Unreserve (§6): release a reserved name, or award any ownerless one.
 *
 * The contract is `encodeUnreserve`'s, not restated here: an omitted (or
 * null) recipient releases the name — the transaction goes to
 * `PROTOCOL_ADDRESS` — while an address awards it, `--lifetime` makes the
 * award a `LIFETIME_TERMS`-term one (`|L`, 2026-09-11) and is refused on a
 * release, and `BURN_ADDRESS` is refused because the reducer would forfeit
 * the message (`INVALID_RECIPIENT`, §7.4). This module only parses argv,
 * hands the operand to the builder, and broadcasts what it built. If a rule
 * seems to be missing here, it lives in `core` — do not add it here. A list
 * of awards is `batch.ts`, built on this file's plan.
 *
 * **No notice, and no notice checks, since r22.** A `U` takes effect in the
 * block it lands in; `GOVERNANCE_DELAY` is `P`'s alone. §6 `U` says why: an
 * award has no counterparty to warn, and a release announced a day ahead hands
 * a frontrunner a publicly timed starting gun. `noticeChecks` went with the
 * bound; the §11.5 precheck (2026-08-17) and the reservation refusal below
 * are what a plan can carry now.
 *
 * **Which makes the dry run the whole of the fat-finger protection.** It was
 * one of two before — a mistyped name or awardee could at least be seen
 * on-chain for a day, even though nothing could be done about it — and it is
 * the only one now. §6 `U` moves that protection here explicitly. So the plan
 * decodes the payload it actually built rather than echoing the arguments back,
 * and nothing is broadcast without `--send`.
 *
 * **Since 2026-09-11 an award reaches any name nobody owns** (§6 `U`):
 * reserved and unreleased as before, or plain AVAILABLE — a released name, an
 * expired one past its grace, one that never was reserved. Only a REGISTERED
 * name or one in GRACE forfeits, `NAME_NOT_AVAILABLE`. So the two operations
 * now have two different prechecks on the same `/available` read: a release
 * still needs RESERVED, an award needs *not TAKEN*. The fold exists for the
 * re-award after a repricing rebuild, which is a list — hence
 * `--batch`.
 *
 * **The reservation precheck landed on 2026-08-21, after a `U` forfeited.**
 * `u nimiq` printed a clean plan and the broadcast forfeited
 * `NAME_NOT_RESERVED` in block 59478946. The plan was built entirely from the
 * message — `encodeUnreserve` validates the name's shape, and nothing read
 * what the name currently *is*. The reducer's `U` case has two rows the
 * message cannot answer: `validateName` (§4.1) and `isReserved(state, name)`,
 * which is `isReservedName(name) && !state.unreserved.has(name)`. The first
 * half is a `core` constant and free; the second is chain state, and this
 * process holds none — so `u` now reads `GET /available/{name}` the way `p`
 * reads `/params`, and `NNS_API_URL` is required rather than optional. See
 * `reservation.ts`.
 *
 * **The §11.5 balance precheck landed with `f` (2026-08-17).** `ADMIN_ADDRESS`
 * has no income, and an unfunded send fails by *silence* — the RPC accepts the
 * transaction, returns a hash, and it is never mined. The plan reads the
 * balance, refuses when it cannot cover the dust this costs, and warns under
 * `ADMIN_MIN_BALANCE`, exactly as `p` does.
 */

import {
  addressEquals,
  CONSTANTS,
  encodeUnreserve,
  formatAddress,
  isReservedName,
  parse,
  parseAddress,
  termFor,
  type Address,
} from '@nns/core'

import {
  ADMIN_MIN_BALANCE,
  UsageError,
  formatLuna,
  readBalance,
  type AdminCheck,
  type AdminRpc,
} from './cli.js'
import {
  describeAvailability,
  isHeldNow,
  isReservedNow,
  RESERVATION_LAG_LIMIT,
  type NameAvailability,
  type ReservationSource,
} from './reservation.js'

export interface UnreserveParams {
  readonly name: string
  /** `null` releases the name; an address awards it (r17). */
  readonly recipient: Address | null
  /** An award for `LIFETIME_TERMS` terms (§10.4); the builder refuses it on a release. */
  readonly lifetime: boolean
}

export interface UnreserveCommand {
  readonly params: UnreserveParams
  /** Dry-run unless the caller passed `--send`. */
  readonly send: boolean
}

/** What one `U` would do, against the current head. */
export interface UnreservePlan {
  readonly params: UnreserveParams
  readonly kind: 'release' | 'award'
  /** Where the transaction goes: `PROTOCOL_ADDRESS` or the awardee. */
  readonly sender: Address
  readonly recipient: Address
  readonly data: string
  readonly value: bigint
  /** Chain head at planning time; doubles as the broadcast's `validityStartHeight`. */
  readonly head: number
  /** `ADMIN_ADDRESS`'s balance, in luna (§11.5). */
  readonly balance: bigint
  /** What the name currently is, and the height that was read at. */
  readonly availability: NameAvailability
  readonly checks: readonly AdminCheck[]
}

/** `u <name> [recipient] [--lifetime] [--send]` — omit the recipient to release. */
export function parseUnreserveArgs(argv: readonly string[]): UnreserveCommand {
  const flags = argv.filter((arg) => arg.startsWith('-'))
  for (const flag of flags) {
    if (flag !== '--send' && flag !== '--lifetime') {
      throw new UsageError(`unknown flag ${JSON.stringify(flag)} — the flags are --lifetime and --send (a list of awards is --batch <file>)`)
    }
  }
  const [name, recipient, ...rest] = argv.filter((arg) => !arg.startsWith('-'))
  if (name === undefined || rest.length > 0) {
    throw new UsageError('u takes a name and optionally an awardee address')
  }
  // An effective height was the second positional through r21. Catching it by
  // shape rather than letting it be read as an address turns a stale habit
  // into a usage error instead of a parse failure two lines later.
  if (recipient !== undefined && /^\d+$/.test(recipient)) {
    throw new UsageError(
      `u no longer takes an effective height — a U takes effect in the block it lands in (§6 U, r22). ` +
        `Got ${JSON.stringify(recipient)} where an awardee address was expected.`,
    )
  }
  return {
    params: {
      name,
      recipient: recipient === undefined ? null : parseAddress(recipient),
      lifetime: flags.includes('--lifetime'),
    },
    send: flags.includes('--send'),
  }
}

/**
 * Build the transaction, read the head and the balance, and ask the API what
 * the name currently is. Read-only: two RPC calls (`getBlockNumber`,
 * `getAccountByAddress`) and one `GET /available/{name}`. The builder runs
 * first, with `sender` supplied, so everything client-preventable — bad
 * name, `BURN_ADDRESS`, and an award to the admin address itself, which the
 * network would drop as a silent self-transaction — fails before the node
 * hears anything.
 */
export async function planUnreserve(
  rpc: AdminRpc,
  source: ReservationSource,
  params: UnreserveParams,
): Promise<UnreservePlan> {
  const tx = encodeUnreserve({ ...params, sender: CONSTANTS.ADMIN_ADDRESS })
  const head = await rpc.call<number>('getBlockNumber')
  const balance = await readBalance(rpc, CONSTANTS.ADMIN_ADDRESS)
  const availability = await source.fetchAvailability(params.name)

  const checks: AdminCheck[] = []
  // From the built recipient, not from argv: the reducer decides release
  // versus award by the recipient alone (§6 `U`), so an awardee spelled as
  // `PROTOCOL_ADDRESS` is a release on the wire and must be checked as one.
  const kind = addressEquals(tx.recipient, CONSTANTS.PROTOCOL_ADDRESS) ? 'release' : 'award'

  // The reducer's last row, which the message cannot answer about itself, and
  // which the recipient chose (§6 `U`, 2026-09-11). Every branch is a refusal
  // rather than a warning because none is a judgement call: the message is
  // mined and forfeited, and no state the chain could be in would make it
  // land.
  if (kind === 'release') {
    // `isReserved(state, name)`, in two halves.
    if (!isReservedName(params.name)) {
      // The state-independent half, and the one worth naming separately: no
      // chain state can rescue it, so this is not a "check again later".
      checks.push({
        severity: 'refuse',
        message:
          `${JSON.stringify(params.name)} is not a reserved name — it is neither on RESERVED_NAMES nor short-reserved ` +
          'by §4.1, so this U forfeits NAME_NOT_RESERVED whatever the chain state is (§6 U). Nothing to release.',
      })
    } else if (!isReservedNow(availability)) {
      checks.push({
        severity: 'refuse',
        message:
          `${JSON.stringify(params.name)} is on the reserved list but is no longer RESERVED: ` +
          `${availability.url} reads it as ${describeAvailability(availability)} at height ${availability.height}. ` +
          'A U already fired for it, so this one forfeits NAME_NOT_RESERVED (§6 U, r22).',
      })
    }
  } else if (isHeldNow(availability)) {
    // An award needs only that nobody owns the name: `state.names.has(name)`
    // is the whole row, and `/available`'s TAKEN is its spelling — REGISTERED
    // or in GRACE. Reserved-and-unreleased and plain AVAILABLE both land.
    checks.push({
      severity: 'refuse',
      message:
        `${JSON.stringify(params.name)} is held: ${availability.url} reads it as ${describeAvailability(availability)} ` +
        `at height ${availability.height}. An award reaches any name nobody owns, and this one has an owner, so this U ` +
        'forfeits NAME_NOT_AVAILABLE (§6 U, 2026-09-11).',
    })
  } else if (!availability.available && !isReservedNow(availability)) {
    // Neither available nor reserved nor taken: a §4.1 reason the builder did
    // not catch. Nothing awards a name that cannot be registered.
    checks.push({
      severity: 'refuse',
      message:
        `${JSON.stringify(params.name)} is ${describeAvailability(availability)} per ${availability.url} at height ` +
        `${availability.height} — this U forfeits INVALID_NAME (§6 U).`,
    })
  }

  const lag = head - availability.height
  if (lag > RESERVATION_LAG_LIMIT) {
    checks.push({
      severity: 'warn',
      message:
        `the reservation was read from ${availability.url} at height ${availability.height}, ${lag} blocks behind ` +
        'the node — a U accepted since is not reflected in it',
    })
  }

  // §11.5 — an unfunded sender fails by silence, not by error: the RPC
  // accepts the transaction, returns a hash, and it is never mined. The same
  // pair of checks `p` runs, at the same severities.
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

  return {
    params,
    // The plan is the fat-finger protection, and it has to describe the bytes
    // it built — so the kind is the built recipient's, decided above.
    kind,
    sender: CONSTANTS.ADMIN_ADDRESS,
    recipient: tx.recipient,
    data: tx.data,
    value: tx.value,
    head,
    balance,
    availability,
    checks,
  }
}

/**
 * The plan as lines for a human to read *before* deciding to `--send`.
 *
 * The name is read back out of the built payload rather than out of `params`,
 * so what is printed is what will be on the wire. With no notice window left,
 * this readback is the only thing between a typo and a permanently released
 * name.
 */
export function describePlan(plan: UnreservePlan): string[] {
  const decoded = parse(plan.data)
  if (!decoded.ok || decoded.message.type !== 'U') {
    throw new Error(`built a U that does not parse back as one: ${plan.data}`)
  }
  const { kind, recipient, head, availability } = plan
  const { name, lifetime } = decoded.message
  const term = termFor(lifetime)
  return [
    `U ${kind}: ${name}${kind === 'award' && lifetime ? ' (lifetime)' : ''}`,
    // First line after the verb, because it is the row that decides whether
    // this message lands at all — and the one a plan built from the message
    // alone could not show (2026-08-21).
    `  state     ${describeAvailability(availability)} — read from ${availability.url} at height ` +
      `${availability.height} (${head - availability.height} blocks behind head)`,
    kind === 'release'
      ? `  to        ${formatAddress(recipient)} (PROTOCOL_ADDRESS — the name becomes AVAILABLE)`
      : `  to        ${formatAddress(recipient)} (awarded the name, ${lifetime ? `a lifetime — ${CONSTANTS.LIFETIME_TERMS} terms` : 'one full term'}, no fee)`,
    `  payload   ${plan.data} — decoded: name ${JSON.stringify(name)}, ${lifetime ? 'lifetime flag L' : 'no other field'}`,
    `  effective on landing: head is ${head}, so this binds in the next block that carries it — ` +
      'there is no notice window and nothing to cancel (§6 U, r22)',
    ...(kind === 'award'
      ? [
          `  award term ends <landing height> + ${term}${lifetime ? ` (${CONSTANTS.LIFETIME_TERMS} × TERM_LENGTH ${CONSTANTS.TERM_LENGTH})` : ''}, ` +
            `so at head that is ${head + term} — the term is half-open, and GRACE begins at the end height (§7.3)`,
        ]
      : []),
    `  from      ${formatAddress(plan.sender)} (ADMIN_ADDRESS), balance ${formatLuna(plan.balance)}`,
    `  IRREVERSIBLE: a U cannot be recalled, and this is the last point it can be stopped.`,
    ...plan.checks.map(({ severity, message }) => `  ${severity === 'refuse' ? 'REFUSED' : 'WARNING'}: ${message}`),
  ]
}
