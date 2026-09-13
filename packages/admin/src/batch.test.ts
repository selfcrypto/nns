import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { CONSTANTS, CodecError, encodeUnreserve, parseAddress } from '@nimiqnames/core'

import { broadcastBatch, describeBatchPlan, parseBatchArgs, parseBatchRows, planBatch } from './batch.js'
import { AdminRefusal, UsageError, blockingChecks, type AdminRpc } from './cli.js'
import type { NameAvailability, ReservationSource } from './reservation.js'

const ADMIN = CONSTANTS.ADMIN_ADDRESS
const BOB = parseAddress('NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK')
const CAROL = parseAddress('NQ87 2400 0000 0000 0000 0000 0000 0000 0012')
const HEAD = 58_099_950

interface RecordedCall {
  readonly method: string
  readonly params: readonly unknown[]
}

function fakeRpc(balance = 2_000_000): { rpc: AdminRpc; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let sent = 0
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
          sent += 1
          return Promise.resolve(`${sent}`.padStart(64, '0') as T)
        default:
          return Promise.reject(new Error(`unexpected RPC method ${method}`))
      }
    },
  }
  return { rpc, calls }
}

/** `/available/{name}` per name: everything is AVAILABLE unless the map says otherwise. */
function fakeReservation(byName: Record<string, Partial<NameAvailability>> = {}): ReservationSource {
  return {
    fetchAvailability(name: string): Promise<NameAvailability> {
      return Promise.resolve(
        Object.freeze({
          name,
          available: true,
          reason: null,
          status: null,
          expiry: null,
          height: HEAD,
          url: `https://api.example/available/${name}`,
          ...byName[name],
        }),
      )
    },
  }
}

const HELD: Partial<NameAvailability> = { available: false, reason: 'TAKEN', status: 'REGISTERED', expiry: 59_765_881 }

const FILE = `# the re-award list, 2026-09-11
oldowner-one   NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK
oldowner-two   NQ87 2400 0000 0000 0000 0000 0000 0000 0012   L   # a lifetime

zzqk NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK
`

function file(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'nns-batch-'))
  const path = join(dir, 'awards.txt')
  writeFileSync(path, text)
  return path
}

describe('parseBatchRows', () => {
  it('reads name, recipient and the L flag, skipping comments and blank lines', () => {
    expect(parseBatchRows(FILE, 'awards.txt')).toEqual([
      { name: 'oldowner-one', recipient: BOB, lifetime: false },
      { name: 'oldowner-two', recipient: CAROL, lifetime: true },
      { name: 'zzqk', recipient: BOB, lifetime: false },
    ])
  })

  it('refuses a malformed row, naming the line', () => {
    expect(() => parseBatchRows('alice\n', 'awards.txt')).toThrow(/awards.txt:1: expected `name recipient \[L\]`/)
    expect(() => parseBatchRows('alice NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK X\n', 'awards.txt')).toThrow(UsageError)
    expect(() => parseBatchRows('alice not-an-address\n', 'awards.txt')).toThrow(/awards.txt:1:/)
  })

  it('refuses a name listed twice — the second award forfeits on the first', () => {
    const twice = 'alice NQ85 FJ4R D8VG PP5D FR7H YQ5H G99J 7V65 JRKK\nalice NQ87 2400 0000 0000 0000 0000 0000 0000 0012\n'
    expect(() => parseBatchRows(twice, 'awards.txt')).toThrow(/awards.txt:2: "alice" is already awarded on line 1/)
  })

  it('refuses an empty file — a batch of nothing is a wrong file, not a no-op', () => {
    expect(() => parseBatchRows('# nothing here\n', 'awards.txt')).toThrow(/holds no award rows/)
  })
})

describe('parseBatchArgs', () => {
  it('takes the file after --batch and --send anywhere, and nothing else', () => {
    const path = file(FILE)
    expect(parseBatchArgs(['--batch', path]).rows).toHaveLength(3)
    expect(parseBatchArgs(['--batch', path]).send).toBe(false)
    expect(parseBatchArgs(['--send', '--batch', path]).send).toBe(true)
    expect(() => parseBatchArgs(['--batch'])).toThrow(UsageError)
    expect(() => parseBatchArgs(['--batch', path, 'extra'])).toThrow(UsageError)
    expect(() => parseBatchArgs(['--batch', path, '--lifetime'])).toThrow(/only other flag is --send/)
    expect(() => parseBatchArgs(['--batch', join(path, 'missing')])).toThrow(/cannot read/)
  })
})

const command = { file: 'awards.txt', rows: parseBatchRows(FILE, 'awards.txt'), send: false }

