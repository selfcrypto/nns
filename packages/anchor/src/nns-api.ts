/**
 * The NNS API surface the publisher reads, and its fetch-backed edge.
 *
 * Two calls, in a fixed order that exists to keep the pair matched: `/log`
 * first, which stamps the checkpoint height it served in
 * `x-nns-checkpoint-height`, then `/checkpoints/{height}` at exactly that
 * height. The alternative — fetch latest, fetch log, compare, retry — loses a
 * race at every boundary, and its failure mode is a quietly mismatched
 * anchor. See `packages/api/CLAUDE.md`.
 *
 * The interface is what `publish.ts` runs on and what the tests fake; this
 * module's only other export is the `fetch` implementation of it.
 */

import type { Hex } from './chain.js'

export class NnsApiError extends Error {
  override readonly name = 'NnsApiError'
}

/** The §8.2 file bytes and the pairing stamp `/log` put on them. */
export interface LogSnapshot {
  readonly bytes: Uint8Array
  /** From `x-nns-checkpoint-height` — the height whose checkpoint matches. */
  readonly checkpointHeight: number
  /** From `x-nns-log-hash` — keccak256 of `bytes`, as the server claims it. */
  readonly logHash: Hex
}

/** The checkpoint fields the publisher acts on. `commitment` is anchored verbatim. */
export interface CheckpointDocument {
  readonly height: number
  readonly commitment: Hex
  readonly logHash: Hex
}

/**
 * The four ways `/checkpoints/{height}` answers, kept distinct because they
 * are four different instructions (`packages/api/CLAUDE.md`): `ok` proceeds,
 * `pending` waits for the next run, `notRetained` and `missing` are alerts,
 * and a 400 does not appear here at all — the height came off the API's own
 * `/log` stamp, so a 400 is a bug in this package and the edge throws.
 */
export type CheckpointAnswer =
  | { readonly kind: 'ok'; readonly checkpoint: CheckpointDocument }
  | { readonly kind: 'pending'; readonly latest: number | null }
  | { readonly kind: 'notRetained'; readonly oldest: number | null }
  | { readonly kind: 'missing' }

export interface NnsApi {
  fetchLog(): Promise<LogSnapshot>
  fetchCheckpoint(height: number): Promise<CheckpointAnswer>
}

const hex32 = (value: unknown, field: string): Hex => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new NnsApiError(`API served a malformed ${field}: ${JSON.stringify(value)}`)
  }
  return value as Hex
}

export function createNnsApi(baseUrl: string, fetchImpl: typeof fetch = fetch): NnsApi {
  const base = baseUrl.replace(/\/+$/, '')

  return {
    async fetchLog(): Promise<LogSnapshot> {
      const response = await fetchImpl(`${base}/log`)
      if (!response.ok) {
        throw new NnsApiError(`GET /log answered ${response.status} — no checkpointed log to anchor yet?`)
      }
      const height = response.headers.get('x-nns-checkpoint-height')
      const logHash = response.headers.get('x-nns-log-hash')
      if (height === null || !/^[0-9]+$/.test(height) || logHash === null) {
        throw new NnsApiError('GET /log did not stamp x-nns-checkpoint-height / x-nns-log-hash — not an NNS API?')
      }
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        checkpointHeight: Number(height),
        logHash: hex32(logHash, 'x-nns-log-hash'),
      }
    },

    async fetchCheckpoint(height: number): Promise<CheckpointAnswer> {
      const response = await fetchImpl(`${base}/checkpoints/${height}`)
      const body = (await response.json()) as Record<string, unknown>

      if (response.status === 200) {
        const checkpoint = body['checkpoint'] as Record<string, unknown> | undefined
        if (checkpoint === undefined || checkpoint['height'] !== height) {
          throw new NnsApiError(`GET /checkpoints/${height} answered 200 with a different or absent checkpoint`)
        }
        return {
          kind: 'ok',
          checkpoint: {
            height,
            commitment: hex32(checkpoint['commitment'], 'commitment'),
            logHash: hex32(checkpoint['logHash'], 'logHash'),
          },
        }
      }

      const error = body['error']
      if (response.status === 404 && error === 'CHECKPOINT_PENDING') {
        return { kind: 'pending', latest: typeof body['latest'] === 'number' ? body['latest'] : null }
      }
      if (response.status === 410 && error === 'CHECKPOINT_NOT_RETAINED') {
        return { kind: 'notRetained', oldest: typeof body['oldest'] === 'number' ? body['oldest'] : null }
      }
      if (response.status === 404 && error === 'CHECKPOINT_MISSING') {
        return { kind: 'missing' }
      }
      // 400 lands here on purpose. The height was the API's own `/log` stamp,
      // so NOT_A_CHECKPOINT_HEIGHT (or any other 4xx) means this package or
      // that server is broken — a bug to surface, not a state to handle.
      throw new NnsApiError(
        `GET /checkpoints/${height} answered ${response.status} ${JSON.stringify(error)} for a height ` +
          'the same API stamped on /log — this is a bug, not an operational state',
      )
    },
  }
}
