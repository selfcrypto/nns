/**
 * Nimiq Albatross JSON-RPC client.
 *
 * Two things here are load-bearing, and both fail *silently* if you skip them
 * (`docs/rpc-reference.md` §1):
 *
 * 1. **Every result is wrapped**: `{ "result": { "data": …, "metadata": … } }`.
 *    The payload is `result.data`, never `result`. Reading `result` returns
 *    `undefined` rather than an error, which is how the first probe run
 *    produced a false negative. `unwrap()` below therefore *asserts* the
 *    envelope instead of reaching through it optimistically.
 * 2. **Basic auth**, from the `[rpc-server]` section of the node's
 *    `client.toml`.
 *
 * The client is transport only. It knows nothing about NNS.
 */

import type { LogFields, Logger } from './logger.js'

// ── Errors ──────────────────────────────────────────────────────────────────

/** The node answered, and the answer was a JSON-RPC error object. */
export class RpcError extends Error {
  override readonly name = 'RpcError'
  readonly code: number
  readonly method: string
  readonly data: unknown

  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`${method}: ${message} (code ${code})`)
    this.code = code
    this.method = method
    this.data = data
  }
}

/** The call never produced a usable answer: transport, HTTP, or a broken envelope. */
export class RpcTransportError extends Error {
  override readonly name = 'RpcTransportError'
  /** `false` for failures that repeating cannot fix — bad credentials, a broken envelope. */
  readonly retryable: boolean

  constructor(message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message, options)
    this.retryable = options?.retryable ?? true
  }
}

/** JSON-RPC "method not found" — used for capability detection. */
export const METHOD_NOT_FOUND = -32601
/** JSON-RPC "invalid params" — the method exists, the shape was wrong. */
export const INVALID_PARAMS = -32602

// ── Wire shapes ─────────────────────────────────────────────────────────────

/**
 * `metadata` is populated on state-reading calls (`blockNumber`, `blockHash`)
 * and `null` on chain-position calls. It is a free "as of this block" stamp.
 */
export interface RpcMetadata {
  readonly blockNumber?: number
  readonly blockHash?: string
}

export interface RpcResponse<T> {
  readonly data: T
  readonly metadata: RpcMetadata | null
}

/**
 * A transaction as the node returns it — the fields captured by the probe on
 * 2026-08-06. Note what is *not* here: any index, position or ordering field.
 * None is needed — §5.2's canonical order is `(blockNumber, transaction hash)`
 * since r27, derived from this shape alone via `core.rankMessages`.
 */
export interface RpcTransaction {
  readonly hash: string
  readonly blockNumber: number
  readonly timestamp: number
  readonly confirmations?: number
  readonly size?: number
  readonly relatedAddresses?: readonly string[]
  readonly from: string
  readonly fromType?: number
  readonly to: string
  readonly toType?: number
  readonly value: number
  readonly fee: number
  /** Lowercase hex. The field is NOT called `data`. */
  readonly senderData?: string
  /** Lowercase hex. The field is NOT called `data`. */
  readonly recipientData?: string
  readonly flags?: number
  readonly validityStartHeight?: number
  readonly proof?: string
  readonly networkId: number
  /** Albatross includes failed transactions in blocks. `false` means discard. */
  readonly executionResult: boolean
}

export interface RpcBlock {
  readonly number: number
  readonly hash: string
  /** `"micro"` or `"macro"` **[probe]**. A macro block closes a batch. */
  readonly type?: string
  /**
   * The block's batch number **[probe]**, present even with
   * `includeBody: false`. This is the authoritative block → batch mapping;
   * batch numbers are genesis-relative and must never be derived from a
   * height. See `chain.ts`.
   */
  readonly batch?: number
  readonly epoch?: number
  readonly timestamp?: number
  /** Present only when the block was requested with the body included. */
  readonly transactions?: readonly RpcTransaction[]
}

// ── Client ──────────────────────────────────────────────────────────────────

export interface RpcClientOptions {
  url: string
  username?: string | undefined
  password?: string | undefined
  /** Per-attempt timeout. */
  timeoutMs?: number
  /** Total attempts per call, including the first. */
  attempts?: number
  /** Backoff before attempt n is `retryBaseMs * 2 ** (n - 1)`. */
  retryBaseMs?: number
  logger?: Logger
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
  /** Injectable for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULTS = {
  timeoutMs: 30_000,
  attempts: 4,
  retryBaseMs: 250,
} as const

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Assert the `{ data, metadata }` envelope rather than reaching through it.
 *
 * A node that stopped wrapping — or a proxy that unwrapped for us — must fail
 * here, loudly, at the first call. The alternative is `undefined` flowing into
 * the reducer, which is exactly the class of silent divergence this project
 * exists to prevent.
 */
function unwrap<T>(method: string, result: unknown): RpcResponse<T> {
  if (result === null || typeof result !== 'object') {
    throw new RpcTransportError(`${method}: result is not an object (envelope missing?)`, { retryable: false })
  }
  if (!('data' in result)) {
    throw new RpcTransportError(
      `${method}: result has no "data" key — every Albatross RPC result is wrapped as { data, metadata }`,
      { retryable: false },
    )
  }
  const envelope = result as { data: T; metadata?: unknown }
  const metadata = envelope.metadata
  return {
    data: envelope.data,
    metadata: metadata === null || metadata === undefined ? null : (metadata as RpcMetadata),
  }
}

export class RpcClient {
  readonly url: string
  private readonly authorization: string | undefined
  private readonly timeoutMs: number
  private readonly attempts: number
  private readonly retryBaseMs: number
  private readonly logger: Logger | undefined
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private nextId = 1

