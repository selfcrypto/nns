// Refuse a tempo profile that has wandered onto main.
//
//   node scripts/check-mainnet-constants.mjs        # check the working tree file
//   git show :packages/core/src/constants.ts | node scripts/check-mainnet-constants.mjs -
//
// Six literals, one file (seven until the 2026-09-11 fold folded the two fee
// bands into one FEE_BASE). Nothing else — not the relations (that is
// `check-tempo-relations.mjs`, which asserts relations and never values), not
// the other constants, not any other path.
//
// Why it exists. A compressed-tempo run edits `constants.ts` on a throwaway
// branch, and every fix goes on **main, never on the
// branch** — precisely so a fix can never carry tempo values home. On
// 2026-08-16 an r23 change was authored on the tempo branch anyway. Nothing
// leaked: the paths moved to main were named individually and `constants.ts`
// was not among them, and `constants.test.ts` pins the literals so the branch
// is loudly red. But "the author checked which files differed" is discipline,
// and this is the check that does not depend on it.
//
// Exit codes, matching `check-tempo-relations.mjs`:
//   0  the six literals are intact
//   1  at least one differs — this is the refusal
//   2  the file could not be read or a literal could not be found at all

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE = 'packages/core/src/constants.ts'

/** The mainnet values, as §3 prints them. The base fee in NIM, the rest in blocks. */
const MAINNET = {
  FEE_BASE: 400,
  TERM_LENGTH: 31_536_000,
  GRACE_PERIOD: 2_592_000,
  GOVERNANCE_DELAY: 86_400,
  XFER_TIMELOCK: 43_200,
  CHECKPOINT_INTERVAL: 720,
}

function read() {
  if (process.argv[2] === '-') return readFileSync(0, 'utf8')
  return readFileSync(join(repo, SOURCE), 'utf8')
}

let text
try {
  text = read()
} catch (error) {
  console.error(`cannot read ${SOURCE}: ${error.message}`)
  process.exit(2)
}

const failures = []
const missing = []

for (const [key, expected] of Object.entries(MAINNET)) {
  // `FEE_BASE: nim(400n),` and `TERM_LENGTH: 31_536_000,` in one shape.
  const match = new RegExp(`^\\s*${key}:\\s*(?:nim\\()?([0-9_]+)n?\\)?`, 'm').exec(text)
  if (match === null) {
    missing.push(key)
    continue
  }
  const actual = Number(match[1].replaceAll('_', ''))
  if (actual !== expected) failures.push({ key, actual, expected })
}

if (missing.length > 0) {
  console.error(`${SOURCE}: could not find ${missing.join(', ')} — the file's shape changed, so this guard cannot judge it`)
  process.exit(2)
}

if (failures.length > 0) {
  console.error(`REFUSED — ${SOURCE} does not carry the mainnet values:\n`)
  for (const { key, actual, expected } of failures) {
    console.error(`  ${key.padEnd(20)} ${String(actual).padStart(10)}   expected ${expected}`)
  }
  console.error(
    '\nA compressed-tempo profile belongs on a throwaway branch that never merges\n' +
      "(every fix goes on main, never on the branch). If you are\n" +
      'deliberately changing a §3 constant, update the pin in constants.test.ts in\n' +
      'the same commit and this guard with it.',
  )
  process.exit(1)
}

console.log(`${SOURCE}: all six mainnet literals intact`)
