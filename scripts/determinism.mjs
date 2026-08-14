// Determinism harness — sync the indexer from empty to a fixed height N times
// and prove every checkpoint came out byte-identical.
//
//   node scripts/determinism.mjs                     # 3 runs, target derived from head
//   node scripts/determinism.mjs --runs 5 --height 58852320
//
// This is `docs/runbooks/testing.md` §8 made repeatable, and it closes the one
// hole that recipe has: runs E/F compared two databases capped at the height
// both happened to reach, because head moves between runs. Here the target is
// fixed **before the first run**, so every run replays the identical window and
// the comparison is over the whole of it, not over a prefix negotiated after
// the fact.
//
// What each run does: drop the database, create it empty, start the compiled
// `dist/main.js` — so migrations apply from nothing, the way they will on a
// fresh operator's node — and stop it the moment the cursor passes the target.
// Then it reads back every checkpoint at or below the target and compares the
// six §8.1 digests (`name_root`, `prices_root`, `pending_root`,
// `unreserved_root`, `log_hash`, `commitment`) plus the layout byte.
//
// Long-running by nature — a run is a full replay from `LAUNCH_HEIGHT` — so it
// is invoked deliberately and is not part of `pnpm test`.
//
// Options
//
//   --runs <n>            how many replays (default 3, minimum 2)
//   --height <h>          target height; must be a multiple of
//                         CHECKPOINT_INTERVAL. Default: the highest boundary
//                         at least two intervals below the current head, so
//                         every run can reach it without waiting on the chain
//   --launch-height <h>   override NNS_LAUNCH_HEIGHT for every run equally —
//                         the window is a harness parameter, and .env's value
//                         is whatever the last session left there
//   --database <name>     throwaway database (default nns_determinism). It is
//                         dropped before every run and after the last one
//   --env <path>          base environment (default packages/indexer/.env)
//   --admin-database <n>  maintenance database for CREATE/DROP (default postgres)
//   --out <dir>           where run logs and checkpoint dumps land
//                         (default /tmp/nns-determinism-<timestamp>)
//   --timeout <seconds>   per-run ceiling before the harness gives up (default 3600)
//   --keep                do not drop the database after the last run
//   --no-build            skip the rebuild (the default rebuild is what stops a
//                         stale dist/ from being what you actually measured)
//
// Exit code is 0 only if every run reached the target and every digest agreed.
// On a divergence the last run's database is left in place, and every run's
// checkpoints are on disk under --out either way: the evidence must outlive the
// drop, which is the reason the two-database recipe existed in the first place.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, existsSync, openSync, closeSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))

const { CONSTANTS } = await import(join(repo, 'packages/core/dist/index.js'))
const { createPool, historyHorizon } = await import(join(repo, 'packages/indexer/dist/index.js'))

const INTERVAL = CONSTANTS.CHECKPOINT_INTERVAL

/** The six §8.1 digests, plus the layout that says which preimage they are. */
const COLUMNS = [
  'name_root',
  'prices_root',
  'pending_root',
  'unreserved_root',
  'log_hash',
  'commitment',
  'layout',
]

const { values: opts } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    height: { type: 'string' },
    'launch-height': { type: 'string' },
    database: { type: 'string', default: 'nns_determinism' },
    env: { type: 'string', default: 'packages/indexer/.env' },
    'admin-database': { type: 'string', default: 'postgres' },
    out: { type: 'string' },
    timeout: { type: 'string', default: '3600' },
    keep: { type: 'boolean', default: false },
    'no-build': { type: 'boolean', default: false },
  },
})

const fail = (message) => {
  process.stderr.write(`determinism: ${message}\n`)
  process.exit(2)
}

const integer = (raw, flag, min) => {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) fail(`--${flag} must be an integer >= ${min}, got ${raw}`)
  return value
}

const runs = integer(opts.runs, 'runs', 2)
const timeoutMs = integer(opts.timeout, 'timeout', 1) * 1000

// ── Environment ──────────────────────────────────────────────────────────────

const envPath = join(repo, opts.env)
if (!existsSync(envPath)) fail(`no environment file at ${envPath} (--env)`)

// Same shape as scripts/nns-send.mjs reads: KEY=value, comments and blanks out.
const baseEnv = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
)

if (opts['launch-height'] !== undefined) {
  baseEnv.NNS_LAUNCH_HEIGHT = String(integer(opts['launch-height'], 'launch-height', 0))
}
const launchHeight = integer(baseEnv.NNS_LAUNCH_HEIGHT ?? '', 'launch-height', 0)

if (!baseEnv.NNS_DATABASE_URL) fail(`${envPath} sets no NNS_DATABASE_URL`)

