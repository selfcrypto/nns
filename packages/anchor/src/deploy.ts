/**
 * Deploying `NnsAnchor` — planning, execution, and the check that matters.
 *
 * Pure with respect to the chain: everything here runs against
 * {@link DeployRpc} and {@link Signer}, so the whole path is exercised by the
 * tests against a fake and viem never enters this module.
 *
 * **Plain `CREATE`, not `CREATE2`** (decided 2026-08-14). CREATE2 was
 * justified by deploying to several chains at one address, and §9 now names
 * one chain. What is left of the argument does not survive contact: CREATE2
 * cannot redeploy to the same address on the same chain either — a second
 * deployment needs a new salt and gets a new address, exactly like a new
 * nonce — and a plain deploy's address is just as predictable in advance,
 * which is what {@link predictCreateAddress} is for. The property that
 * actually matters is that anyone can confirm the configured address holds
 * *this* contract, and `ARTIFACT.deployedBytecode` gives that with one
 * `eth_getCode` under either scheme. See {@link verifyDeployedCode}.
 */

import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { ARTIFACT } from './artifact.js'
import type { DeployReceipt, DeployRpc, EvmAddress, FeeEstimate, Hex, Signer } from './chain.js'

export class DeployError extends Error {
  override readonly name = 'DeployError'
}

/**
 * Multiplier on the node's gas estimate, as a percentage. Unused gas is
 * refunded, so the only cost of a buffer is a larger balance requirement;
 * the cost of not having one is a deploy that runs out of gas and burns the
 * fee for nothing.
 */
export const GAS_BUFFER_PERCENT = 125n

// ── Address prediction ──────────────────────────────────────────────────────

function keccak(bytes: Uint8Array): Uint8Array {
  return keccak_256(bytes)
}

/** Minimal RLP for a non-negative integer: the scalar encoding, no leading zeros. */
function rlpUint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new DeployError(`nonce must be a non-negative integer, got ${String(value)}`)
  }
  if (value === 0) return Uint8Array.of(0x80)
  const bytes: number[] = []
  for (let v = value; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256)
  // A single byte below 0x80 encodes as itself.
  if (bytes.length === 1 && bytes[0]! < 0x80) return Uint8Array.from(bytes)
  return Uint8Array.from([0x80 + bytes.length, ...bytes])
}

/**
 * The contract address a plain `CREATE` from `deployer` at `nonce` produces:
 * `keccak256(rlp([deployer, nonce]))[12..32]`.
 *
 * Worth having rather than deploying and reading the receipt, for two
 * reasons. It puts the address in the dry-run output, so the address can be
 * reviewed and written into config before any value moves. And
 * {@link executeDeploy} compares it against the receipt — a mismatch means
 * the nonce moved underneath us, which is a second transaction from the
 * deploy key and something to stop on rather than shrug at.
 */
export function predictCreateAddress(deployer: EvmAddress, nonce: number): EvmAddress {
  const address = hexToBytes(normaliseAddress(deployer).slice(2))
  const noncePart = rlpUint(nonce)
  const payload = Uint8Array.from([0x94, ...address, ...noncePart])
  // 21 + at most 9 bytes: always inside RLP's short-list form, which is the
  // only branch below. Asserted rather than assumed.
  if (payload.length >= 56) throw new DeployError('RLP payload unexpectedly long')
  const encoded = Uint8Array.from([0xc0 + payload.length, ...payload])
  return `0x${bytesToHex(keccak(encoded).slice(12))}`
}

/** Lowercases and checks the shape. This package never emits mixed-case addresses. */
export function normaliseAddress(value: string): EvmAddress {
  const lower = value.toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(lower)) {
    throw new DeployError(`not a 20-byte EVM address: ${JSON.stringify(value)}`)
  }
  return lower as EvmAddress
}

/**
 * A signer that knows an address and cannot sign.
 *
 * What a dry run runs on when only `NNS_ANCHOR_DEPLOY_ADDRESS` is set: the
 * plan needs a nonce, a balance and a predicted address, none of which need a
 * key. Asking it to sign throws rather than returning something unusable, so
 * "planned without the key" can never become "sent without the key".
 */
