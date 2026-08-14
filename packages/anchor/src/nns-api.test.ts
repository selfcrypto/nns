import { describe, expect, it } from 'vitest'
import { createNnsApi, NnsApiError } from './nns-api.js'

const HEIGHT = 58_204_800
const HASH = `0x${'ab'.repeat(32)}`
const COMMITMENT = `0x${'cd'.repeat(32)}`

/** A fetch that answers from a table and records what was asked. */
function fakeFetch(routes: Record<string, Response>): { fetch: typeof fetch; asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      asked.push(url)
      const path = new URL(url).pathname
      const response = routes[path]
      if (response === undefined) throw new Error(`unexpected fetch of ${url}`)
      return response
    }) as typeof fetch,
  }
}

const logResponse = (headers: Record<string, string>) =>
  new Response('58204083 0 aa bb cc 1 4e4e5331 OK\n', { status: 200, headers })

describe('createNnsApi', () => {
  it('reads the log bytes and the pairing stamp off /log', async () => {
    const { fetch } = fakeFetch({
      '/log': logResponse({ 'x-nns-checkpoint-height': String(HEIGHT), 'x-nns-log-hash': HASH }),
    })
    const snapshot = await createNnsApi('http://api.example/', fetch).fetchLog()
    expect(snapshot.checkpointHeight).toBe(HEIGHT)
    expect(snapshot.logHash).toBe(HASH)
    expect(new TextDecoder().decode(snapshot.bytes)).toBe('58204083 0 aa bb cc 1 4e4e5331 OK\n')
  })

  it('refuses a /log response without the pairing headers', async () => {
    const { fetch } = fakeFetch({ '/log': logResponse({}) })
    await expect(createNnsApi('http://api.example', fetch).fetchLog()).rejects.toThrow(NnsApiError)
  })

  it('maps the four checkpoint answers to four distinct instructions', async () => {
    const api = (body: unknown, status: number) =>
      createNnsApi(
        'http://api.example',
        fakeFetch({ [`/checkpoints/${HEIGHT}`]: Response.json(body, { status }) }).fetch,
      )

    await expect(
      api({ checkpoint: { height: HEIGHT, commitment: COMMITMENT, logHash: HASH } }, 200).fetchCheckpoint(HEIGHT),
    ).resolves.toEqual({ kind: 'ok', checkpoint: { height: HEIGHT, commitment: COMMITMENT, logHash: HASH } })

    await expect(
      api({ error: 'CHECKPOINT_PENDING', latest: HEIGHT - 720 }, 404).fetchCheckpoint(HEIGHT),
    ).resolves.toEqual({ kind: 'pending', latest: HEIGHT - 720 })

    await expect(
      api({ error: 'CHECKPOINT_NOT_RETAINED', oldest: HEIGHT + 720 }, 410).fetchCheckpoint(HEIGHT),
    ).resolves.toEqual({ kind: 'notRetained', oldest: HEIGHT + 720 })

    await expect(api({ error: 'CHECKPOINT_MISSING' }, 404).fetchCheckpoint(HEIGHT)).resolves.toEqual({
      kind: 'missing',
    })
  })

  it('treats a 400 as a bug, not an operational state', async () => {
    // The height queried is the API's own /log stamp, so
    // NOT_A_CHECKPOINT_HEIGHT can only mean broken software on one side.
    const { fetch } = fakeFetch({
      [`/checkpoints/${HEIGHT}`]: Response.json({ error: 'NOT_A_CHECKPOINT_HEIGHT' }, { status: 400 }),
    })
    await expect(createNnsApi('http://api.example', fetch).fetchCheckpoint(HEIGHT)).rejects.toThrow(/bug/)
  })

  it('refuses a 200 whose checkpoint is for a different height', async () => {
    const { fetch } = fakeFetch({
      [`/checkpoints/${HEIGHT}`]: Response.json(
        { checkpoint: { height: HEIGHT - 720, commitment: COMMITMENT, logHash: HASH } },
        { status: 200 },
      ),
    })
    await expect(createNnsApi('http://api.example', fetch).fetchCheckpoint(HEIGHT)).rejects.toThrow(NnsApiError)
  })

  it('refuses a malformed commitment rather than anchoring it', async () => {
    const { fetch } = fakeFetch({
      [`/checkpoints/${HEIGHT}`]: Response.json(
        { checkpoint: { height: HEIGHT, commitment: '0xshort', logHash: HASH } },
        { status: 200 },
      ),
    })
    await expect(createNnsApi('http://api.example', fetch).fetchCheckpoint(HEIGHT)).rejects.toThrow(/commitment/)
  })
})
