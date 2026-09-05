// Assert the §3 constants' *relations* — never their values.
//
//   node scripts/check-tempo-relations.mjs
//   node scripts/check-tempo-relations.mjs --accept governance-delay-ordering
//
// Why this exists as a separate tool. `constants.test.ts` pins the mainnet
// literals, so on a tempo branch it goes red **by design** — which means the
// suite carries no signal on the one branch where the constants are most
// likely to be wrong, and the habit becomes "expect red, move on". Worse, a
// relational assertion sitting *after* a literal one in the same `it` never
// runs at all on a tempo profile: the literal throws first. That is how the
// 2026-08-16 fork found `docs/runbooks/testing.md` §2 recommending
// TERM_LENGTH 600 with GRACE_PERIOD 300 — a profile whose own table cited the
// `GRACE_PERIOD × 2 < TERM_LENGTH` bound it broke, unnoticed because no fork
// had been built from those numbers since the bound was pinned.
//
// So: every check here is a **relation between constants**, and none of them
// names a value. The script must therefore pass on the frozen mainnet
// constants and on any legitimate compressed profile alike — a check that
// only passes on one of the two belongs in `constants.test.ts` instead.
//
// It prints every relation it checked with the numbers it computed, because a
// silent green is exactly what it exists to replace: the point is that the
// operator reads the profile back before spending three hours on it.
//
// Deviations are named, not discovered. `tasks/09` §0 permits one knowingly
// (GOVERNANCE_DELAY under XFER_TIMELOCK, for a thin horizon window) and asks
// that it be recorded rather than found in the results — `--accept <id>` is
// that record, and it prints loudly.

import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))