export function viewOnlySigner(address: string): Signer {
  return {
    address: normaliseAddress(address),
    signTransaction(): Promise<Hex> {
      return Promise.reject(
        new DeployError('no deploy key configured — set NNS_ANCHOR_DEPLOY_KEY to send'),
      )
    },
  }
}

// ── Planning ────────────────────────────────────────────────────────────────

export interface DeployPlan {
  /** What the endpoint reported. Equal to {@link expectedChainId} or we threw. */
  readonly chainId: number
  readonly expectedChainId: number
  readonly deployer: EvmAddress
  readonly nonce: number
  readonly balance: bigint
  /** Node estimate, already multiplied by {@link GAS_BUFFER_PERCENT}. */
  readonly gas: bigint
  readonly fees: FeeEstimate
  /** `gas * maxFeePerGas` — the most this can cost, and what the balance must cover. */
  readonly maxCost: bigint
  readonly predictedAddress: EvmAddress
  readonly bytecode: Hex
  readonly sourceHash: string
  readonly solcVersion: string
  readonly evmVersion: string
}

export interface PlanOptions {
  /**
   * The chain the operator believes they are deploying to. Checked against
   * the endpoint. This is the single most valuable assertion in the file:
   * an RPC URL is one edit away from pointing at the wrong network, and a
   * contract deployed to the wrong chain is a silent success.
   */
  readonly expectedChainId: number
}

export async function planDeploy(rpc: DeployRpc, signer: Signer, options: PlanOptions): Promise<DeployPlan> {
  const chainId = await rpc.chainId()
  if (chainId !== options.expectedChainId) {
    throw new DeployError(
      `endpoint is on chain ${chainId}, expected ${options.expectedChainId} — refusing to deploy. ` +
        'Check NNS_ANCHOR_RPC_URL and NNS_ANCHOR_CHAIN_ID.',
    )
  }

  const deployer = signer.address
  const bytecode = ARTIFACT.bytecode as Hex
  const [nonce, balance, rawGas, fees] = await Promise.all([
    rpc.getTransactionCount(deployer),
    rpc.getBalance(deployer),
    rpc.estimateGas({ from: deployer, data: bytecode }),
    rpc.estimateFees(),
  ])

  const gas = (rawGas * GAS_BUFFER_PERCENT) / 100n
  const maxCost = gas * fees.maxFeePerGas
  if (balance < maxCost) {
    // §11.5's discipline, applied to a chain it was not written for: an
    // underfunded sender is a failure that reports success at the wrong
    // layer. Refuse before signing, not after the node rejects it.
    throw new DeployError(
      `deployer ${deployer} holds ${balance} wei, needs up to ${maxCost} wei ` +
        `(${gas} gas × ${fees.maxFeePerGas} maxFeePerGas). Fund it and retry.`,
    )
  }

  return {
    chainId,
    expectedChainId: options.expectedChainId,
    deployer,
    nonce,
    balance,
    gas,
    fees,
    maxCost,
    predictedAddress: predictCreateAddress(deployer, nonce),
    bytecode,
    sourceHash: ARTIFACT.sourceHash,
    solcVersion: ARTIFACT.solcVersion,
    evmVersion: ARTIFACT.evmVersion,
  }
}

/** Wei as a decimal string with the native-token figure beside it. */
function wei(value: bigint): string {
  const whole = value / 10n ** 18n
  const frac = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 6)
  return `${value} wei (${whole}.${frac})`
}

