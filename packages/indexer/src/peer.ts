/**
 * Reading another operator's §8.2 log and §8.1 checkpoint over HTTP, for
 * `bootstrap.ts`.
 *
 * ## Why this is not `@nns/settlement`'s `source.ts`
 *
 * That module does something that looks the same and is not the same, and the
 * two are kept apart on purpose. `@nns/settlement`'s reconciler audits what an
 * indexer produced; `import-graph.test.ts` asserts as a reachability property
 * that it imports **no** `@nns/indexer` and touches no database, because a
 * reconciler that shares the indexer's code shares the indexer's mistakes and
 * "two implementations agree" stops meaning anything. Moving the fetch into
 * this package to share it would have deleted that property — quietly, since
 * the reconciler would still have worked.
 *
 * So the HTTP is written twice and the **bytes are not**. Where the lines of a
 * log are, and what hashes over them, is consensus material: `core` owns
 * `splitLogFile`, `logFile` and `logHash`, and both readers call them. What is
 * duplicated is a `fetch`, two header reads and a JSON shape — and the two
 * genuinely differ, since a reconciler needs the log hash alone while a
 * bootstrap needs all six components to compare against its own replay.
 */

import { logFile, logHash, splitLogFile } from '@nns/core'

export class PeerError extends Error {
  override readonly name = 'PeerError'
}

/** The subset of `fetch` this module uses, so a test needs no network. */
export type Fetcher = (url: string) => Promise<{
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}>

/**
 * One stored §8.1 checkpoint, as another operator serves it.
 *
 * All six digests, not just the commitment: a caller that has replayed a log
 * into state can compare component by component, and a mismatch then says
 * *which* of the six disagrees. Comparing the commitment alone says only that
 * something does, which on a disagreement between two implementations is the
 * least useful half of the answer.
 */
export interface PeerCheckpoint {
  readonly height: number
  readonly layout: number
  /** Bare lowercase hex, no `0x` — the §8.2 field convention. */
  readonly nameRoot: string
  readonly pricesRoot: string
  readonly pendingRoot: string
  readonly unreservedRoot: string | null
  readonly logHash: string
  readonly commitment: string
}

/** A peer's log, verified, together with the checkpoint it is served through. */
export interface PeerSnapshot {
  /** Canonical §8.2 lines, in order, without their `\n` terminators. */
  readonly lines: readonly string[]
  /** Bare lowercase hex — what those lines hash to. */
  readonly logHash: string
  readonly checkpoint: PeerCheckpoint
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/** Strip an optional `0x`, lowercase, and require 32 bytes of hex. */
function digest(value: string, field: string): string {
  const bare = (value.startsWith('0x') ? value.slice(2) : value).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(bare)) {
    throw new PeerError(`${field} is not a 32-byte hex digest: ${JSON.stringify(value)}`)
  }
  return bare
}

/**
 * `fetch` rejects with a bare `TypeError: fetch failed` — no URL, no cause on
 * the surface. Naming the endpoint is the difference between a report an
 * operator can act on and one they have to guess at.
 */
