/**
 * The node client — four methods, which is the whole of what this service
 * asks a node for. Its own implementation rather than `@nns/indexer`'s: the
 * point of this package is that the protocol's code and chat's code do not
 * meet.
 *
 * Two facts from `docs/rpc-reference.md` are load-bearing and easy to get
 * wrong: every result is wrapped as `{data, metadata}` and must be unwrapped,
 * and batch numbers start at the **PoS genesis**, so a batch number may never
 * be derived from a height by arithmetic. `batchOfBlock` asks the node
 * instead, reading the `batch` field a block carries.
 */

export class RpcError extends Error {
  override readonly name = 'RpcError'
  /** True when the node answered and refused — as opposed to a transport failure. */
  readonly answered: boolean

  constructor(message: string, answered: boolean) {
    super(message)
    this.answered = answered
  }
}

export interface RpcTransaction {
  readonly hash: string
  readonly blockNumber: number
  readonly timestamp: number
  readonly from: string
  readonly to: string
  /** Absent on a reward transaction, which is why chat's prefix test takes them. */
  readonly recipientData?: string | undefined
  readonly networkId: number
  readonly executionResult: boolean
}

export interface RpcOptions {
  readonly url: string
  readonly username?: string | undefined
  readonly password?: string | undefined
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

export class RpcClient {
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: RpcOptions) {
    this.url = options.url
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.fetchImpl = options.fetchImpl ?? fetch
    this.headers = { 'content-type': 'application/json', accept: 'application/json' }
    if (options.username !== undefined) {
      const credentials = Buffer.from(`${options.username}:${options.password ?? ''}`).toString('base64')
      this.headers['authorization'] = `Basic ${credentials}`
    }
  }

  private async call<T>(method: string, params: readonly unknown[]): Promise<T> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new RpcError(`${method}: node answered ${response.status}`, response.status < 500)
    const body = (await response.json()) as { result?: { data?: unknown }; error?: { message?: string; data?: string } }
    if (body.error !== undefined) {
      throw new RpcError(`${method}: ${body.error.data ?? body.error.message ?? 'error'}`, true)
    }
    // Every result is wrapped: unwrap or read undefined (rpc-reference §1).
    return body.result?.data as T
  }

  isConsensusEstablished(): Promise<boolean> {
    return this.call<boolean>('isConsensusEstablished', [])
  }

  getBatchNumber(): Promise<number> {
    return this.call<number>('getBatchNumber', [])
  }

  getTransactionsByBatchNumber(batch: number): Promise<readonly RpcTransaction[]> {
    return this.call<readonly RpcTransaction[]>('getTransactionsByBatchNumber', [batch])
  }

  /**
   * The batch a block belongs to, read from the block itself.
   *
   * This is also the horizon probe: a block the node no longer holds is an
   * **error** here, while a batch below the horizon answers `[]` exactly like
   * an empty one. Asking about the start height is therefore the one call
   * that can tell "nothing there" from "nothing kept" — and it is why this
   * service refuses to start rather than indexing a silent gap.
   */
  async batchOfBlock(height: number): Promise<number> {
    const block = await this.call<{ batch?: number }>('getBlockByNumber', [height, false])
    if (block === undefined || typeof block.batch !== 'number') {
      throw new RpcError(`getBlockByNumber(${height}) carried no batch field`, true)
    }
    return block.batch
  }
}