export function describePlan(plan: DeployPlan): readonly string[] {
  return [
    'deploy NnsAnchor',
    `  chain id          ${plan.chainId} (confirmed against the endpoint)`,
    `  deployer          ${plan.deployer}`,
    `  nonce             ${plan.nonce}`,
    `  balance           ${wei(plan.balance)}`,
    `  gas (buffered)    ${plan.gas}`,
    `  maxFeePerGas      ${plan.fees.maxFeePerGas}`,
    `  maxPriorityFee    ${plan.fees.maxPriorityFeePerGas}`,
    `  max cost          ${wei(plan.maxCost)}`,
    `  predicted address ${plan.predictedAddress}`,
    '  contract',
    `    solc            ${plan.solcVersion}`,
    `    evmVersion      ${plan.evmVersion}`,
    `    sourceHash      ${plan.sourceHash}`,
    `    creation bytes  ${(plan.bytecode.length - 2) / 2}`,
  ]
}

// ── Execution ───────────────────────────────────────────────────────────────

export interface DeployOutcome {
  readonly address: EvmAddress
  readonly transactionHash: Hex
  readonly blockNumber: bigint
  readonly gasUsed: bigint
  /** Always true — {@link executeDeploy} throws otherwise. Kept for the log line. */
  readonly codeVerified: true
}

export async function executeDeploy(rpc: DeployRpc, signer: Signer, plan: DeployPlan): Promise<DeployOutcome> {
  const signed = await signer.signTransaction({
    chainId: plan.chainId,
    nonce: plan.nonce,
    gas: plan.gas,
    maxFeePerGas: plan.fees.maxFeePerGas,
    maxPriorityFeePerGas: plan.fees.maxPriorityFeePerGas,
    data: plan.bytecode,
  })

  const hash = await rpc.sendRawTransaction(signed)
  const receipt = await rpc.waitForReceipt(hash)
  assertReceipt(receipt, plan)

  const address = normaliseAddress(receipt.contractAddress!)
  const verification = await verifyDeployedCode(rpc, address)
  if (!verification.match) throw new DeployError(describeMismatch(address, verification))

  return {
    address,
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    codeVerified: true,
  }
}

function assertReceipt(receipt: DeployReceipt, plan: DeployPlan): void {
  if (receipt.status !== 'success') {
    throw new DeployError(`deploy transaction ${receipt.transactionHash} reverted`)
  }
  if (receipt.contractAddress === null) {
    throw new DeployError(`transaction ${receipt.transactionHash} created no contract`)
  }
  const actual = normaliseAddress(receipt.contractAddress)
  if (actual !== plan.predictedAddress) {
    // The nonce moved between planning and sending, which means something
    // else spent from the deploy key. The contract is deployed either way,
    // but the address that was reviewed is not the address that exists, and
    // that is worth stopping on.
    throw new DeployError(
      `deployed to ${actual} but the plan predicted ${plan.predictedAddress} — ` +
        'the deploy key sent another transaction in between. The contract exists at the ' +
        'first address; verify it before using it.',
    )
  }
}

// ── Verification ────────────────────────────────────────────────────────────

export interface CodeVerification {
  readonly match: boolean
  readonly expected: string
  readonly actual: string
}

/**
 * Does the address hold *this* contract?
 *
 * The whole of what CREATE2 was going to buy, available to anyone with an RPC
 * endpoint and this repository: no salt, no factory, no trust in whoever
 * published the address. Compares the deployed runtime code against the
 * committed artifact, which the test suite independently proves is the
 * compilation of `contracts/NnsAnchor.sol`.
 */
export async function verifyDeployedCode(rpc: Pick<DeployRpc, 'getCode'>, address: EvmAddress): Promise<CodeVerification> {
  const actual = (await rpc.getCode(normaliseAddress(address))).toLowerCase()
  const expected = ARTIFACT.deployedBytecode.toLowerCase()
  return { match: actual === expected, expected, actual }
}

export function describeMismatch(address: EvmAddress, verification: CodeVerification): string {
  if (verification.actual === '0x') {
    return `no contract at ${address} — nothing is deployed there`
  }
  return (
    `code at ${address} is not this contract: ` +
    `${(verification.actual.length - 2) / 2} bytes deployed, ` +
    `${(verification.expected.length - 2) / 2} bytes expected. ` +
    'Either the address is wrong or it holds a different build — see packages/anchor/CLAUDE.md.'
  )
}