  constructor(options: RpcClientOptions) {
    this.url = options.url
    this.authorization =
      options.username === undefined || options.username === ''
        ? undefined
        : 'Basic ' + Buffer.from(`${options.username}:${options.password ?? ''}`).toString('base64')
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs
    this.attempts = options.attempts ?? DEFAULTS.attempts
    this.retryBaseMs = options.retryBaseMs ?? DEFAULTS.retryBaseMs
    this.logger = options.logger
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.sleep = options.sleep ?? defaultSleep
  }

  /** Raw call, envelope included — use when you want the `metadata` stamp. */
  async callWithMetadata<T>(method: string, params: readonly unknown[] = []): Promise<RpcResponse<T>> {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        return await this.attempt<T>(method, params)
      } catch (error) {
        // A JSON-RPC error is the node's considered answer. Retrying it just
        // asks the same wrong question again — and so does a 401.
        if (error instanceof RpcError) throw error
        if (error instanceof RpcTransportError && !error.retryable) throw error
        lastError = error
        if (attempt === this.attempts) break
        const delay = this.retryBaseMs * 2 ** (attempt - 1)
        this.logger?.warn('rpc.retry', {
          method,
          attempt,
          of: this.attempts,
          delayMs: delay,
          error,
        } satisfies LogFields)
        await this.sleep(delay)
      }
    }
    // With one attempt there is nothing to summarise; the original error is
    // both more specific and less noisy than a wrapper around it.
    if (this.attempts === 1 && lastError instanceof Error) throw lastError
    const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
    throw new RpcTransportError(`${method}: failed after ${this.attempts} attempts${detail}`, { cause: lastError })
  }

  /** The usual entry point: the unwrapped `result.data`. */
  async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    const response = await this.callWithMetadata<T>(method, params)
    return response.data
  }

  private async attempt<T>(method: string, params: readonly unknown[]): Promise<RpcResponse<T>> {
    const id = this.nextId++
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.authorization !== undefined) headers['Authorization'] = this.authorization

    let response: Response
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new RpcTransportError(`${method}: request failed`, { cause })
    }

    if (!response.ok) {
      // 401/403 mean the credentials are wrong, not that the node is
      // unhealthy. Retrying burns the backoff and buries the real cause.
      const auth = response.status === 401 || response.status === 403
      const hint = auth ? ' — check NNS_RPC_USER / NNS_RPC_PASSWORD against the node’s client.toml' : ''
      throw new RpcTransportError(`${method}: HTTP ${response.status} ${response.statusText}${hint}`, {
        retryable: !auth,
      })
    }

    let body: unknown
    try {
      body = await response.json()
    } catch (cause) {
      throw new RpcTransportError(`${method}: response was not JSON`, { cause })
    }

    if (body === null || typeof body !== 'object') {
      throw new RpcTransportError(`${method}: response was not a JSON-RPC object`)
    }
    const envelope = body as { error?: { code?: number; message?: string; data?: unknown }; result?: unknown }
    if (envelope.error !== undefined && envelope.error !== null) {
      throw new RpcError(
        method,
        envelope.error.code ?? 0,
        envelope.error.message ?? 'unknown error',
        envelope.error.data,
      )
    }
    return unwrap<T>(method, envelope.result)
  }

  // ── §2 chain position ─────────────────────────────────────────────────────

  /** Gate: never index without consensus. */
  isConsensusEstablished(): Promise<boolean> {
    return this.call<boolean>('isConsensusEstablished')
  }

  getBlockNumber(): Promise<number> {
    return this.call<number>('getBlockNumber')
  }

  getBatchNumber(): Promise<number> {
    return this.call<number>('getBatchNumber')
  }

  getEpochNumber(): Promise<number> {
    return this.call<number>('getEpochNumber')
  }

  // ── §3 reading history ────────────────────────────────────────────────────

  /**
   * The scan loop's entire input surface (spec §7.1). Includes reward
   * transactions, which carry no `NNS1` payload and are dropped by the prefix
   * filter.
   */
  getTransactionsByBatchNumber(batchNumber: number): Promise<readonly RpcTransaction[]> {
    return this.call<readonly RpcTransaction[]>('getTransactionsByBatchNumber', [batchNumber])
  }

  getTransactionByHash(hash: string): Promise<RpcTransaction> {
    return this.call<RpcTransaction>('getTransactionByHash', [hash])
  }

  /**
   * The second parameter is a **bare boolean** **[probe]**. The object form
   * `{ includeBody: true }` is rejected with `-32602`
   * (`invalid type: map, expected a boolean`), so there is nothing to detect.
   */
  getBlockByNumber(blockNumber: number, includeBody: boolean): Promise<RpcBlock> {
    return this.call<RpcBlock>('getBlockByNumber', [blockNumber, includeBody])
  }

  getAccountByAddress(address: string): Promise<RpcResponse<unknown>> {
    return this.callWithMetadata<unknown>('getAccountByAddress', [address])
  }
}