// The database is dropped without asking, so the name is checked rather than
// trusted: never the production database, never a replay baseline, and never
// whatever the base .env is currently pointed at — that one is the live
// mistake, since the harness would otherwise destroy the database the operator
// is running against by doing nothing more than accepting a default.
const database = opts.database
const baseUrl = new URL(baseEnv.NNS_DATABASE_URL)
const envDatabase = decodeURIComponent(baseUrl.pathname.slice(1))
for (const [forbidden, why] of [
  ['nns', 'the production database'],
  ['nns_replay_f', 'the recorded replay baseline'],
  [envDatabase, `the database ${opts.env} points at`],
]) {
  if (database === forbidden) fail(`refusing to drop ${database} — that is ${why}`)
}
if (/^nns_replay_/.test(database)) fail(`refusing to drop ${database} — replay databases are baselines`)

const urlFor = (name) => {
  const url = new URL(baseUrl)
  url.pathname = `/${encodeURIComponent(name)}`
  return url.toString()
}
const runUrl = urlFor(database)
const adminUrl = urlFor(opts['admin-database'])

const rpcUrl = baseEnv.NNS_RPC_URL || `${baseEnv.NNS_RPC_SCHEME ?? 'http'}://${baseEnv.NNS_RPC_HOST}:${baseEnv.NNS_RPC_PORT}`
const rpcAuth =
  baseEnv.NNS_RPC_USER
    ? { Authorization: `Basic ${Buffer.from(`${baseEnv.NNS_RPC_USER}:${baseEnv.NNS_RPC_PASSWORD ?? ''}`).toString('base64')}` }
    : {}

/** Every RPC result is wrapped in `{data, metadata}` — unwrap or read undefined. */
async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...rpcAuth },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await response.json()
  // The node puts "Block not found: N" in `data` and a flat "Internal error" in
  // `message`, so a caller reading `message` alone cannot tell what went wrong.
  if (body.error) throw new Error(`${method}: ${[body.error.message, body.error.data].filter(Boolean).join(' — ')}`)
  return body.result.data
}

// ── The node's history horizon ───────────────────────────────────────────────
//
// The failure this exists to prevent, met on 2026-08-14: a resynced node holds
// no history below its sync point, and `getTransactionsByBatchNumber` answers a
// batch it no longer has with `[]` rather than an error. Every run then agrees,
// perfectly, on an empty registry — the harness reports byte-identical
// checkpoints and proves nothing.
//
// The probe and the bisection are `packages/indexer/src/horizon.ts`, which is
// also what the indexer itself refuses to start below: one mechanism, so the
// harness cannot end up disagreeing with the thing it measures. `historyHorizon`
// takes any client with the two block methods, so the raw `rpc` above will do.

const blockReader = {
  getBlockNumber: () => rpc('getBlockNumber').then(Number),
  getBlockByNumber: (height, includeBody) => rpc('getBlockByNumber', [height, includeBody]),
}

// ── Target ───────────────────────────────────────────────────────────────────

const head = Number(await rpc('getBlockNumber'))

const earliest = await historyHorizon(blockReader, launchHeight)
if (earliest !== null) {
  fail(
    `the node has no block at NNS_LAUNCH_HEIGHT ${launchHeight.toLocaleString()} — its history starts at ` +
      `${earliest.toLocaleString()}.\n` +
      '  A batch below that answers with an empty transaction list, not an error, so every run would\n' +
      '  agree on a registry that is empty because the messages are unreachable. Re-index the node\n' +
      `  with history, or pass --launch-height at or above ${earliest.toLocaleString()}.`,
  )
}
const boundaryBelow = (height) => Math.floor(height / INTERVAL) * INTERVAL

// Two intervals of margin: the scanner never advances past the last finalised
// macro block, and a target the chain has not comfortably passed turns the
// harness into a wait rather than a replay.
const target = opts.height === undefined ? boundaryBelow(head - 2 * INTERVAL) : integer(opts.height, 'height', 0)

if (target % INTERVAL !== 0) fail(`--height ${target} is not a multiple of CHECKPOINT_INTERVAL (${INTERVAL})`)
if (target <= launchHeight) fail(`--height ${target} is not above NNS_LAUNCH_HEIGHT ${launchHeight}`)
if (target > head - INTERVAL) fail(`--height ${target} is within one interval of head ${head} — pick a lower target`)

const outDir = opts.out ?? join(tmpdir(), `nns-determinism-${new Date().toISOString().replace(/[:.]/g, '-')}`)
mkdirSync(outDir, { recursive: true })

const firstBoundary = Math.ceil(launchHeight / INTERVAL) * INTERVAL
const expected = Math.floor((target - firstBoundary) / INTERVAL) + 1

