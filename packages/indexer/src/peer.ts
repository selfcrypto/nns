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

/**
 * A log to bootstrap from, and the §8.1 commitment it must reproduce.
 *
 * Two sources produce one of these and `bootstrap.ts` cannot tell them apart
 * except by what they carry:
 *
 * - **`peer-checkpoint`** — another operator's `/log`, bound to that
 *   operator's own checkpoint. All six components come back, so a mismatch
 *   names which one.
 * - **`anchor`** — the log snapshot at the CID a §9 `Anchored` event points
 *   at, with the commitment that event carries. Stronger provenance: the
 *   expected value comes from a contract, cross-checked across publishers and
 *   RPC endpoints, rather than from the party serving the bytes. Weaker
 *   diagnostics: the event carries the commitment and nothing else, so
 *   `components` is `null` and a mismatch can only say *that* the six
 *   disagree.
 */
export interface LogSource {
  /** Canonical §8.2 lines, in order, without their `\n` terminators. */
  readonly lines: readonly string[]
  /** The checkpoint height these lines are served through. */
  readonly height: number
  /** The §8.1 commitment expected at that height. Bare lowercase hex. */
  readonly commitment: string
  /** All six components when the source carries them; `null` when it does not. */
  readonly components: PeerCheckpoint | null
  /** What is recorded in `verification.bootstrap_source` and logged. */
  readonly origin: string
  readonly evidence: 'peer-checkpoint' | 'anchor'
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
 * Bytes → §8.2 lines, refusing anything that is not the canonical file.
 *
 * `core.splitLogFile` rejects an unterminated final line; reassembling through
 * `core.logFile` and comparing catches everything else a hand-edited or
 * re-encoded file could carry. Both are `core`'s, because where the lines of a
 * log are is what §8.2 commits to.
 */
function canonicalLines(served: Uint8Array, url: string): readonly string[] {
  const lines = splitLogFile(served)
  if (!bytesEqual(logFile(lines), served)) {
    throw new PeerError(
      `${url} is not in §8.2 canonical form — reassembling its lines does not reproduce the bytes served`,
    )
  }
  return lines
}

/**
 * A log snapshot from a plain URL, with no NNS headers to read.
 *
 * The IPFS-gateway case: the bytes are all there is, and **nothing here
 * verifies them**. `anchored.ts` explains why that is correct rather than
 * sloppy — the anchored §8.1 commitment is the check, and it covers every byte
 * through the log hash it contains.
 */
export async function fetchLogBytes(url: string, fetcher: Fetcher): Promise<readonly string[]> {
  const response = await get(fetcher, url)
  if (!response.ok) {
    throw new PeerError(`GET ${url} returned ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }
  return canonicalLines(new Uint8Array(await response.arrayBuffer()), url)
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
  const lines = canonicalLines(served, url)

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

/**
 * {@link fetchPeerSnapshot} as a {@link LogSource}.
 *
 * The §8.1 layout is not checked here and deliberately so: whether a layout
 * this build cannot reproduce is usable is the caller's decision, and
 * `bootstrap.ts` refuses it with a message about commitment functions rather
 * than about HTTP.
 */
export async function peerSource(baseUrl: string, fetcher: Fetcher): Promise<LogSource> {
  const snapshot = await fetchPeerSnapshot(baseUrl, fetcher)
  return Object.freeze({
    lines: snapshot.lines,
    height: snapshot.checkpoint.height,
    commitment: snapshot.checkpoint.commitment,
    components: snapshot.checkpoint,
    origin: baseUrl.replace(/\/+$/, ''),
    evidence: 'peer-checkpoint' as const,
  })
}