const { values: options } = parseArgs({
  options: { accept: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' } },
})

if (options.help) {
  console.log('node scripts/check-tempo-relations.mjs [--accept <check-id>]…')
  process.exit(0)
}

const accepted = new Set(options.accept ?? [])

// ── The build the check reads, and whether it is the edit you just made ──────
//
// Everything here comes from `dist`, the same build `scripts/nns-send.mjs`
// sends with. A stale one is the trap the runbook already names, and it would
// make this check answer about the *previous* profile — so compare mtimes and
// refuse rather than reassure.

const source = join(repo, 'packages/core/src/constants.ts')
const built = join(repo, 'packages/core/dist/constants.js')

let builtAt
try {
  builtAt = statSync(built).mtimeMs
} catch {
  console.error(`no build at ${built}\n  run: pnpm --filter @nns/indexer... build`)
  process.exit(2)
}
if (statSync(source).mtimeMs > builtAt) {
  console.error(
    'packages/core/src/constants.ts is newer than its build — this check would answer about the previous profile.\n' +
      '  run: pnpm --filter @nns/indexer... build',
  )
  process.exit(2)
}

// LUNA_PER_NIM is a sibling export, not a CONSTANTS member — reading it off C
// yields undefined and every NIM figure prints NaN.
const { CONSTANTS: C, LUNA_PER_NIM, validateNameSyntax } = await import(join(repo, 'packages/core/dist/index.js'))

// ── Checks ──────────────────────────────────────────────────────────────────

const checks = []

/** @param severity 'error' stops the fork; 'advisory' is a shape worth seeing, not a bound. */
const check = (id, statement, ok, detail, severity = 'error') =>
  checks.push({ id, statement, ok, detail, severity })

const luna = (amount) => `${amount.toLocaleString('en-US')} luna`
const nim = (amount) => `${(Number(amount) / Number(LUNA_PER_NIM)).toLocaleString('en-US')} NIM`
const both = (amount) => `${luna(amount)} (${nim(amount)})`

// Structure — a mutable consensus input is a consensus input any caller can move.
check('constants-frozen', 'CONSTANTS is frozen', Object.isFrozen(C), `Object.isFrozen → ${Object.isFrozen(C)}`)
check(
  'reserved-names-frozen',
  'RESERVED_NAMES is frozen (Object.freeze is shallow)',
  Object.isFrozen(C.RESERVED_NAMES),
  `Object.isFrozen → ${Object.isFrozen(C.RESERVED_NAMES)}`,
)
check(
  'no-retired-constants',
  'the r20-retired constants are absent, not re-added',
  !('RECOVERY_TIMELOCK' in C) && !('PRICE_MAX_FACTOR' in C) && !('PRICE_MIN_INTERVAL' in C),
  ['RECOVERY_TIMELOCK', 'PRICE_MAX_FACTOR', 'PRICE_MIN_INTERVAL'].map((k) => `${k}: ${k in C ? 'PRESENT' : 'absent'}`).join(', '),
)

// Wire format (§5.1, §5.2, §6) — the tempo profile must not touch these, and
// the budget arithmetic is what proves an edit did not reach them by accident.
check('dust-value-nonzero', 'DUST_VALUE > 0 — the network rejects a value of 0 (§5.4)', C.DUST_VALUE > 0n, `DUST_VALUE = ${luna(C.DUST_VALUE)}`)
check(
  'delegate-message-budget',
  'MAX_DELEGATE_MESSAGE_BYTES < MAX_DATA_BYTES (§6 D keeps the global margin)',
  C.MAX_DELEGATE_MESSAGE_BYTES < C.MAX_DATA_BYTES,
  `${C.MAX_DELEGATE_MESSAGE_BYTES} < ${C.MAX_DATA_BYTES}`,
)
{
  const prefix = C.PROTOCOL_ID.length + 1 // NNS1 + type character
  const sizes = {
    G: prefix + C.MAX_NAME_LEN + 1 + C.MAX_REF_LEN,
    O: prefix + C.MAX_NAME_LEN + 1 + 15,
    A: prefix + C.MAX_NAME_LEN + 1 + 15 + 1 + 10,
    D: C.MAX_DELEGATE_MESSAGE_BYTES,
  }
  check(
    'message-size-budget',
    'every message type fits the 64-byte budget (§5.1, §6)',
    Object.values(sizes).every((size) => size <= C.MAX_DATA_BYTES),
    Object.entries(sizes)
      .map(([type, size]) => `${type}:${size}`)
      .join(' ') + ` ≤ MAX_DATA_BYTES ${C.MAX_DATA_BYTES}`,
  )
}
check(
  'name-length-ordering',
  'MIN_NAME_LEN < LONG_NAME_LEN < MAX_NAME_LEN (§4.1, §10.1)',
  C.MIN_NAME_LEN < C.LONG_NAME_LEN && C.LONG_NAME_LEN < C.MAX_NAME_LEN,
  `${C.MIN_NAME_LEN} < ${C.LONG_NAME_LEN} < ${C.MAX_NAME_LEN}`,
)

// Pricing (§10.1, §10.6) — the bands move with the profile, the rails do not.
check(
  'price-band-ordering',
  'PRICE_FLOOR ≤ FEE_LONG ≤ FEE_STANDARD ≤ PRICE_CEILING (§10.6)',
  C.PRICE_FLOOR <= C.FEE_LONG && C.FEE_LONG <= C.FEE_STANDARD && C.FEE_STANDARD <= C.PRICE_CEILING,
  `${nim(C.PRICE_FLOOR)} ≤ ${nim(C.FEE_LONG)} ≤ ${nim(C.FEE_STANDARD)} ≤ ${nim(C.PRICE_CEILING)}`,
)
check(
  'commission-bounds',
  'COMMISSION_RATE and COMMISSION_MAX_STEP within COMMISSION_CEILING (§10.6)',
  C.COMMISSION_RATE <= C.COMMISSION_CEILING && C.COMMISSION_MAX_STEP <= C.COMMISSION_CEILING,
  `rate ${C.COMMISSION_RATE} bp, step ${C.COMMISSION_MAX_STEP} bp, ceiling ${C.COMMISSION_CEILING} bp`,
)

// The three floors that do not scale with the bands (runbook §2). Each one is
// a trap a compressed profile walks into by scaling the bands one notch too
// far, and each fails as something that reads like a product defect.
{
  const margin = C.FEE_LONG / C.REFUND_FLOOR
  check(
    'trap/refund-floor-margin',
    'the smallest honest refundable amount (MIN_PRICE = FEE_LONG) is ≥ 10× REFUND_FLOOR',
    C.FEE_LONG >= 10n * C.REFUND_FLOOR,
    `FEE_LONG ${both(C.FEE_LONG)} ÷ REFUND_FLOOR ${luna(C.REFUND_FLOOR)} = ${margin}× (need ≥ 10×)` +
      '\n      below it a rejected B earns BELOW_REFUND_FLOOR, stages no ledger leg, and the settlement phase quietly empties',
  )
}
{
  const commission = (C.FEE_LONG * C.COMMISSION_RATE) / C.BASIS_POINTS
  check(
    'trap/commission-nonzero',
    'commission on the smallest sale floors above zero (§6 M)',
    commission > 0n,
    `floor(FEE_LONG ${luna(C.FEE_LONG)} × ${C.COMMISSION_RATE} bp) = ${luna(commission)}` +
      '\n      at zero, core refuses to build the leg and the issuer reports a per-leg failure — a profile mistake wearing a settlement defect',
  )
}
check(
  'trap/fee-long-vs-price-floor',
  'FEE_LONG ≥ PRICE_FLOOR — a band under its own floor is a state governance cannot restore',
  C.FEE_LONG >= C.PRICE_FLOOR,
  `FEE_LONG ${nim(C.FEE_LONG)} ${C.FEE_LONG === C.PRICE_FLOOR ? '=' : '>'} PRICE_FLOOR ${nim(C.PRICE_FLOOR)}` +
    (C.FEE_LONG === C.PRICE_FLOOR
      ? '\n      exactly on the floor: legal, and it means NO P can lower fee_long — a ladder must walk fee_standard down and fee_long up'
      : ''),
)

// Terms and timelocks (§7.3, §10.4, §10.6).
check('grace-shorter-than-term', 'GRACE_PERIOD < TERM_LENGTH (§7.3)', C.GRACE_PERIOD < C.TERM_LENGTH, `${C.GRACE_PERIOD} < ${C.TERM_LENGTH}`)
check(
  'grace-reminder-fits-term',
  'GRACE_PERIOD × 2 < TERM_LENGTH — §10.4’s reminder must not fire before the registration it warns about',
  C.GRACE_PERIOD * 2 < C.TERM_LENGTH,
  // Neutral separator, not `<`: this is the check that actually failed on a real
  // profile, and `600 < 600` printed beside FAIL reads as a claim rather than a result.
  `GRACE_PERIOD × 2 = ${C.GRACE_PERIOD * 2}, TERM_LENGTH = ${C.TERM_LENGTH}`,
)
check(
  'governance-delay-ordering',
  'GOVERNANCE_DELAY > XFER_TIMELOCK (§10.6 — notice is the whole protection since r20)',
  C.GOVERNANCE_DELAY > C.XFER_TIMELOCK,
  `${C.GOVERNANCE_DELAY} > ${C.XFER_TIMELOCK}` +
    '\n      tasks/09 §0 permits inverting this for a thin horizon window: --accept governance-delay-ordering',
)
check(
  'governance-delay-shape',
  'GOVERNANCE_DELAY = 2 × XFER_TIMELOCK — the mainnet 2:1 relation a profile rehearses',
  C.GOVERNANCE_DELAY === 2 * C.XFER_TIMELOCK,
  `${C.GOVERNANCE_DELAY} vs 2 × ${C.XFER_TIMELOCK} = ${2 * C.XFER_TIMELOCK}`,
  'advisory',
)
check(
  'transfer-matures-inside-term',
  'XFER_TIMELOCK < TERM_LENGTH — a transfer that cannot mature before expiry is unobservable',
  C.XFER_TIMELOCK < C.TERM_LENGTH,
  `${C.XFER_TIMELOCK} < ${C.TERM_LENGTH}`,
)
check(
  'offer-window-ordering',
  'OFFER_IRREVOCABLE < OFFER_MAX_LIFETIME (§6 O)',
  C.OFFER_IRREVOCABLE < C.OFFER_MAX_LIFETIME,
  `${C.OFFER_IRREVOCABLE} < ${C.OFFER_MAX_LIFETIME}`,
)
check(
  'windows-fit-inside-term',
  'OFFER_MAX_LIFETIME and GOVERNANCE_DELAY sit inside a term, so a name outlives what is measured against it',
  C.OFFER_MAX_LIFETIME < C.TERM_LENGTH && C.GOVERNANCE_DELAY < C.TERM_LENGTH,
  `OFFER_MAX_LIFETIME ${C.OFFER_MAX_LIFETIME}, GOVERNANCE_DELAY ${C.GOVERNANCE_DELAY}, TERM_LENGTH ${C.TERM_LENGTH}`,
  'advisory',
)

// Auctions (§6 A, r28) — a window measured from the landing block, an
// anti-sniping extension inside it, and an increment that must not round to
// nothing at the smallest legal starting price.
check(
  'auction-extension-inside-duration',
  'AUCTION_EXTENSION < AUCTION_MIN_DURATION (§6 A — a late bid extends a window, it does not define one)',
  C.AUCTION_EXTENSION < C.AUCTION_MIN_DURATION,
  `${C.AUCTION_EXTENSION} < ${C.AUCTION_MIN_DURATION}`,
)
check(
  'auction-closes-inside-term',
  'AUCTION_MIN_DURATION < TERM_LENGTH — an auction that cannot close before the name expires is only ever cancelled by the grace reset',
  C.AUCTION_MIN_DURATION < C.TERM_LENGTH,
  `${C.AUCTION_MIN_DURATION} < ${C.TERM_LENGTH}`,
)
{
  const increment = (C.FEE_LONG * C.AUCTION_MIN_INCREMENT_BP) / C.BASIS_POINTS
  check(
    'trap/auction-increment-nonzero',
    'the increment on a starting price at MIN_PRICE floors above zero (§6 A — the reason the starting price has a floor at all)',
    increment > 0n,
    `floor(FEE_LONG ${luna(C.FEE_LONG)} × ${C.AUCTION_MIN_INCREMENT_BP} bp) = ${luna(increment)}` +
      '\n      at zero a second bid could "raise" by nothing, and the battery\'s outbid rows would never refund anyone',
  )
}

// Checkpoints and the launch height (§8.1, §8.8, §0.3/§0.5 of tasks/09).
check(
  'launch-height-on-boundary',
  'LAUNCH_HEIGHT is a multiple of CHECKPOINT_INTERVAL — §8.1 puts checkpoints at absolute multiples, so otherwise the genesis checkpoint is never taken',
  C.LAUNCH_HEIGHT % C.CHECKPOINT_INTERVAL === 0,
  `${C.LAUNCH_HEIGHT} % ${C.CHECKPOINT_INTERVAL} = ${C.LAUNCH_HEIGHT % C.CHECKPOINT_INTERVAL}`,
)
check(
  'launch-height-above-genesis',
  'LAUNCH_HEIGHT is above the PoS genesis, where batch numbering starts',
  C.LAUNCH_HEIGHT > 3_456_000,
  `${C.LAUNCH_HEIGHT} > 3,456,000`,
)
check(
  'segment-length-on-boundary',
  'SEGMENT_LENGTH is a multiple of CHECKPOINT_INTERVAL (§8.8 segments end on a checkpoint)',
  C.SEGMENT_LENGTH % C.CHECKPOINT_INTERVAL === 0,
  `${C.SEGMENT_LENGTH} % ${C.CHECKPOINT_INTERVAL} = ${C.SEGMENT_LENGTH % C.CHECKPOINT_INTERVAL}`,
)

// The §3 cast (§3, §10.6).
{
  const roles = [C.TREASURY_ADDRESS, C.PROTOCOL_ADDRESS, C.ADMIN_ADDRESS, C.MARKETPLACE_ADDRESS]
  const burn = C.BURN_ADDRESS.replace(/\s+/g, '')
  check(
    'role-addresses-distinct',
    'the four §3 role addresses are pairwise distinct and none is the burn address',
    new Set(roles).size === roles.length && !roles.some((role) => role.replace(/\s+/g, '') === burn),
    `${new Set(roles).size} distinct of ${roles.length}, none equal to BURN_ADDRESS`,
  )
}

// RESERVED_NAMES (§4.1) — a list the tempo branch appends throwaways to, which
// is exactly when an entry that reserves nothing gets added.
{
  const invalid = C.RESERVED_NAMES.filter((name) => validateNameSyntax(name).ok !== true)
  const short = C.RESERVED_NAMES.filter((name) => name.length < C.MIN_NAME_LEN)
  const uncased = C.RESERVED_NAMES.filter((name) => name !== name.toLowerCase())
  check(
    'reserved-names-registrable',
    'every published entry is a name a G could actually carry — otherwise it reserves nothing at all (§4.1 never normalises)',
    invalid.length === 0 && short.length === 0 && uncased.length === 0,
    `${C.RESERVED_NAMES.length} entries; invalid syntax: ${invalid.length ? invalid.join(', ') : 'none'}; ` +
      `under MIN_NAME_LEN: ${short.length ? short.join(', ') : 'none'}; not lowercase: ${uncased.length ? uncased.join(', ') : 'none'}`,
  )
  check(
    'reserved-names-no-duplicates',
    'no duplicate entries — membership is a set',
    new Set(C.RESERVED_NAMES).size === C.RESERVED_NAMES.length,
    `${new Set(C.RESERVED_NAMES).size} unique of ${C.RESERVED_NAMES.length}`,
  )
}

// ── Report ──────────────────────────────────────────────────────────────────

console.log('Relations between §3 constants — values are printed, never asserted.')
console.log(`  build: packages/core/dist, from constants.ts of ${new Date(statSync(source).mtimeMs).toISOString()}`)
console.log('  profile:')
for (const key of [
  'CHECKPOINT_INTERVAL',
  'TERM_LENGTH',
  'GRACE_PERIOD',
  'XFER_TIMELOCK',
  'GOVERNANCE_DELAY',
  'OFFER_IRREVOCABLE',
  'OFFER_MAX_LIFETIME',
  'AUCTION_MIN_DURATION',
  'AUCTION_EXTENSION',
]) {
  console.log(`    ${key.padEnd(20)} ${C[key]}`)
}
console.log(`    ${'FEE_STANDARD'.padEnd(20)} ${both(C.FEE_STANDARD)}`)
console.log(`    ${'FEE_LONG'.padEnd(20)} ${both(C.FEE_LONG)}   (= MIN_PRICE at launch)`)
console.log(`    ${'LAUNCH_HEIGHT'.padEnd(20)} ${C.LAUNCH_HEIGHT}`)
console.log()

let failed = 0
let advisories = 0
let deviations = 0

for (const { id, statement, ok, detail, severity } of checks) {
  let label
  if (ok) label = 'PASS'
  else if (accepted.has(id)) {
    label = 'ACCEPTED DEVIATION'
    deviations++
  } else if (severity === 'advisory') {
    label = 'NOTE'
    advisories++
  } else {
    label = 'FAIL'
    failed++
  }
  console.log(`${label.padEnd(19)} ${id}`)
  console.log(`      ${statement}`)
  console.log(`      ${detail}`)
}

console.log()
console.log(
  `${checks.length} relations checked — ${checks.length - failed - advisories - deviations} pass, ` +
    `${failed} fail, ${advisories} advisory, ${deviations} accepted deviation${deviations === 1 ? '' : 's'}`,
)

if (deviations > 0) {
  console.log('\nAccepted deviations are a decision, not a pass. Record each one in the run log:')
  for (const { id, statement } of checks.filter((c) => !c.ok && accepted.has(c.id))) console.log(`  ${id} — ${statement}`)
}

if (failed > 0) {
  console.log('\nThis profile is not fit to fork from. Fix the constants and rebuild before starting an indexer.')
  process.exit(1)
}