process.stdout.write(
  [
    `determinism harness — ${runs} runs`,
    `  node          ${rpcUrl}  (head ${head.toLocaleString()})`,
    `  launch height ${launchHeight.toLocaleString()}`,
    `  target height ${target.toLocaleString()}  (${(target - launchHeight).toLocaleString()} blocks, ~${expected} checkpoints)`,
    `  database      ${database}`,
    `  artifacts     ${outDir}`,
    '',
  ].join('\n'),
)

// ── Postgres helpers ─────────────────────────────────────────────────────────

const quoteIdent = (name) => `"${name.replaceAll('"', '""')}"`

async function withPool(url, work) {
  const pool = createPool(url)
  try {
    return await work(pool)
  } finally {
    await pool.end()
  }
}

async function recreateDatabase() {
  await withPool(adminUrl, async (pool) => {
    // FORCE: a leftover connection from an interrupted run must not turn the
    // drop into a hang the next session has to diagnose.
    await pool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`)
    await pool.query(`CREATE DATABASE ${quoteIdent(database)}`)
  })
}

async function dropDatabase() {
  await withPool(adminUrl, (pool) => pool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`))
}

// ── One run ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function replay(index) {
  const logPath = join(outDir, `run-${index}.log`)
  await recreateDatabase()

  const started = Date.now()
  const fd = openSync(logPath, 'w')
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: join(repo, 'packages/indexer'),
    env: { ...process.env, ...baseEnv, NNS_DATABASE_URL: runUrl },
    stdio: ['ignore', fd, fd],
  })
  closeSync(fd)

  let exit = null
  child.on('exit', (code, signal) => {
    exit = { code, signal }
  })

  const run = await withPool(runUrl, async (pool) => {
    /** −1 until the indexer has migrated and committed its first batch. */
    const scannedThrough = async () => {
      try {
        const result = await pool.query('SELECT scanned_through FROM "cursor"')
        return result.rows[0]?.scanned_through ?? -1
      } catch {
        return -1
      }
    }

    try {
      const deadline = started + timeoutMs
      while ((await scannedThrough()) < target) {
        if (exit !== null) {
          throw new Error(
            `run ${index} exited before reaching ${target.toLocaleString()} ` +
              `(code ${exit.code}, signal ${exit.signal})\n  log: ${logPath}\n${tail(logPath)}`,
          )
        }
        if (Date.now() > deadline) {
          throw new Error(
            `run ${index} did not reach ${target.toLocaleString()} within ${timeoutMs / 1000}s` +
              `\n  log: ${logPath}\n${tail(logPath)}`,
          )
        }
        await sleep(1000)
      }
    } finally {
      // SIGTERM aborts the scan between batches; the in-flight batch's commit
      // is one transaction, so waiting for the exit is what makes the read
      // below stable — and what lets the next run drop the database.
      if (exit === null) child.kill('SIGTERM')
      while (exit === null) await sleep(200)
    }

    const checkpoints = await pool.query(
      `SELECT height, ${COLUMNS.slice(0, -1)
        .map((column) => `encode(${column},'hex') AS ${column}`)
        .join(', ')}, layout
         FROM checkpoints WHERE height <= $1 ORDER BY height`,
      [target],
    )
    const migrations = await pool.query('SELECT name FROM schema_migrations ORDER BY name')
    const logRows = await pool.query('SELECT count(*)::int AS n FROM log WHERE block_height <= $1', [target])
    const cursor = await pool.query('SELECT scanned_through FROM "cursor"')
    return {
      index,
      seconds: (Date.now() - started) / 1000,
      logPath,
      checkpoints: checkpoints.rows,
      migrations: migrations.rows.map((row) => row.name),
      logRows: logRows.rows[0].n,
      stoppedAt: cursor.rows[0]?.scanned_through ?? null,
    }
  })
  const { seconds } = run

  // The §8 recipe, reproduced byte for byte so its digest is quotable beside
  // the ones in docs/status.md: psql -At -F '|' over the same column list.
  const dump = run.checkpoints
    .map((row) => [row.height, ...COLUMNS.map((column) => row[column])].join('|'))
    .join('\n')
  run.digest = createHash('sha256')
    .update(dump === '' ? '' : `${dump}\n`)
    .digest('hex')
  writeFileSync(join(outDir, `run-${index}.checkpoints`), dump === '' ? '' : `${dump}\n`)

  process.stdout.write(
    `run ${index}: ${run.checkpoints.length} checkpoints, ${run.logRows} log rows, ` +
      `stopped at ${run.stoppedAt?.toLocaleString()}, ${seconds.toFixed(0)}s, sha256 ${run.digest.slice(0, 8)}…\n`,
  )
  return run
}