async function get(fetcher: Fetcher, url: string): Promise<Awaited<ReturnType<Fetcher>>> {
  try {
    return await fetcher(url)
  } catch (cause) {
    const detail =
      cause instanceof Error ? (cause.cause instanceof Error ? cause.cause.message : cause.message) : String(cause)
    throw new PeerError(`GET ${url} could not be reached: ${detail}`)
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * `GET /checkpoints/{height}`, with the server's own stamp checked against the
 * height that was asked for.
 *
 * @throws {PeerError} on any non-200, on a malformed digest, or when the server
 *   answers for a different height than the one requested — which is the server
 *   contradicting itself, not a lookup miss.
 */
export async function fetchPeerCheckpoint(
  baseUrl: string,
  height: number,
  fetcher: Fetcher,
): Promise<PeerCheckpoint> {
  const path = `/checkpoints/${height}`
  const url = `${baseUrl.replace(/\/+$/, '')}${path}`
  const response = await get(fetcher, url)
  const body = await response.text()
  if (!response.ok) throw new PeerError(`GET ${url} returned ${response.status}: ${body.slice(0, 200)}`)

  let document: unknown
  try {
    document = JSON.parse(body) as unknown
  } catch {
    throw new PeerError(`GET ${url} did not return JSON`)
  }
  const checkpoint = (document as { checkpoint?: Record<string, unknown> }).checkpoint
  if (checkpoint === undefined) throw new PeerError(`${path} carried no checkpoint`)
  if (checkpoint['height'] !== height) {
    throw new PeerError(
      `${path} answered for height ${String(checkpoint['height'])} — the server contradicted its own stamp`,
    )
  }
  const layout = checkpoint['layout']
  if (typeof layout !== 'number' || !Number.isInteger(layout)) {
    throw new PeerError(`${path} carried no checkpoint.layout`)
  }
  const field = (name: string): string => {
    const value = checkpoint[name]
    if (typeof value !== 'string') throw new PeerError(`${path} carried no checkpoint.${name}`)
    return digest(value, `${path} checkpoint.${name}`)
  }
  const unreserved = checkpoint['unreservedRoot']
  return Object.freeze({
    height,
    layout,
    nameRoot: field('nameRoot'),
    pricesRoot: field('pricesRoot'),
    pendingRoot: field('pendingRoot'),
    unreservedRoot: unreserved === null || unreserved === undefined ? null : field('unreservedRoot'),
    logHash: field('logHash'),
    commitment: field('commitment'),
  })
}

/**
 * Fetch a peer's log and the checkpoint it is served through, with every check
 * §8.2 states for a client.
 *
 * 1. **Canonical form.** The served bytes are split into lines and reassembled
 *    by `core.logFile`. If that is not byte-identical, the file is not in §8.2
 *    canonical form and every hash over it is meaningless.
 * 2. **Transport.** `core.logHash` over those lines must equal the
 *    `x-nns-log-hash` header.
 * 3. **Binding.** The checkpoint at `x-nns-checkpoint-height` must commit that
 *    same hash.
 *
 * Check 2 catches corruption, not lying — the same party serves the bytes and
 * the header — which is what 3 is for: the log hash is one of the six
 * components of the §8.1 commitment, and the commitment is what §9 anchors.
 * Even so, all three together prove only that this log is what this operator
 * committed to. Whether that commitment is *right* is the caller's problem, and
 * `bootstrap.ts` answers it by replaying the log and deriving the commitment
 * itself.
 */
export async function fetchPeerSnapshot(baseUrl: string, fetcher: Fetcher): Promise<PeerSnapshot> {
  const url = `${baseUrl.replace(/\/+$/, '')}/log`
  const response = await get(fetcher, url)
  if (!response.ok) {
    throw new PeerError(`GET ${url} returned ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }

  const served = new Uint8Array(await response.arrayBuffer())
  const lines = splitLogFile(served)
  if (!bytesEqual(logFile(lines), served)) {
    throw new PeerError('served log is not in §8.2 canonical form — reassembling its lines does not reproduce it')
  }

  const headerHash = response.headers.get('x-nns-log-hash')
  if (headerHash === null) throw new PeerError(`GET ${url} carried no x-nns-log-hash header`)
  const committed = digest(headerHash, 'x-nns-log-hash')
  const computed = hex(logHash(lines))
  if (computed !== committed) {
    throw new PeerError(
      `served log does not hash to the hash served with it: keccak256 is ${computed}, x-nns-log-hash says ${committed}`,
    )
  }

  const headerHeight = response.headers.get('x-nns-checkpoint-height')
  if (headerHeight === null) throw new PeerError(`GET ${url} carried no x-nns-checkpoint-height header`)
  const height = Number(headerHeight)
  if (!Number.isInteger(height) || height < 0) {
    throw new PeerError(`x-nns-checkpoint-height is not a height: ${JSON.stringify(headerHeight)}`)
  }

  const checkpoint = await fetchPeerCheckpoint(baseUrl, height, fetcher)
  if (checkpoint.logHash !== computed) {
    throw new PeerError(
      `the served log is not the log this checkpoint committed: log hashes to ${computed}, ` +
        `checkpoint ${height} commits ${checkpoint.logHash}`,
    )
  }
  return Object.freeze({ lines, logHash: computed, checkpoint })
}

/** `globalThis.fetch`, narrowed to {@link Fetcher}. */
export const httpFetcher: Fetcher = (url) => fetch(url)
