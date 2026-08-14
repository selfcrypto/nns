import { getContractAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { ARTIFACT } from './artifact.js'
import type { DeployReceipt, DeployRpc, DeployTransaction, EvmAddress, Hex, Signer } from './chain.js'
import {
  DeployError,
  describeMismatch,
  describePlan,
  executeDeploy,
  GAS_BUFFER_PERCENT,
  normaliseAddress,
  planDeploy,
  predictCreateAddress,
  verifyDeployedCode,
  viewOnlySigner,
} from './deploy.js'

const DEPLOYER = '0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0' as EvmAddress
const CHAIN_ID = 11155111

// ── Fakes ───────────────────────────────────────────────────────────────────
// The point of DeployRpc being eight methods: the whole deploy path is
// drivable from an object literal, so every branch below is a real execution
// of the real code rather than a mock of it.

interface FakeOptions {
  chainId?: number
  balance?: bigint
  nonce?: number
  gas?: bigint
  receipt?: Partial<DeployReceipt>
  code?: Hex
}

function fakeRpc(options: FakeOptions = {}): DeployRpc & { sent: Hex[] } {
  const sent: Hex[] = []
  const nonce = options.nonce ?? 0
  const predicted = predictCreateAddress(DEPLOYER, nonce)
  return {
    sent,
    chainId: async () => options.chainId ?? CHAIN_ID,
    getBalance: async () => options.balance ?? 10n ** 18n,
    getTransactionCount: async () => nonce,
    estimateGas: async () => options.gas ?? 100_000n,
    estimateFees: async () => ({ maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 25_000_000_000n }),
    sendRawTransaction: async (signed: Hex) => {
      sent.push(signed)
      return '0xfeed' as Hex
    },
    waitForReceipt: async (hash: Hex): Promise<DeployReceipt> => ({
      transactionHash: hash,
      blockNumber: 42n,
      contractAddress: predicted,
      status: 'success',
      gasUsed: 90_000n,
      ...options.receipt,
    }),
    getCode: async () => options.code ?? (ARTIFACT.deployedBytecode as Hex),
  }
}

function fakeSigner(): Signer & { signed: DeployTransaction[] } {
  const signed: DeployTransaction[] = []
  return {
    signed,
    address: DEPLOYER,
    signTransaction: async (tx: DeployTransaction) => {
      signed.push(tx)
      return '0x02deadbeef' as Hex
    },
  }
}

// ── Address prediction ──────────────────────────────────────────────────────

describe('predictCreateAddress', () => {
  it('matches the canonical vectors', () => {
    // The set every implementation is checked against.
    expect(predictCreateAddress(DEPLOYER, 0)).toBe('0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d')
    expect(predictCreateAddress(DEPLOYER, 1)).toBe('0x343c43a37d37dff08ae8c4a11544c718abb4fcf8')
    expect(predictCreateAddress(DEPLOYER, 2)).toBe('0xf778b86fa74e846c4f0a1fbd1335fe81c00a0c91')
    expect(predictCreateAddress(DEPLOYER, 3)).toBe('0xfffd933a0bc612844eaf0c6fe3e5b8e9b6c1d19c')
  })

  it('agrees with viem across the RLP branch boundaries', () => {
    // Two implementations, byte-exact, which is this repo's standing rule for
    // anything derived. The interesting values are the RLP seams: 0 encodes
    // as 0x80, 1..127 as themselves, 128 and up as a length prefix plus
    // big-endian bytes, and each extra byte is another branch.
    for (const nonce of [0, 1, 2, 3, 126, 127, 128, 129, 254, 255, 256, 257, 65_535, 65_536, 1_000_000]) {
      expect(predictCreateAddress(DEPLOYER, nonce)).toBe(
        getContractAddress({ from: DEPLOYER, nonce: BigInt(nonce), opcode: 'CREATE' }).toLowerCase(),
      )
    }
  })

  it('depends on both the deployer and the nonce', () => {
    const other = '0x0000000000000000000000000000000000000001' as EvmAddress
    expect(predictCreateAddress(DEPLOYER, 5)).not.toBe(predictCreateAddress(other, 5))
    expect(predictCreateAddress(DEPLOYER, 5)).not.toBe(predictCreateAddress(DEPLOYER, 6))
  })

  it('refuses a negative or fractional nonce', () => {
    expect(() => predictCreateAddress(DEPLOYER, -1)).toThrow(DeployError)
    expect(() => predictCreateAddress(DEPLOYER, 1.5)).toThrow(DeployError)
  })
})

describe('normaliseAddress', () => {
  it('lowercases and accepts a checksummed address', () => {
    expect(normaliseAddress('0x6AC7EA33F8831EA9DCC53393AAA88B25A785DBF0')).toBe(DEPLOYER)
  })

  it('rejects anything that is not 20 bytes of hex', () => {
    for (const bad of ['0x', '6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', `${DEPLOYER}00`, '0xzz']) {
      expect(() => normaliseAddress(bad)).toThrow(DeployError)
    }
  })
})

// ── Planning ────────────────────────────────────────────────────────────────

describe('planDeploy', () => {
  it('refuses when the endpoint is on a different chain', async () => {
    // The mistake this whole file is shaped around: an RPC URL still pointing
    // at the rehearsal network, or at mainnet during a rehearsal. Deploying
    // to the wrong chain otherwise succeeds silently.
    const rpc = fakeRpc({ chainId: 137 })
    await expect(planDeploy(rpc, fakeSigner(), { expectedChainId: CHAIN_ID })).rejects.toThrow(
      /endpoint is on chain 137, expected 11155111/,
    )
  })

  it('refuses when the deployer cannot cover the worst case', async () => {
    const rpc = fakeRpc({ balance: 1n })
    await expect(planDeploy(rpc, fakeSigner(), { expectedChainId: CHAIN_ID })).rejects.toThrow(
      /holds 1 wei, needs up to/,
    )
  })

  it('buffers the node gas estimate', async () => {
    const plan = await planDeploy(fakeRpc({ gas: 100_000n }), fakeSigner(), { expectedChainId: CHAIN_ID })
    expect(plan.gas).toBe((100_000n * GAS_BUFFER_PERCENT) / 100n)
    expect(plan.maxCost).toBe(plan.gas * plan.fees.maxFeePerGas)
  })

  it('predicts the address from the pending nonce and pins the build', async () => {
    const plan = await planDeploy(fakeRpc({ nonce: 7 }), fakeSigner(), { expectedChainId: CHAIN_ID })
    expect(plan.nonce).toBe(7)
    expect(plan.predictedAddress).toBe(predictCreateAddress(DEPLOYER, 7))
    // The plan carries what was compiled, so the dry-run output is reviewable
    // against the repository rather than against a promise.
    expect(plan.sourceHash).toBe(ARTIFACT.sourceHash)
    expect(plan.solcVersion).toBe(ARTIFACT.solcVersion)
    expect(plan.bytecode).toBe(ARTIFACT.bytecode)
  })

  it('describes itself without leaking anything secret', async () => {
    const plan = await planDeploy(fakeRpc(), fakeSigner(), { expectedChainId: CHAIN_ID })
    const text = describePlan(plan).join('\n')
    expect(text).toContain('predicted address 0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d')
    expect(text).toContain(ARTIFACT.sourceHash)
    expect(text).toContain('chain id          11155111')
  })
})

// ── Execution ───────────────────────────────────────────────────────────────

describe('executeDeploy', () => {
  it('signs a creation with the planned parameters and broadcasts once', async () => {
    const rpc = fakeRpc({ nonce: 3 })
    const signer = fakeSigner()
    const plan = await planDeploy(rpc, signer, { expectedChainId: CHAIN_ID })
    const outcome = await executeDeploy(rpc, signer, plan)

    expect(signer.signed).toHaveLength(1)
    expect(signer.signed[0]).toEqual({
      chainId: CHAIN_ID,
      nonce: 3,
      gas: plan.gas,
      maxFeePerGas: plan.fees.maxFeePerGas,
      maxPriorityFeePerGas: plan.fees.maxPriorityFeePerGas,
      data: ARTIFACT.bytecode,
    })
    expect(rpc.sent).toEqual(['0x02deadbeef'])
    expect(outcome.address).toBe(plan.predictedAddress)
    expect(outcome.codeVerified).toBe(true)
  })

  it('throws on a reverted receipt', async () => {
    const rpc = fakeRpc({ receipt: { status: 'reverted' } })
    const signer = fakeSigner()
    const plan = await planDeploy(rpc, signer, { expectedChainId: CHAIN_ID })
    await expect(executeDeploy(rpc, signer, plan)).rejects.toThrow(/reverted/)
  })

  it('throws when the transaction created no contract', async () => {
    const rpc = fakeRpc({ receipt: { contractAddress: null } })
    const signer = fakeSigner()
    const plan = await planDeploy(rpc, signer, { expectedChainId: CHAIN_ID })
    await expect(executeDeploy(rpc, signer, plan)).rejects.toThrow(/created no contract/)
  })

  it('throws when the deployed address is not the reviewed one', async () => {
    // The nonce moved between planning and sending: something else spent from
    // the deploy key. The contract exists, but not where the plan said, and
    // the address in the plan is the one a human just approved.
    const elsewhere = '0x0000000000000000000000000000000000000009' as EvmAddress
    const rpc = fakeRpc({ receipt: { contractAddress: elsewhere } })
    const signer = fakeSigner()
    const plan = await planDeploy(rpc, signer, { expectedChainId: CHAIN_ID })
    await expect(executeDeploy(rpc, signer, plan)).rejects.toThrow(/sent another transaction in between/)
  })

  it('throws when the deployed code is not this contract', async () => {
    const rpc = fakeRpc({ code: '0x6001' as Hex })
    const signer = fakeSigner()
    const plan = await planDeploy(rpc, signer, { expectedChainId: CHAIN_ID })
    await expect(executeDeploy(rpc, signer, plan)).rejects.toThrow(/is not this contract/)
  })
})

// ── Verification ────────────────────────────────────────────────────────────

describe('verifyDeployedCode', () => {
  it('matches when the address holds the committed runtime code', async () => {
    const result = await verifyDeployedCode(fakeRpc(), DEPLOYER)
    expect(result.match).toBe(true)
  })

  it('does not match an empty address, and says so plainly', async () => {
    const result = await verifyDeployedCode(fakeRpc({ code: '0x' }), DEPLOYER)
    expect(result.match).toBe(false)
    expect(describeMismatch(DEPLOYER, result)).toContain('nothing is deployed there')
  })

  it('does not match a different contract, and reports both sizes', async () => {
    const result = await verifyDeployedCode(fakeRpc({ code: '0x60016002' as Hex }), DEPLOYER)
    expect(result.match).toBe(false)
    expect(describeMismatch(DEPLOYER, result)).toMatch(/4 bytes deployed, \d+ bytes expected/)
  })

  it('is case-insensitive about the node’s hex', async () => {
    const upper = ARTIFACT.deployedBytecode.toUpperCase().replace('0X', '0x') as Hex
    expect((await verifyDeployedCode(fakeRpc({ code: upper }), DEPLOYER)).match).toBe(true)
  })
})

describe('viewOnlySigner', () => {
  it('knows an address and refuses to sign', async () => {
    const signer = viewOnlySigner('0x6AC7EA33F8831EA9DCC53393AAA88B25A785DBF0')
    expect(signer.address).toBe(DEPLOYER)
    // "Planned without the key" must never become "sent without the key".
    await expect(
      signer.signTransaction({
        chainId: 1,
        nonce: 0,
        gas: 1n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        data: '0x' as Hex,
      }),
    ).rejects.toThrow(/no deploy key configured/)
  })

  it('can plan a whole deployment', async () => {
    const plan = await planDeploy(fakeRpc(), viewOnlySigner(DEPLOYER), { expectedChainId: CHAIN_ID })
    expect(plan.predictedAddress).toBe(predictCreateAddress(DEPLOYER, 0))
  })
})