function tail(path, lines = 12) {
  try {
    return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

// ── Compare ──────────────────────────────────────────────────────────────────

/** Runs grouped by the value they produced, so a report can name both sides. */
function disagreements(values) {
  const byValue = new Map()
  for (const [index, value] of values) {
    const key = String(value)
    if (!byValue.has(key)) byValue.set(key, [])
    byValue.get(key).push(index)
  }
  return byValue.size === 1 ? null : byValue
}

function compare(results) {
  const findings = []

  const counts = disagreements(results.map((run) => [run.index, run.checkpoints.length]))
  if (counts !== null) {
    findings.push(
      `checkpoint count differs at or below ${target.toLocaleString()}: ` +
        [...counts].map(([count, indexes]) => `${count} in run${plural(indexes)} ${indexes.join(', ')}`).join('; '),
    )
  }

  const migrations = disagreements(results.map((run) => [run.index, run.migrations.join(',')]))
  if (migrations !== null) {
    findings.push(
      'migrations applied differ between runs: ' +
        [...migrations].map(([set, indexes]) => `run${plural(indexes)} ${indexes.join(', ')} → ${set}`).join('; '),
    )
  }

  const heights = [...new Set(results.flatMap((run) => run.checkpoints.map((row) => row.height)))].sort((a, b) => a - b)
  for (const height of heights) {
    const rows = results.map((run) => [run.index, run.checkpoints.find((row) => row.height === height)])
    const missing = rows.filter(([, row]) => row === undefined).map(([index]) => index)
    if (missing.length > 0) {
      findings.push(`height ${height.toLocaleString()}: no checkpoint in run${plural(missing)} ${missing.join(', ')}`)
      continue
    }
    for (const column of COLUMNS) {
      const split = disagreements(rows.map(([index, row]) => [index, row[column]]))
      if (split === null) continue
      findings.push(
        `height ${height.toLocaleString()} · ${column}: ` +
          [...split]
            .map(([value, indexes]) => `run${plural(indexes)} ${indexes.join(', ')} → ${abbreviate(value)}`)
            .join('  |  '),
      )
    }
  }
  return findings
}

const plural = (list) => (list.length === 1 ? '' : 's')
const abbreviate = (value) => (value.length > 24 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value)

// ── Drive ────────────────────────────────────────────────────────────────────

if (!opts['no-build']) {
  // A stale dist/ is the trap this rebuild exists to close: the harness would
  // otherwise report determinism about yesterday's code, convincingly.
  process.stdout.write('building @nns/indexer (--no-build to skip)…\n')
  await new Promise((resolve, reject) => {
    const build = spawn('pnpm', ['--filter', '@nns/indexer...', 'build'], { cwd: repo, stdio: 'inherit' })
    build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build failed (exit ${code})`))))
    build.on('error', reject)
  })
}

if (!existsSync(join(repo, 'packages/indexer/dist/main.js'))) {
  fail('packages/indexer/dist/main.js is missing — run pnpm --filter @nns/indexer... build')
}

const results = []
// Either of these keeps the database: a divergence needs its rows, and a run
// that died needs whatever it had written when it did.
let diverged = false
let broke = false
try {
  for (let index = 1; index <= runs; index += 1) {
    results.push(await replay(index))
  }

  const findings = compare(results)
  process.stdout.write('\n')
  if (findings.length === 0) {
    const [first] = results
    process.stdout.write(
      `IDENTICAL — ${first.checkpoints.length} checkpoints, ` +
        `${first.checkpoints[0]?.height.toLocaleString()}–${target.toLocaleString()}, ` +
        `${COLUMNS.length} committed columns, across ${runs} runs from empty.\n` +
        `sha256 ${first.digest} on every run (docs/runbooks/testing.md §8 recipe).\n` +
        `migrations applied fresh: ${first.migrations.join(', ')}\n`,
    )
  } else {
    diverged = true
    process.stdout.write(`DIVERGENCE — ${findings.length} finding${plural(findings)}:\n`)
    for (const finding of findings.slice(0, 40)) process.stdout.write(`  ${finding}\n`)
    if (findings.length > 40) process.stdout.write(`  … ${findings.length - 40} more\n`)
    process.stdout.write('\n')
    process.exitCode = 1
  }
  process.stdout.write(`artifacts: ${outDir}\n`)
} catch (error) {
  broke = true
  process.stderr.write(`determinism: ${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write(`artifacts: ${outDir}\n`)
  process.exitCode = 1
} finally {
  if (!diverged && !broke && !opts.keep) await dropDatabase()
  else process.stdout.write(`database ${database} kept — it holds the last run's rows.\n`)
}
