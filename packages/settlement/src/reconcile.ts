/**
 * Settled versus owed, from a replayed log.
 *
 * The report is a value, not a print statement: {@link reconcile} returns it
 * and {@link describeReport} turns it into lines. That split is what lets the
 * balance identity below be a test rather than a claim.
 *
 * ## The identity
 *
 * Every leg the log ever created is either discharged by an `M` or still
 * outstanding — there is no third place for it to go, and no operation that
 * reduces a leg partially (§6 `M`: one `M` per settled transaction, matched on
 * the exact amount). So:
 *
 *     created = settled + outstanding
 *
 * per address, per kind, and in total. It holds by construction if the replay
 * is right and fails loudly if it is not, which is the only self-check this
 * tool can perform without a second source of truth.
 *
 * ## What is an error, and what is merely news
 *
 * The exit code answers **"is this log what it claims to be"**, not "is the
 * operator behind on payments". A standing obligation is the normal state of a
 * live marketplace — money in flight between a `B` and its `M` — and deciding
 * when it has been standing too long needs a policy about how fast an operator
 * ought to pay. This package does not get to invent that any more than it gets
 * to invent a finality rule; it prints the age and lets a human hold the
 * threshold. An unmatched `M` is different in kind — money left the operator's
 * address and discharged nothing — so it is reported prominently and counted,
 * but it still does not make the log untrue.
 *
 * Untrue is: the bytes do not hash to their hash, the checkpoint does not
 * commit them, a verdict disagrees with the replay, or the identity above
 * fails. Those are the failures.
 */

import { formatAddress, refKey, type Address, type ObligationKind, type TxRef } from '@nns/core'

import type { CreatedLeg, ReplayResult, SettledLeg, UnmatchedSettlement, VerdictMismatch } from './replay.js'

/** Totals for one `(owedBy, kind)` pair. */
export interface LedgerLine {
  readonly owedBy: Address
  readonly kind: ObligationKind
  readonly created: bigint
  readonly settled: bigint
  readonly outstanding: bigint
  readonly createdCount: number
  readonly settledCount: number
  readonly outstandingCount: number
}

/** An outstanding leg with how long it has been standing, in blocks. */
export interface StandingLeg {
  readonly ref: TxRef
  readonly kind: ObligationKind
  readonly owedBy: Address
  readonly owedTo: Address
  readonly amount: bigint
  /** Blocks between the debt's own height and the end of the log. */
  readonly ageBlocks: number
}

export interface Report {
  readonly checkpointHeight: number
  readonly boundToCheckpoint: boolean
  readonly logHash: string
  readonly lineCount: number
  readonly lastLineHeight: number | null
  readonly lines: readonly LedgerLine[]
  readonly totalCreated: bigint
  readonly totalSettled: bigint
  readonly totalOutstanding: bigint
  readonly standing: readonly StandingLeg[]
  readonly unmatched: readonly UnmatchedSettlement[]
  readonly mismatches: readonly VerdictMismatch[]
  /** False when `created ≠ settled + outstanding` anywhere — a replay bug. */
  readonly balanced: boolean
}

export interface ReconcileInput {
  readonly replay: ReplayResult
  readonly checkpointHeight: number
  readonly boundToCheckpoint: boolean
  readonly logHash: string
}

const lineKey = (owedBy: Address, kind: ObligationKind): string => `${owedBy}:${kind}`

interface Tally {
  created: bigint
  settled: bigint
  outstanding: bigint
  createdCount: number
  settledCount: number
  outstandingCount: number
}

const emptyTally = (): Tally => ({
  created: 0n,
  settled: 0n,
  outstanding: 0n,
  createdCount: 0,
  settledCount: 0,
  outstandingCount: 0,
})

export function reconcile(input: ReconcileInput): Report {
  const { replay } = input
  const tallies = new Map<string, { owedBy: Address; kind: ObligationKind; tally: Tally }>()

  const bucket = (owedBy: Address, kind: ObligationKind): Tally => {
    const key = lineKey(owedBy, kind)
    let entry = tallies.get(key)
    if (entry === undefined) {
      entry = { owedBy, kind, tally: emptyTally() }
      tallies.set(key, entry)
    }
    return entry.tally
  }

  for (const leg of replay.created) {
    const tally = bucket(leg.obligation.owedBy, leg.obligation.kind)
    tally.created += leg.obligation.amount
    tally.createdCount += 1
  }
  for (const leg of replay.settled) {
    const tally = bucket(leg.obligation.owedBy, leg.obligation.kind)
    tally.settled += leg.obligation.amount
    tally.settledCount += 1
  }
  for (const leg of replay.outstanding) {
    const tally = bucket(leg.obligation.owedBy, leg.obligation.kind)
    tally.outstanding += leg.obligation.amount
    tally.outstandingCount += 1
  }

  const lines: LedgerLine[] = [...tallies.values()]
    .map(({ owedBy, kind, tally }) => ({
      owedBy,
      kind,
      created: tally.created,
      settled: tally.settled,
      outstanding: tally.outstanding,
      createdCount: tally.createdCount,
      settledCount: tally.settledCount,
      outstandingCount: tally.outstandingCount,
    }))
    .sort((a, b) => a.owedBy.localeCompare(b.owedBy) || a.kind.localeCompare(b.kind))

  const balanced = lines.every((line) => line.created === line.settled + line.outstanding)

  const head = replay.lastLineHeight ?? 0
  const standing: StandingLeg[] = replay.outstanding.map((leg) => ({
    ref: leg.obligation.ref,
    kind: leg.obligation.kind,
    owedBy: leg.obligation.owedBy,
    owedTo: leg.obligation.owedTo,
    amount: leg.obligation.amount,
    ageBlocks: Math.max(0, head - leg.obligation.ref.height),
  }))

  const sum = (pick: (line: LedgerLine) => bigint): bigint => lines.reduce((total, line) => total + pick(line), 0n)

  return Object.freeze({
    checkpointHeight: input.checkpointHeight,
    boundToCheckpoint: input.boundToCheckpoint,
    logHash: input.logHash,
    lineCount: replay.lineCount,
    lastLineHeight: replay.lastLineHeight,
    lines,
    totalCreated: sum((line) => line.created),
    totalSettled: sum((line) => line.settled),
    totalOutstanding: sum((line) => line.outstanding),
    standing,
    unmatched: replay.unmatched,
    mismatches: replay.mismatches,
    balanced,
  })
}

