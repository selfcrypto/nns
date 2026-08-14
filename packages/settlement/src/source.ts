/**
 * Where the reconciler's input comes from, and what makes it trustworthy.
 *
 * `GET /log` serves the exact §8.2 file bytes through a checkpoint, stamping
 * the height in `x-nns-checkpoint-height` and the committed hash in
 * `x-nns-log-hash`. Two checks run on every fetch, and neither is optional:
 *
 * 1. **Canonical form.** The bytes are split into lines and reassembled by
 *    `core.logFile`. If the result is not byte-identical, the file is not in
 *    §8.2 canonical form and every hash over it is meaningless.
 * 2. **Transport.** `core.logHash` over those lines must equal the
 *    `x-nns-log-hash` header — §8.2's own stated client check.
 *
 * Check 2 catches corruption, not lying: the same party serves the bytes and
 * the header. That is why the binding to `/checkpoints/{height}` is here too —
 * the log hash is one of the six components of the §8.1 commitment, and the
 * commitment is what §9 anchors and what §8.5 makes a client agree on. Binding
 * the fetched bytes to the checkpoint at the stamped height is what puts this
 * log on the same evidence as everything else; without it a reconciler audits
 * whatever it was handed.
 *
 * It stops there on purpose. Comparing that commitment against an anchor, or
 * against a second resolver, is §8.5's job and it is already built —
 * `@nns/anchor`'s reader and `@nns/resolver`'s quorum. Reimplementing either
 * here would be a second opinion from the same code.
 */

import { logFile, logHash } from '@nns/core'

export class SourceError extends Error {
  override readonly name = 'SourceError'
}

export interface LogSnapshot {
  /** Canonical §8.2 lines, in order, without their `\n` terminators. */
  readonly lines: readonly string[]
  /** The checkpoint height the server stamped on the response. */
  readonly checkpointHeight: number
  /** Bare lowercase hex, no `0x` — the §8.2 field convention. */
  readonly logHash: string
  /** Whether the log hash was confirmed against the checkpoint at that height. */
  readonly boundToCheckpoint: boolean
}

/** The subset of `fetch` this module uses, so a test needs no network. */
export type Fetcher = (url: string) => Promise<{
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}>

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/** Strip an optional `0x`, lowercase, and require 32 bytes of hex. */
function digest(value: string, field: string): string {
  const bare = (value.startsWith('0x') ? value.slice(2) : value).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(bare)) {
    throw new SourceError(`${field} is not a 32-byte hex digest: ${JSON.stringify(value)}`)
  }
  return bare
}

/**
 * Split the file bytes into §8.2 lines.
 *
 * Every line is terminated, including the last, so a well-formed file ends with
 * exactly one empty trailing element. An unterminated final line is rejected
 * rather than accepted: it hashes differently, and silently tolerating it here
 * would make the transport check pass on a truncated download.
 */
export function splitLogFile(bytes: Uint8Array): readonly string[] {
  if (bytes.length === 0) return []
  if (bytes[bytes.length - 1] !== 0x0a) {
    throw new SourceError('log file does not end with a newline — §8.2 terminates every line, including the last')
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const lines = text.split('\n')
  lines.pop()
  return lines
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * `fetch` rejects with a bare `TypeError: fetch failed` — no URL, no cause on
 * the surface. Naming the endpoint here is the difference between a report an
 * operator can act on and one they have to guess at.
 */
async function get(fetcher: Fetcher, url: string): Promise<Awaited<ReturnType<Fetcher>>> {
  try {
    return await fetcher(url)
  } catch (cause) {
    const detail = cause instanceof Error ? (cause.cause instanceof Error ? cause.cause.message : cause.message) : String(cause)
    throw new SourceError(`GET ${url} could not be reached: ${detail}`)
  }
}

async function getJson(fetcher: Fetcher, url: string): Promise<unknown> {
  const response = await get(fetcher, url)
  if (!response.ok) {
    throw new SourceError(`GET ${url} returned ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }
  try {
    return JSON.parse(await response.text()) as unknown
  } catch {
    throw new SourceError(`GET ${url} did not return JSON`)
  }
}

/**
 * Fetch, verify, and return the log.
 *
 * @param baseUrl the API root, without a trailing slash.
 * @param bindToCheckpoint when false, the `/checkpoints/{height}` request is
 *   skipped and `boundToCheckpoint` comes back false. The only honest reason to
 *   pass it is a server that retains no checkpoint at the stamped height, which
 *   is a real state (`CHECKPOINT_NOT_RETAINED`) and one the caller must be told
 *   about rather than have hidden behind a silent fallback.
 */
export async function fetchLog(
  baseUrl: string,
  fetcher: Fetcher,
  bindToCheckpoint = true,
): Promise<LogSnapshot> {
  const url = `${baseUrl.replace(/\/+$/, '')}/log`
  const response = await get(fetcher, url)
  if (!response.ok) {
    throw new SourceError(`GET ${url} returned ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }

  const served = new Uint8Array(await response.arrayBuffer())
  const lines = splitLogFile(served)

  // Canonical form: core reassembles what it would have hashed.
  if (!bytesEqual(logFile(lines), served)) {
    throw new SourceError('served log is not in §8.2 canonical form — reassembling its lines does not reproduce it')
  }

  const headerHash = response.headers.get('x-nns-log-hash')
  if (headerHash === null) throw new SourceError(`GET ${url} carried no x-nns-log-hash header`)
  const committed = digest(headerHash, 'x-nns-log-hash')
  const computed = hex(logHash(lines))
  if (computed !== committed) {
    throw new SourceError(
      `served log does not hash to the hash served with it: keccak256 is ${computed}, x-nns-log-hash says ${committed}`,
    )
  }

  const headerHeight = response.headers.get('x-nns-checkpoint-height')
  if (headerHeight === null) throw new SourceError(`GET ${url} carried no x-nns-checkpoint-height header`)
  const checkpointHeight = Number(headerHeight)
  if (!Number.isInteger(checkpointHeight) || checkpointHeight < 0) {
    throw new SourceError(`x-nns-checkpoint-height is not a height: ${JSON.stringify(headerHeight)}`)
  }

  if (!bindToCheckpoint) {
    return Object.freeze({ lines, checkpointHeight, logHash: computed, boundToCheckpoint: false })
  }

  const document = await getJson(fetcher, `${baseUrl.replace(/\/+$/, '')}/checkpoints/${checkpointHeight}`)
  const checkpoint = (document as { checkpoint?: { logHash?: unknown; height?: unknown } }).checkpoint
  if (checkpoint === undefined || typeof checkpoint.logHash !== 'string') {
    throw new SourceError(`/checkpoints/${checkpointHeight} carried no checkpoint.logHash`)
  }
  if (checkpoint.height !== checkpointHeight) {
    throw new SourceError(
      `/checkpoints/${checkpointHeight} answered for height ${String(checkpoint.height)} — the server contradicted its own stamp`,
    )
  }
  const anchored = digest(checkpoint.logHash, `/checkpoints/${checkpointHeight} checkpoint.logHash`)
  if (anchored !== computed) {
    throw new SourceError(
      `the served log is not the log this checkpoint committed: log hashes to ${computed}, checkpoint ${checkpointHeight} commits ${anchored}`,
    )
  }

  return Object.freeze({ lines, checkpointHeight, logHash: computed, boundToCheckpoint: true })
}

/** `globalThis.fetch`, narrowed to {@link Fetcher}. */
export const httpFetcher: Fetcher = (url) => fetch(url)
