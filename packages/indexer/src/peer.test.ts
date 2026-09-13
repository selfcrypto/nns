/**
 * The peer reader's three §8.2 checks, and the one thing they do not prove.
 *
 * Pure: a stub `Fetcher` stands in for the network, and the log is a real
 * staged line rather than a hand-typed one — the transport treats a line as
 * opaque, and a fixture that is not actually a §8.2 line would be a misleading
 * thing to leave lying around for the next reader.
 */

import { encodeRegister, feeFor, initialState, logFile, logHash } from '@nimiqnames/core'
import { describe, expect, it } from 'vitest'

import { fetchPeerSnapshot, PeerError, type Fetcher } from './peer.js'
import { LAUNCH_HEIGHT, SELLER, send, stageLog, testConfig } from './test-fixtures.js'

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

const CHECKPOINT = {
  height: HEIGHT,
  layout: 5,
  nameRoot: `0x${'11'.repeat(32)}`,
  pricesRoot: `0x${'22'.repeat(32)}`,
  pendingRoot: `0x${'33'.repeat(32)}`,
  unreservedRoot: `0x${'44'.repeat(32)}`,
  logHash: `0x${HASH}`,
  commitment: `0x${'55'.repeat(32)}`,
}

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
        arrayBuffer: () =>
          Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
        text: () => Promise.resolve(''),
      })
    }
    const status = options.checkpointStatus ?? 200
    const body = options.checkpoint ?? { checkpoint: CHECKPOINT }
    return Promise.resolve({
      ok: status < 400,
      status,
      headers: { get: () => null },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      text: () => Promise.resolve(JSON.stringify(body)),
    })
  }
}

describe('fetchPeerSnapshot', () => {
  it('returns the lines, the hash and all six checkpoint components', async () => {
    const snapshot = await fetchPeerSnapshot('http://api.test', stub())
    expect(snapshot.lines).toEqual(LINES)
    expect(snapshot.logHash).toBe(HASH)
    expect(snapshot.checkpoint).toMatchObject({
      height: HEIGHT,
      layout: 5,
      nameRoot: '11'.repeat(32),
      unreservedRoot: '44'.repeat(32),
      commitment: '55'.repeat(32),
    })
  })

  it('tolerates a trailing slash on the base URL', async () => {
    await expect(fetchPeerSnapshot('http://api.test/', stub())).resolves.toBeDefined()
  })

  it('refuses a file that is not in §8.2 canonical form', async () => {
    // Two terminators: it splits into an empty line that reassembly keeps, so
    // the bytes differ and every hash over them means something else.
    const doubled = new Uint8Array([...logFile(LINES), 0x0a])
    await expect(fetchPeerSnapshot('http://api.test', stub({ bytes: doubled, logHashHeader: null }))).rejects.toThrow(
      PeerError,
    )
  })

  it('refuses a truncated download rather than hashing it cleanly', async () => {
    await expect(
      fetchPeerSnapshot('http://api.test', stub({ bytes: logFile(LINES).slice(0, -1) })),
    ).rejects.toThrow(/does not end with a newline/)
  })

  it('refuses bytes that do not hash to the hash served with them', async () => {
    await expect(
      fetchPeerSnapshot('http://api.test', stub({ logHashHeader: `0x${'99'.repeat(32)}` })),
    ).rejects.toThrow(/does not hash to the hash served with it/)
  })

  it('demands both §8.2 headers by name', async () => {
    await expect(fetchPeerSnapshot('http://api.test', stub({ logHashHeader: null }))).rejects.toThrow(
      /x-nns-log-hash/,
    )
    await expect(fetchPeerSnapshot('http://api.test', stub({ heightHeader: null }))).rejects.toThrow(
      /x-nns-checkpoint-height/,
    )
  })

  it('refuses a checkpoint that commits a different log', async () => {
    const other = { checkpoint: { ...CHECKPOINT, logHash: `0x${'22'.repeat(32)}` } }
    await expect(fetchPeerSnapshot('http://api.test', stub({ checkpoint: other }))).rejects.toThrow(
      /not the log this checkpoint committed/,
    )
  })

  it('refuses a server that answers for a height it was not asked about', async () => {
    const wrong = { checkpoint: { ...CHECKPOINT, height: HEIGHT + 720 } }
    await expect(fetchPeerSnapshot('http://api.test', stub({ checkpoint: wrong }))).rejects.toThrow(
      /contradicted its own stamp/,
    )
  })

  it('demands every component, so a partial answer is not silently a null root', async () => {
    for (const field of ['nameRoot', 'pricesRoot', 'pendingRoot', 'logHash', 'commitment']) {
      const partial = { checkpoint: { ...CHECKPOINT, [field]: undefined } }
      await expect(fetchPeerSnapshot('http://api.test', stub({ checkpoint: partial }))).rejects.toThrow(
        new RegExp(`checkpoint\\.${field}`),
      )
    }
  })

  it('accepts a null unreservedRoot — a layout-1 row predates the component', async () => {
    const layout1 = { checkpoint: { ...CHECKPOINT, layout: 1, unreservedRoot: null } }
    const snapshot = await fetchPeerSnapshot('http://api.test', stub({ checkpoint: layout1 }))
    expect(snapshot.checkpoint.unreservedRoot).toBeNull()
    // Reported, never reconciled: whether layout 1 is usable is the caller's
    // decision, and `bootstrap.ts` refuses it.
    expect(snapshot.checkpoint.layout).toBe(1)
  })

  it('names the endpoint when the checkpoint lookup fails', async () => {
    await expect(
      fetchPeerSnapshot(
        'http://api.test',
        stub({ checkpointStatus: 410, checkpoint: { error: 'CHECKPOINT_NOT_RETAINED' } }),
      ),
    ).rejects.toThrow(/checkpoints\/\d+ returned 410/)
  })
})
