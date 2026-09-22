/**
 * Everything this service reads, and from where: the resolver API for the
 * log and the registry, the chat index for messages. Public endpoints only,
 * as settlement reads them, so an operator can point this at any resolver
 * and it can never sit on a path that derives a root.
 */

import {
  logHash,
  parseAddress,
  parseLogLine,
  splitLogFile,
  type ChainTransaction,
  type NnsConfig,
} from '@nimiqnames/core'

export class SourceError extends Error {
  override readonly name = 'SourceError'
}

export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}>

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

async function get(fetcher: Fetcher, url: string): Promise<Awaited<ReturnType<Fetcher>>> {
  try {
    return await fetcher(url, { headers: { accept: 'application/json' } })
  } catch (cause) {
    const detail = cause instanceof Error ? (cause.cause instanceof Error ? cause.cause.message : cause.message) : String(cause)
    throw new SourceError(`GET ${url} could not be reached: ${detail}`)
  }
}

async function getJson(fetcher: Fetcher, url: string): Promise<{ status: number; body: unknown }> {
  const response = await get(fetcher, url)
  const text = await response.text()
  let body: unknown = null
  try {
    body = JSON.parse(text) as unknown
  } catch {
    if (response.ok) throw new SourceError(`GET ${url} did not return JSON`)
  }
  return { status: response.status, body }
}

/** `/checkpoints/latest`: the height the log is served through, or null before the first checkpoint. */
export async function fetchLatestCheckpoint(apiUrl: string, fetcher: Fetcher): Promise<number | null> {
  const url = `${apiUrl}/checkpoints/latest`
  const { status, body } = await getJson(fetcher, url)
  if (status === 404) return null
  if (status !== 200) throw new SourceError(`GET ${url} returned ${status}`)
  const height = (body as { checkpoint?: { height?: unknown } })?.checkpoint?.height
  if (typeof height !== 'number' || !Number.isInteger(height)) throw new SourceError(`${url} carried no checkpoint.height`)
  return height
}

export interface LogSnapshot {
  readonly txs: readonly ChainTransaction[]
  readonly checkpointHeight: number
}

/**
 * `/log`, checked against the hash served with it (§8.2's own client check),
 * as transactions the reducer takes. The log carries the effective sender
 * (§7.2), so nothing is re-attributed.
 */
export async function fetchLog(apiUrl: string, config: NnsConfig, fetcher: Fetcher): Promise<LogSnapshot> {
  const url = `${apiUrl}/log`
  const response = await get(fetcher, url)
  if (!response.ok) throw new SourceError(`GET ${url} returned ${response.status}`)
  const lines = splitLogFile(new Uint8Array(await response.arrayBuffer()))
  const served = response.headers.get('x-nns-log-hash')
  if (served === null) throw new SourceError(`GET ${url} carried no x-nns-log-hash header`)
  const computed = hex(logHash(lines))
  if (computed !== served.replace(/^0x/, '').toLowerCase()) {
    throw new SourceError(`served log does not hash to x-nns-log-hash: ${computed} vs ${served}`)
  }
  const stamped = Number(response.headers.get('x-nns-checkpoint-height'))
  if (!Number.isInteger(stamped) || stamped < 0) throw new SourceError(`GET ${url} carried no x-nns-checkpoint-height header`)
  return { txs: lines.map((line) => toChainTransaction(line, config)), checkpointHeight: stamped }
}

function toChainTransaction(line: string, config: NnsConfig): ChainTransaction {
  const fields = parseLogLine(line)
  return {
    blockNumber: fields.blockHeight,
    txIndex: fields.txIndex,
    hash: fields.txHash,
    sender: parseAddress(fields.sender),
    recipient: parseAddress(fields.recipient),
    value: fields.value,
    recipientData: fields.data,
    executionResult: true,
    networkId: config.networkId,
    isReward: false,
  }
}

export interface NameRecord {
  readonly name: string
  readonly owner: string
  readonly target: string
  readonly expiry: number
  readonly status: 'REGISTERED' | 'GRACE'
}

export type NameLookup =
  | { readonly kind: 'registered'; readonly record: NameRecord }
  | { readonly kind: 'reserved' }
  | { readonly kind: 'available' }
  | { readonly kind: 'invalid' }

/** `/name/{name}`, for the bot's resolve command. */
export async function fetchName(apiUrl: string, name: string, fetcher: Fetcher): Promise<NameLookup> {
  const { status, body } = await getJson(fetcher, `${apiUrl}/name/${encodeURIComponent(name)}`)
  if (status === 400) return { kind: 'invalid' }
  if (status === 404) {
    const reserved = (body as { reserved?: unknown })?.reserved
    return reserved === true ? { kind: 'reserved' } : { kind: 'available' }
  }
  if (status !== 200) throw new SourceError(`GET /name/${name} returned ${status}`)
  const record = (body as { record?: unknown; reserved?: unknown })?.record
  if (record === null || record === undefined) {
    return (body as { reserved?: unknown }).reserved === true ? { kind: 'reserved' } : { kind: 'available' }
  }
  const { owner, target, expiry, status: nameStatus } = record as Record<string, unknown>
  if (typeof owner !== 'string' || typeof target !== 'string' || typeof expiry !== 'number') {
    throw new SourceError(`GET /name/${name} carried a malformed record`)
  }
  return {
    kind: 'registered',
    record: { name, owner, target, expiry, status: nameStatus === 'GRACE' ? 'GRACE' : 'REGISTERED' },
  }
}

/** `/address/{address}/names`: what an address holds, for the bot and for naming a chat sender. */
export async function fetchNamesOf(apiUrl: string, address: string, fetcher: Fetcher): Promise<readonly string[]> {
  const { status, body } = await getJson(fetcher, `${apiUrl}/address/${encodeURIComponent(address)}/names`)
  if (status !== 200) return []
  const names = (body as { names?: unknown })?.names
  if (!Array.isArray(names)) return []
  return names.map((row) => (row as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string').sort()
}

export interface ChatRow {
  readonly hash: string
  readonly blockNumber: number
  readonly from: string
  readonly to: string
}

export interface ChatPage {
  readonly rows: readonly ChatRow[]
  /** Where the next page starts, or null when this one was the last. */
  readonly next: number | null
}

/** `GET /messages?since=`: the chat index's forward tail. */
export async function fetchChatSince(chatUrl: string, since: number, fetcher: Fetcher): Promise<ChatPage> {
  const url = `${chatUrl}/messages?since=${since}`
  const { status, body } = await getJson(fetcher, url)
  if (status !== 200) throw new SourceError(`GET ${url} returned ${status}`)
  const messages = (body as { messages?: unknown })?.messages
  if (!Array.isArray(messages)) throw new SourceError(`${url} carried no message array`)
  const rows: ChatRow[] = []
  for (const entry of messages) {
    const { hash, blockNumber, from, to } = (entry ?? {}) as Record<string, unknown>
    if (typeof hash !== 'string' || typeof blockNumber !== 'number' || typeof from !== 'string' || typeof to !== 'string') continue
    rows.push({ hash, blockNumber, from, to })
  }
  const next = (body as { next?: unknown }).next
  return { rows, next: typeof next === 'number' ? next : null }
}
