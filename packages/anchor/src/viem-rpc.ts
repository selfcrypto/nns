/**
 * The viem edge. **The only module in this package that imports viem**, and
 * the only one that ever holds a private key.
 *
 * Reads would be a dozen lines of `fetch` and were nearly written that way.
 * Signing is the part that is not worth hand-rolling: secp256k1 with the
 * right recovery parameter, RLP, and the EIP-1559 typed envelope, under a key
 * that holds real funds, where a subtle bug produces a transaction the node
 * rejects — or worse, one it does not. Keeping the library behind
 * {@link DeployRpc} and {@link Signer} means the deploy logic is tested
 * against a fake, and swapping the implementation is one file.
 */

import { createPublicClient, http, serializeTransaction, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type {
  DeployReceipt,
  DeployRpc,
  DeployTransaction,
  EvmAddress,
  EvmLog,
  EvmLogFilter,
  FeeEstimate,
  Hex,
  PublisherRpc,
  Signer,
} from './chain.js'
import { normaliseAddress } from './deploy.js'

export function createRpc(url: string): DeployRpc {
  const client: PublicClient = createPublicClient({ transport: http(url) })

  return {
    async chainId(): Promise<number> {
      return await client.getChainId()
    },
    async getBalance(address: EvmAddress): Promise<bigint> {
      return await client.getBalance({ address })
    },
    async getTransactionCount(address: EvmAddress): Promise<number> {
      // "pending", not "latest": the nonce the next transaction will use.
      return await client.getTransactionCount({ address, blockTag: 'pending' })
    },
    async estimateGas(params: { from: EvmAddress; data: Hex }): Promise<bigint> {
      // No `to` — that is what makes it a contract creation.
      return await client.estimateGas({ account: params.from, data: params.data })
    },
    async estimateFees(): Promise<FeeEstimate> {
      const fees = await client.estimateFeesPerGas()
      if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) {
        throw new Error('endpoint returned no EIP-1559 fee estimate')
      }
      return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
    },
    async sendRawTransaction(signed: Hex): Promise<Hex> {
      return await client.sendRawTransaction({ serializedTransaction: signed })
    },
    async waitForReceipt(hash: Hex): Promise<DeployReceipt> {
      const receipt = await client.waitForTransactionReceipt({ hash })
      return {
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        contractAddress: receipt.contractAddress === null || receipt.contractAddress === undefined
          ? null
          : normaliseAddress(receipt.contractAddress),
        status: receipt.status,
        gasUsed: receipt.gasUsed,
      }
    },
    async getCode(address: EvmAddress): Promise<Hex> {
      const code = await client.getCode({ address })
      return code ?? '0x'
    },
  }
}

/**
 * The publisher's view of the chain: the deploy surface plus `blockNumber`
 * and `getLogs` (a re-run reads its own anchors back before sending), and an
 * `estimateGas` that takes the `to` a call has.
 */
export function createPublisherRpc(url: string): PublisherRpc {
  const client: PublicClient = createPublicClient({ transport: http(url) })
  const base = createRpc(url)

  return {
    chainId: base.chainId,
    getBalance: base.getBalance,
    getTransactionCount: base.getTransactionCount,
    estimateFees: base.estimateFees,
    sendRawTransaction: base.sendRawTransaction,
    waitForReceipt: base.waitForReceipt,
    getCode: base.getCode,
    async estimateGas(params: { from: EvmAddress; to: EvmAddress; data: Hex }): Promise<bigint> {
      return await client.estimateGas({ account: params.from, to: params.to, data: params.data })
    },
    async blockNumber(): Promise<bigint> {
      return await client.getBlockNumber()
    },
    async getLogs(filter: EvmLogFilter): Promise<readonly EvmLog[]> {
      // The raw request form rather than viem's typed `event` parameter: the
      // topics go to the node verbatim (filtered server-side, which is what
      // the indexed fields are for), and the publisher re-checks every
      // decoded field anyway.
      const logs = await client.request({
        method: 'eth_getLogs',
        params: [
          {
            address: filter.address,
            topics: [...filter.topics],
            fromBlock: `0x${filter.fromBlock.toString(16)}`,
            toBlock: filter.toBlock,
          },
        ],
      })
      return logs.map((log) => ({
        address: normaliseAddress(log.address),
        topics: log.topics,
        data: log.data,
        blockNumber: BigInt(log.blockNumber ?? 0),
        transactionHash: (log.transactionHash ?? '0x') as Hex,
      }))
    },
  }
}

/**
 * Builds a signer from a raw private key.
 *
 * The key reaches this function and stops here — it is not stored on the
 * returned object, not logged, and never crosses back into `deploy.ts`, which
 * only sees an address and a signature.
 */
export function createSigner(privateKey: string): Signer {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('NNS_ANCHOR_DEPLOY_KEY must be a 0x-prefixed 32-byte hex private key')
  }
  const account = privateKeyToAccount(privateKey as Hex)

  return {
    address: normaliseAddress(account.address),
    async signTransaction(tx: DeployTransaction): Promise<Hex> {
      // `to` absent is the creation form; the publisher passes the contract
      // address. viem's `serializeTransaction` is only reached through
      // `account.signTransaction`, which fills in the signature; passing type
      // '1559' explicitly rather than letting it be inferred keeps the
      // envelope from changing under a viem upgrade.
      return await account.signTransaction(
        {
          type: 'eip1559',
          chainId: tx.chainId,
          nonce: tx.nonce,
          gas: tx.gas,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          data: tx.data,
          value: 0n,
          ...(tx.to === undefined ? {} : { to: tx.to }),
        },
        { serializer: serializeTransaction },
      )
    },
  }
}
