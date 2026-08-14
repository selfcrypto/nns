/**
 * The EVM surface this package needs, as a structural interface.
 *
 * Same idiom as `packages/indexer`'s `ScanRpc`: the interface *is* the
 * complete list of what deploying costs, and it is what the tests drive. The
 * viem-backed implementation lives in `viem-rpc.ts` and nothing else imports
 * viem, so the library sits at one edge and the deploy logic is exercised
 * against a fake rather than a chain.
 */

/** A 20-byte EVM address, `0x`-prefixed lowercase hex. */
export type EvmAddress = `0x${string}`
/** `0x`-prefixed lowercase hex, arbitrary length. */
export type Hex = `0x${string}`

/** EIP-1559 fee parameters for one transaction. */
export interface FeeEstimate {
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
}

/** The receipt fields this package acts on. Everything else is ignored. */
export interface DeployReceipt {
  readonly transactionHash: Hex
  readonly blockNumber: bigint
  /** `null` when the transaction was not a contract creation. */
  readonly contractAddress: EvmAddress | null
  readonly status: 'success' | 'reverted'
  readonly gasUsed: bigint
}

/**
 * Reads and one write. Deliberately eight methods: every one of them is
 * something the deploy path genuinely needs, and a ninth should have to
 * justify itself.
 */
export interface DeployRpc {
  /** The chain the endpoint is actually on — checked, never assumed. */
  chainId(): Promise<number>
  getBalance(address: EvmAddress): Promise<bigint>
  /** Pending nonce: the nonce the next transaction from `address` will use. */
  getTransactionCount(address: EvmAddress): Promise<number>
  estimateGas(params: { from: EvmAddress; data: Hex }): Promise<bigint>
  estimateFees(): Promise<FeeEstimate>
  sendRawTransaction(signed: Hex): Promise<Hex>
  waitForReceipt(hash: Hex): Promise<DeployReceipt>
  /** `0x` when nothing is deployed at the address. */
  getCode(address: EvmAddress): Promise<Hex>
}

/** What a deploy transaction needs signed. No `to`: this is a creation. */
export interface DeployTransaction {
  readonly chainId: number
  readonly nonce: number
  readonly gas: bigint
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
  readonly data: Hex
}

/**
 * Holds the deploy key. Kept separate from {@link DeployRpc} so that the
 * only object in this package that has ever seen a private key is the one
 * built from the environment at the last possible moment — and so that every
 * test in this package runs against a signer that has no key at all.
 */
export interface Signer {
  readonly address: EvmAddress
  signTransaction(tx: DeployTransaction): Promise<Hex>
}
