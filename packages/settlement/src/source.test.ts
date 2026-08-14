import { describe, expect, it } from 'vitest'

import { encodeRegister, feeFor, initialState, logFile, logHash } from '@nns/core'

import { LAUNCH_HEIGHT, SELLER, send, stageLog, testConfig } from './test-fixtures.js'
import { fetchLog, splitLogFile, type Fetcher } from './source.js'

// A real staged line rather than a hand-typed one: the transport layer treats
// a line as opaque, and a fixture that is not actually a §8.2 line would be a
// misleading thing to leave lying around for the next reader.
const config = testConfig()
const LINES = stageLog(
  [
    send(
      LAUNCH_HEIGHT + 10,
      0,
      SELLER,
      encodeRegister({ name: 'alicename', fee: feeFor('alicename', initialState().prices) }),
    ),
  ],
  config,
).lines

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

const HASH = hex(logHash(LINES))
const HEIGHT = LAUNCH_HEIGHT + 720

interface StubOptions {
  readonly bytes?: Uint8Array
  readonly logHashHeader?: string | null
  readonly heightHeader?: string | null
  readonly checkpoint?: unknown
  readonly checkpointStatus?: number
}

/** A two-route stub: `/log` serves bytes and headers, `/checkpoints/N` JSON. */
function stub(options: StubOptions = {}): Fetcher {
  const bytes = options.bytes ?? logFile(LINES)
  const headers = new Map<string, string>()
  const logHashHeader = options.logHashHeader === undefined ? `0x${HASH}` : options.logHashHeader
  const heightHeader = options.heightHeader === undefined ? String(HEIGHT) : options.heightHeader
  if (logHashHeader !== null) headers.set('x-nns-log-hash', logHashHeader)
  if (heightHeader !== null) headers.set('x-nns-checkpoint-height', heightHeader)

  return (url: string) => {
    if (url.endsWith('/log')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (name: string) => headers.get(name) ?? null },
        arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
        text: () => Promise.resolve(''),
      })
    }
    const body = options.checkpoint ?? { checkpoint: { height: HEIGHT, logHash: `0x${HASH}` }, height: HEIGHT }
    const status = options.checkpointStatus ?? 200
    return Promise.resolve({
      ok: status < 400,
      status,
      headers: { get: () => null },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      text: () => Promise.resolve(JSON.stringify(body)),
    })
  }
}

describe('splitLogFile', () => {
  it('drops the terminator of every line, including the last', () => {
    expect(splitLogFile(logFile(LINES))).toEqual(LINES)
  })

  it('an empty file is an empty log, not an empty line', () => {
    expect(splitLogFile(new Uint8Array(0))).toEqual([])
  })

  it('refuses an unterminated final line — a truncated download hashes cleanly otherwise', () => {
    const truncated = logFile(LINES).slice(0, -1)
    expect(() => splitLogFile(truncated)).toThrow(/does not end with a newline/)
  })
})

describe('fetchLog', () => {
  it('returns the lines, the height and the hash it verified', async () => {
    const snapshot = await fetchLog('http://api.test', stub())
    expect(snapshot.lines).toEqual(LINES)
    expect(snapshot.checkpointHeight).toBe(HEIGHT)
    expect(snapshot.logHash).toBe(HASH)
    expect(snapshot.boundToCheckpoint).toBe(true)
  })

  it('tolerates a trailing slash on the base URL', async () => {
    const snapshot = await fetchLog('http://api.test/', stub())
    expect(snapshot.lines).toEqual(LINES)
  })

  it('refuses a log that does not hash to the hash served with it', async () => {
    await expect(fetchLog('http://api.test', stub({ logHashHeader: `0x${'11'.repeat(32)}` }))).rejects.toThrow(
      /does not hash to the hash served with it/,
    )
  })

  it('refuses a log the checkpoint does not commit', async () => {
    const other = { checkpoint: { height: HEIGHT, logHash: `0x${'22'.repeat(32)}` }, height: HEIGHT }
    await expect(fetchLog('http://api.test', stub({ checkpoint: other }))).rejects.toThrow(
      /not the log this checkpoint committed/,
    )
  })

  it('refuses a checkpoint answered for a different height than the stamp', async () => {
    const wrong = { checkpoint: { height: HEIGHT + 720, logHash: `0x${HASH}` }, height: HEIGHT }
    await expect(fetchLog('http://api.test', stub({ checkpoint: wrong }))).rejects.toThrow(
      /contradicted its own stamp/,
    )
  })

  it('surfaces a checkpoint the server does not retain rather than proceeding unbound', async () => {
    await expect(
      fetchLog('http://api.test', stub({ checkpoint: { error: 'CHECKPOINT_NOT_RETAINED' }, checkpointStatus: 410 })),
    ).rejects.toThrow(/returned 410/)
  })

  it('skips the binding only when asked, and says it did', async () => {
    const snapshot = await fetchLog(
      'http://api.test',
      stub({ checkpointStatus: 410, checkpoint: { error: 'CHECKPOINT_NOT_RETAINED' } }),
      false,
    )
    expect(snapshot.boundToCheckpoint).toBe(false)
    expect(snapshot.logHash).toBe(HASH)
  })

  it('refuses a response missing either header', async () => {
    await expect(fetchLog('http://api.test', stub({ logHashHeader: null }))).rejects.toThrow(/no x-nns-log-hash/)
    await expect(fetchLog('http://api.test', stub({ heightHeader: null }))).rejects.toThrow(
      /no x-nns-checkpoint-height/,
    )
  })

  it('refuses a hash that is not a 32-byte digest', async () => {
    await expect(fetchLog('http://api.test', stub({ logHashHeader: '0xdeadbeef' }))).rejects.toThrow(
      /not a 32-byte hex digest/,
    )
  })

  it('refuses a log that is not in canonical form', async () => {
    // A blank line in the middle: it survives a naive split and reassembles to
    // different bytes, which is exactly what the canonical-form check is for.
    const bytes = new TextEncoder().encode(`${LINES[0] ?? ''}\n\n`)
    await expect(fetchLog('http://api.test', stub({ bytes }))).rejects.toThrow(/canonical form|hash/)
  })

  it('names the endpoint when it cannot be reached', async () => {
    // A bare `TypeError: fetch failed` names neither the URL nor the attempt;
    // the first live run produced exactly that and nothing else.
    const dead: Fetcher = () => Promise.reject(new TypeError('fetch failed'))
    await expect(fetchLog('http://api.test', dead)).rejects.toThrow(
      /GET http:\/\/api\.test\/log could not be reached/,
    )
  })

  it('an empty log verifies — the launch case', async () => {
    const empty: string[] = []
    const emptyHash = hex(logHash(empty))
    const fetcher = stub({
      bytes: logFile(empty),
      logHashHeader: `0x${emptyHash}`,
      checkpoint: { checkpoint: { height: HEIGHT, logHash: `0x${emptyHash}` }, height: HEIGHT },
    })
    const snapshot = await fetchLog('http://api.test', fetcher)
    expect(snapshot.lines).toEqual([])
    expect(snapshot.logHash).toBe(emptyHash)
  })
})