describe('planBatch', () => {
  it('plans every row through the one U planner, against one head, and reads nothing it would not read for one', async () => {
    const { rpc, calls } = fakeRpc()
    const plan = await planBatch(rpc, fakeReservation(), command)
    expect(plan.rows).toHaveLength(3)
    expect(plan.rows.map((row) => row.kind)).toEqual(['award', 'award', 'award'])
    expect(plan.rows[1]?.data).toBe(encodeUnreserve({ name: 'oldowner-two', recipient: CAROL, lifetime: true }).data)
    expect(plan.head).toBe(HEAD)
    expect(plan.cost).toBe(3n * CONSTANTS.DUST_VALUE)
    expect(plan.checks).toEqual([])
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(['getBlockNumber', 'getAccountByAddress']))
  })

  it('a held name refuses the whole batch, with the name in front of the row’s refusal', async () => {
    const { rpc } = fakeRpc()
    const plan = await planBatch(rpc, fakeReservation({ 'oldowner-two': HELD }), command)
    const refusals = blockingChecks(plan.checks)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.message).toMatch(/^oldowner-two: "oldowner-two" is held/)
    expect(refusals[0]?.message).toContain('NAME_NOT_AVAILABLE')
    await expect(broadcastBatch(rpc, plan)).rejects.toThrow(AdminRefusal)
  })

  it('checks §11.5 once over the whole cost, not once per row', async () => {
    // Two luna covers two dust awards and not three: every row passes its
    // own check, and only the batch sees the third one would never be mined.
    const { rpc } = fakeRpc(2)
    const plan = await planBatch(rpc, fakeReservation(), command)
    expect(plan.rows.every((row) => blockingChecks(row.checks).length === 0)).toBe(true)
    const refusals = blockingChecks(plan.checks)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.message).toContain('the 3 awards cost together')
  })

  it('warns under the floor once the batch is paid, as one plan does', async () => {
    // ADMIN_MIN_BALANCE is 10 NIM; three luna of dust leave exactly that
    // from 1,000,003, and one luna short of it from 1,000,002.
    const exact = await planBatch(fakeRpc(1_000_003).rpc, fakeReservation(), command)
    expect(exact.checks).toEqual([])
    const under = await planBatch(fakeRpc(1_000_002).rpc, fakeReservation(), command)
    expect(under.checks.map((check) => check.severity)).toEqual(['warn'])
    expect(under.checks[0]?.message).toContain('once these are paid')
  })

  it('refuses offline, before the node hears anything, whatever the builder refuses', async () => {
    const { rpc, calls } = fakeRpc()
    // BURN_ADDRESS as the awardee: the builder's refusal, before any read.
    const burn = { ...command, rows: [{ name: 'alice', recipient: parseAddress('NQ07 0000 0000 0000 0000 0000 0000 0000 0000'), lifetime: false }] }
    await expect(planBatch(rpc, fakeReservation(), burn)).rejects.toThrow(CodecError)
    expect(calls).toEqual([])
  })
})

describe('describeBatchPlan', () => {
  it('prints every row’s decoded plan, numbered, then the batch line and its checks', async () => {
    const plan = await planBatch(fakeRpc().rpc, fakeReservation({ 'oldowner-two': HELD }), command)
    const lines = describeBatchPlan(plan).join('\n')
    expect(lines).toContain('U batch: 3 awards from awards.txt')
    expect(lines).toContain('[1/3] U award: oldowner-one')
    expect(lines).toContain('[2/3] U award: oldowner-two (lifetime)')
    expect(lines).toContain('[3/3] U award: zzqk')
    expect(lines).toContain('decoded: name "oldowner-two", lifetime flag L')
    expect(lines).toContain('batch     3 awards (1 lifetime), 3 luna')
    expect(lines).toContain('IRREVERSIBLE')
    expect(lines).toContain('REFUSED: oldowner-two: "oldowner-two" is held')
    // The row's own refusal is not printed a second time inside the row.
    expect(lines.split('REFUSED').length - 1).toBe(1)
  })
})

describe('broadcastBatch', () => {
  it('sends the rows in file order, each unlocked and sent as the one broadcast does', async () => {
    const { rpc, calls } = fakeRpc()
    const plan = await planBatch(rpc, fakeReservation(), command)
    const sent = await broadcastBatch(rpc, plan)
    expect(sent.map((one) => one.validityStartHeight)).toEqual([HEAD, HEAD, HEAD])
    expect(sent.map((one) => one.hash)).toEqual(['1'.padStart(64, '0'), '2'.padStart(64, '0'), '3'.padStart(64, '0')])
    const sends = calls.filter((c) => c.method === 'sendBasicTransactionWithData')
    expect(sends.map((c) => c.params[1])).toEqual([BOB, CAROL, BOB])
    expect(sends.map((c) => c.params[2])).toEqual(plan.rows.map((row) => row.data))
    expect(sends.every((c) => c.params[0] === ADMIN)).toBe(true)
  })

  it('sends nothing from a batch a row refused', async () => {
    const { rpc, calls } = fakeRpc()
    const plan = await planBatch(rpc, fakeReservation({ zzqk: HELD }), command)
    await expect(broadcastBatch(rpc, plan)).rejects.toThrow(/refusing to broadcast the batch/)
    expect(calls.filter((c) => c.method === 'sendBasicTransactionWithData')).toEqual([])
  })
})
