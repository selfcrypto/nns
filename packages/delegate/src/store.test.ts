import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { addressFromBytes, formatAddress } from '@nimiqnames/core'

import { LabelFileError, type NameLabels } from './labels.js'
import { createLogger, type LogLevel } from './logger.js'
import { LabelStore } from './store.js'

const addr = (fill: number): string => formatAddress(addressFromBytes(new Uint8Array(20).fill(fill)))

interface Line {
  readonly level: LogLevel
  readonly msg: string
  readonly key?: string | null
  readonly error?: string
}

let dir: string
let path: string
let lines: Line[]

const logger = () => {
  lines = []
  return createLogger({ level: 'debug', sink: (line) => lines.push(JSON.parse(line) as Line) })
}

const write = async (content: unknown, mtime: number): Promise<void> => {
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
  // mtime is set explicitly: two writes inside one filesystem timestamp tick
  // are exactly the case the poll must still notice, and a test that depended
  // on the clock's granularity would be flaky rather than wrong.
  await utimes(path, new Date(mtime), new Date(mtime))
}

const file = (labels: Record<string, unknown>): Record<string, unknown> => ({
  defaultTtl: 300,
  names: { binance: labels },
})

/** The store holds the whole file; these tests only ever exercise one name. */
const labelsOf = (store: LabelStore): NameLabels => store.current().names.get('binance') ?? new Map()

const open = async (): Promise<LabelStore> =>
  await LabelStore.open({ path, fallbackTtl: 300, reloadSec: 60, logger: logger() })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nns-delegate-'))
  path = join(dir, 'labels.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('boot', () => {
  it('serves the file it read', async () => {
    await write(file({ shop: addr(1) }), 1_000_000)
    const store = await open()
    expect(labelsOf(store).get('shop')?.address).toBe(addressFromBytes(new Uint8Array(20).fill(1)))
  })

  it('is fatal on an invalid file, and names the key', async () => {
    // Nothing good to keep serving, and a delegate answering 404 for every
    // label is — by §8.6's design — indistinguishable to a client from one
    // that is merely empty.
    await write(file({ shop: 'NQ99 nope' }), 1_000_000)
    await expect(open()).rejects.toThrow(LabelFileError)
    await expect(open()).rejects.toThrow(/names\.binance\.shop/)
  })

  it('is fatal when the file is missing', async () => {
    await expect(open()).rejects.toThrow()
  })
})

describe('reload', () => {
  it('picks up a new label without a restart', async () => {
    await write(file({ shop: addr(1) }), 1_000_000)
    const store = await open()

    await write(file({ shop: addr(1), pay: addr(2) }), 2_000_000)
    expect(await store.poll()).toBe(true)
    expect(labelsOf(store).get('pay')?.address).toBe(addressFromBytes(new Uint8Array(20).fill(2)))
    expect(lines.at(-1)).toMatchObject({ msg: 'delegate.labels.loaded', labels: 2 })
  })

  it('does nothing when neither mtime nor size moved', async () => {
    await write(file({ shop: addr(1) }), 1_000_000)
    const store = await open()
    expect(await store.poll()).toBe(false)
    expect(lines).toHaveLength(0)
  })

  it('keeps serving the previous file when the new one is broken, and logs the key', async () => {
    await write(file({ shop: addr(1), pay: addr(2) }), 1_000_000)
    const store = await open()

    await write(file({ shop: addr(1), pay: 'NQ99 typo' }), 2_000_000)
    expect(await store.poll()).toBe(false)

    // An owner's typo must not take their subdomains down.
    expect(labelsOf(store).size).toBe(2)
    expect(labelsOf(store).get('pay')?.address).toBe(addressFromBytes(new Uint8Array(20).fill(2)))

    const failure = lines.at(-1)
    expect(failure).toMatchObject({ level: 'error', msg: 'delegate.labels.rejected', key: 'names.binance.pay' })
    expect(failure?.error).toContain('not a Nimiq address')
  })

  it('recovers on the next poll once the file is fixed', async () => {
    await write(file({ shop: addr(1) }), 1_000_000)
    const store = await open()
    await write('{ broken', 2_000_000)
    expect(await store.poll()).toBe(false)
    expect(lines.at(-1)).toMatchObject({ msg: 'delegate.labels.rejected', key: null })

    await write(file({ shop: addr(3) }), 3_000_000)
    expect(await store.poll()).toBe(true)
    expect(labelsOf(store).get('shop')?.address).toBe(addressFromBytes(new Uint8Array(20).fill(3)))
  })

  it('survives the file disappearing', async () => {
    await write(file({ shop: addr(1) }), 1_000_000)
    const store = await open()
    await rm(path)
    expect(await store.poll()).toBe(false)
    expect(labelsOf(store).size).toBe(1)
    expect(lines.at(-1)).toMatchObject({ level: 'error', msg: 'delegate.labels.rejected' })
  })

  it('reloads unconditionally on demand — the SIGHUP path', async () => {
    await write(file({ shop: addr(1) }), 1_000_000)
    const store = await open()
    // Same mtime and same size: poll sees nothing, an explicit reload does.
    await write(file({ shop: addr(4) }), 1_000_000)
    expect(await store.poll()).toBe(false)
    expect(await store.reload()).toBe(true)
    expect(labelsOf(store).get('shop')?.address).toBe(addressFromBytes(new Uint8Array(20).fill(4)))
  })

  it('advances loadedAt only when the file actually changed', async () => {
    await write(file({ shop: addr(1) }), 1_000_000)
    let clock = 5_000
    const store = await LabelStore.open({
      path,
      fallbackTtl: 300,
      reloadSec: 60,
      logger: logger(),
      now: () => clock,
    })
    expect(store.loadedAt()).toBe(5_000)

    clock = 6_000
    await store.poll()
    expect(store.loadedAt()).toBe(5_000)

    await write(file({ shop: addr(1), pay: addr(2) }), 2_000_000)
    await store.poll()
    expect(store.loadedAt()).toBe(6_000)
  })
})