/**
 * True when the log is what it claims to be and the replay agrees with it.
 *
 * Standing obligations and unmatched `M`s do not enter this — see the module
 * docblock for why.
 */
export const isSound = (report: Report): boolean => report.balanced && report.mismatches.length === 0

/** 1 NIM = 100,000 luna, and luna is `bigint`. Rendered, never computed on. */
function nim(luna: bigint): string {
  const negative = luna < 0n
  const magnitude = negative ? -luna : luna
  const whole = magnitude / 100_000n
  const fraction = (magnitude % 100_000n).toString().padStart(5, '0')
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`
}

const ref = (value: TxRef): string => refKey(value)

/** Width of `formatAddress` output: 36 characters in nine groups, eight spaces. */
const ADDRESS_COLUMN = 44

export function describeReport(report: Report): readonly string[] {
  const out: string[] = []
  out.push(`log through checkpoint ${report.checkpointHeight}, ${report.lineCount} lines, hash ${report.logHash}`)
  out.push(
    report.boundToCheckpoint
      ? `bound: the checkpoint at ${report.checkpointHeight} commits this exact log`
      : `NOT BOUND to a checkpoint — these bytes are on the serving party's word alone`,
  )
  out.push('')

  if (report.lines.length === 0) {
    out.push('no obligations have ever been created by this log.')
  } else {
    // `formatAddress` is the spaced display form — 36 characters plus 8
    // separators. Padding to 36 misaligns every row, which is the sort of thing
    // that only shows up when the thing is actually run.
    const row = (owedBy: string, kind: string, created: string, settled: string, outstanding: string): string =>
      [owedBy.padEnd(ADDRESS_COLUMN), kind.padEnd(15), created.padStart(14), settled.padStart(14), outstanding.padStart(14)].join(' ')

    out.push(row('owed by', 'kind', 'created', 'settled', 'outstanding'))
    for (const line of report.lines) {
      out.push(
        row(
          formatAddress(line.owedBy),
          line.kind,
          nim(line.created),
          nim(line.settled),
          nim(line.outstanding),
        ),
      )
    }
    out.push('')
    out.push(row('TOTAL', '', nim(report.totalCreated), nim(report.totalSettled), nim(report.totalOutstanding)))
    out.push('(NIM; 1 NIM = 100,000 luna)')
  }

  if (!report.balanced) {
    out.push('')
    out.push('BALANCE BROKEN: created ≠ settled + outstanding. This is a bug in the reconciler, not a finding about the operator.')
  }

  if (report.standing.length > 0) {
    out.push('')
    out.push(`${report.standing.length} obligation(s) outstanding:`)
    for (const leg of report.standing) {
      out.push(
        `  ${ref(leg.ref).padEnd(20)} ${leg.kind.padEnd(15)} ${nim(leg.amount).padStart(14)} NIM  to ${formatAddress(leg.owedTo)}  (standing ${leg.ageBlocks} blocks)`,
      )
    }
    out.push('  An obligation in flight between a B and its M is normal; how long is too long is an operator policy, not a rule here.')
  }

  if (report.unmatched.length > 0) {
    out.push('')
    out.push(`${report.unmatched.length} settlement(s) discharged nothing — money moved, the debt still stands (§6 M):`)
    for (const item of report.unmatched) {
      out.push(
        `  ${ref(item.at).padEnd(20)} claims ${ref(item.claims).padEnd(20)} ${nim(item.value).padStart(14)} NIM  ${formatAddress(item.sender)} → ${formatAddress(item.recipient)}  tx ${item.txHash}`,
      )
    }
  }

  if (report.mismatches.length > 0) {
    out.push('')
    out.push(`${report.mismatches.length} verdict(s) disagree with the replay — the served log is not what these rules produce:`)
    for (const item of report.mismatches) {
      out.push(`  ${ref(item.at).padEnd(20)} log says ${item.logged}, replay says ${item.replayed}`)
    }
  }

  out.push('')
  out.push(isSound(report) ? 'SOUND: the log verifies and the replay agrees with every verdict in it.' : 'UNSOUND: see above.')
  return out
}
