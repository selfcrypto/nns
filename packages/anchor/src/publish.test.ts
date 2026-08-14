import { cidFromDigest, CONSTANTS } from '@nns/core'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { encodeFunctionData } from 'viem'
import { describe, expect, it } from 'vitest'
import { ANCHORED_TOPIC0, ARTIFACT } from './artifact.js'
import type { DeployReceipt, DeployTransaction, EvmAddress, EvmLog, Hex, PublisherRpc, Signer } from './chain.js'
import type { AddOptions, IpfsAdd } from './ipfs.js'
import type { CheckpointAnswer, LogSnapshot, NnsApi } from './nns-api.js'
import {
  addressTopic,
  ANCHOR_SELECTOR,
  DAILY_FLOOR_SEC,
  decodeAnchored,
  describePublishPlan,
  encodeAnchorCalldata,
  executePublish,
  planPublish,
  PublishError,
  type PublishDeps,
  type PublishOptions,
  type PublishPlan,
} from './publish.js'

const PUBLISHER = '0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0' as EvmAddress
const CONTRACT = '0x0102030405060708090a0b0c0d0e0f1011121314' as EvmAddress
const CHAIN_ID = 11155111
const HEIGHT = 58_204_800 // an absolute multiple of 720
/** The tests' wall clock, unix seconds — injected, so time is data here. */
const NOW = 1_765_000_000

// A real snapshot: bytes, their keccak, and a digest/CID pair. The CID is
// minted by cidFromDigest, which stands in for the two services agreeing —
// the tests never derive a CID from the bytes, exactly like the publisher.
const LOG_BYTES = utf8ToBytes('58204083 0 aa bb cc 1 4e4e5331 OK\n')
const LOG_HASH: Hex = `0x${bytesToHex(keccak_256(LOG_BYTES))}`
const DIGEST_HEX = 'bfccda787baba32b59c78450ac3d20b633360b43992c77289f9ed46d843561e6'
const CID = cidFromDigest(Uint8Array.from(Buffer.from(DIGEST_HEX, 'hex')))
const COMMITMENT: Hex = `0x${'ab'.repeat(32)}`

// ── Fakes ───────────────────────────────────────────────────────────────────

interface ApiOptions {
  snapshot?: Partial<LogSnapshot>
  answer?: CheckpointAnswer
}

function fakeApi(options: ApiOptions = {}): NnsApi {
  return {
    fetchLog: async () => ({
      bytes: LOG_BYTES,
      checkpointHeight: HEIGHT,
      logHash: LOG_HASH,
      ...options.snapshot,
    }),
    fetchCheckpoint: async (height) =>
      options.answer ?? {
        kind: 'ok',
        checkpoint: { height, commitment: COMMITMENT, logHash: LOG_HASH },
      },
  }
}

function fakeIpfs(label: string, cid: string = CID): IpfsAdd & { calls: AddOptions[] } {
  const calls: AddOptions[] = []
  return {
    label,
    calls,
    add: async (_bytes: Uint8Array, addOptions: AddOptions) => {
      calls.push(addOptions)
      return cid
    },
  }
}

/** An Anchored event as eth_getLogs would return it. Age defaults to an hour. */
function anchoredLog(root: Hex, publisher: EvmAddress, nimiqHeight: number, timestamp = NOW - 3_600): EvmLog {
  const heightWord = nimiqHeight.toString(16).padStart(64, '0')
  const timestampWord = timestamp.toString(16).padStart(64, '0')
  return {
    address: CONTRACT,
    topics: [ANCHORED_TOPIC0 as Hex, root, addressTopic(publisher)],
    data: `0x${heightWord}${timestampWord}${DIGEST_HEX}`,
    blockNumber: 100n,
    transactionHash: '0xabcd' as Hex,
  }
}

interface RpcOptions {
  chainId?: number
  code?: Hex
  balance?: bigint
  logs?: EvmLog[]
  receiptStatus?: 'success' | 'reverted'
}

function fakeRpc(options: RpcOptions = {}): PublisherRpc & { sent: Hex[] } {
  const sent: Hex[] = []
  return {
    sent,
    chainId: async () => options.chainId ?? CHAIN_ID,
    getBalance: async () => options.balance ?? 10n ** 18n,
    getTransactionCount: async () => 7,
    estimateGas: async () => 30_000n,
    estimateFees: async () => ({ maxFeePerGas: 40_000_000_000n, maxPriorityFeePerGas: 30_000_000_000n }),
    sendRawTransaction: async (signed: Hex) => {
      sent.push(signed)
      return '0xfeed' as Hex
    },
    waitForReceipt: async (hash: Hex): Promise<DeployReceipt> => ({
      transactionHash: hash,
      blockNumber: 4242n,
      contractAddress: null,
      status: options.receiptStatus ?? 'success',
      gasUsed: 29_000n,
    }),
    getCode: async () => options.code ?? (ARTIFACT.deployedBytecode as Hex),
    blockNumber: async () => 1_000_000n,
    getLogs: async () => options.logs ?? [],
  }
}

function fakeSigner(): Signer & { signed: DeployTransaction[] } {
  const signed: DeployTransaction[] = []
  return {
    signed,
    address: PUBLISHER,
    signTransaction: async (tx: DeployTransaction) => {
      signed.push(tx)
      return '0x02deadbeef' as Hex
    },
  }
}

interface DepsOptions {
  api?: NnsApi
  rpc?: PublisherRpc & { sent: Hex[] }
  ipfsA?: IpfsAdd & { calls: AddOptions[] }
  ipfsB?: IpfsAdd & { calls: AddOptions[] }
  signer?: Signer & { signed: DeployTransaction[] }
}

function deps(options: DepsOptions = {}) {
  const rpc = options.rpc ?? fakeRpc()
  const ipfsA = options.ipfsA ?? fakeIpfs('kubo')
  const ipfsB = options.ipfsB ?? fakeIpfs('pinner')
  const signer = options.signer ?? fakeSigner()
  const bundle: PublishDeps = {
    api: options.api ?? fakeApi(),
    rpc,
    ipfs: [ipfsA, ipfsB],
    signer,
    now: () => NOW,
  }
  return { bundle, rpc, ipfsA, ipfsB, signer }
}

const OPTIONS: PublishOptions = {
  expectedChainId: CHAIN_ID,
  contractAddress: CONTRACT,
  minBalanceWei: 10n ** 17n,
  lookbackBlocks: 100_000n,
}

async function planned(d: ReturnType<typeof deps>, options: PublishOptions = OPTIONS): Promise<PublishPlan> {
  const outcome = await planPublish(d.bundle, options)
  if (outcome.kind !== 'anchor') throw new Error(`expected an anchor plan, got ${outcome.kind}`)
  return outcome.plan
}

// ── Calldata ────────────────────────────────────────────────────────────────

describe('encodeAnchorCalldata', () => {
  it('agrees with viem over the committed ABI — the encoding seam', () => {
    const digest = Uint8Array.from(Buffer.from(DIGEST_HEX, 'hex'))
    const expected = encodeFunctionData({
      abi: ARTIFACT.abi,
      functionName: 'anchor',
      args: [COMMITMENT, BigInt(HEIGHT), `0x${DIGEST_HEX}`],
    })
    expect(encodeAnchorCalldata(COMMITMENT, HEIGHT, digest)).toBe(expected)
    expect(expected.startsWith(ANCHOR_SELECTOR)).toBe(true)
  })

  it('refuses malformed inputs', () => {
    const digest = new Uint8Array(32)
    expect(() => encodeAnchorCalldata('0xAB' as Hex, HEIGHT, digest)).toThrow(PublishError)
    expect(() => encodeAnchorCalldata(COMMITMENT, 1.5, digest)).toThrow(PublishError)
    expect(() => encodeAnchorCalldata(COMMITMENT, HEIGHT, new Uint8Array(31))).toThrow(PublishError)
  })
})

describe('decodeAnchored', () => {
  it('round-trips what anchoredLog encodes', () => {
    const decoded = decodeAnchored(anchoredLog(COMMITMENT, PUBLISHER, HEIGHT, NOW - 42))
    expect(decoded).toEqual({
      root: COMMITMENT,
      publisher: PUBLISHER,
      nimiqHeight: HEIGHT,
      timestamp: NOW - 42,
      logDigest: `0x${DIGEST_HEX}`,
      transactionHash: '0xabcd',
    })
  })

  it('refuses a log that is not an Anchored event', () => {
    const log = { ...anchoredLog(COMMITMENT, PUBLISHER, HEIGHT), topics: [`0x${'00'.repeat(32)}` as Hex] }
    expect(() => decodeAnchored(log)).toThrow(PublishError)
  })
})

// ── Planning: the happy path ────────────────────────────────────────────────

describe('planPublish', () => {
  it('plans an anchor with the commitment verbatim and the agreed CID', async () => {
    const d = deps()
    const plan = await planned(d)

    // The commitment travels untouched from the checkpoint document into the
    // calldata — the publisher's defining property.
    expect(plan.commitment).toBe(COMMITMENT)
    expect(plan.calldata).toBe(
      `${ANCHOR_SELECTOR}${COMMITMENT.slice(2)}${HEIGHT.toString(16).padStart(64, '0')}${DIGEST_HEX}`,
    )
    expect(plan.cid).toBe(CID)
    expect(plan.logDigest).toBe(`0x${DIGEST_HEX}`)
    expect(plan.nimiqHeight).toBe(HEIGHT)
    expect(plan.trigger).toBe('change')

    // Planning adds through both services without pinning, and sends nothing.
    expect(d.ipfsA.calls).toEqual([{ pin: false }])
    expect(d.ipfsB.calls).toEqual([{ pin: false }])
    expect(d.rpc.sent).toEqual([])
    expect(d.signer.signed).toEqual([])

    expect(describePublishPlan(plan).join('\n')).toContain('verbatim')
  })

  it('warns on a first run with no prior anchor, without blocking', async () => {
    const plan = await planned(deps())
    expect(plan.warnings.some((w) => w.includes('no prior anchor'))).toBe(true)
  })

  // ── Refusals, each of which would otherwise succeed silently ──────────────

  it('refuses the wrong chain', async () => {
    const d = deps({ rpc: fakeRpc({ chainId: 137 }) })
    await expect(planPublish(d.bundle, OPTIONS)).rejects.toThrow(/chain 137/)
  })

  it('refuses a contract address that does not hold this contract', async () => {
    // anchor() into an empty address "succeeds" and emits nothing.
    const d = deps({ rpc: fakeRpc({ code: '0x' }) })
    await expect(planPublish(d.bundle, OPTIONS)).rejects.toThrow(/NNS_ANCHOR_CONTRACT_ADDRESS/)
  })

  it('refuses a log snapshot whose bytes do not hash to the served log hash', async () => {
    const d = deps({ api: fakeApi({ snapshot: { logHash: `0x${'00'.repeat(32)}` as Hex } }) })
    await expect(planPublish(d.bundle, OPTIONS)).rejects.toThrow(/corrupted in transit|lying/)
    expect(d.ipfsA.calls).toEqual([]) // stopped before any IPFS traffic
  })

  it('refuses a torn pair — checkpoint committing a different log hash', async () => {
    const otherHash: Hex = `0x${'11'.repeat(32)}`
    const d = deps({
      api: fakeApi({
        answer: { kind: 'ok', checkpoint: { height: HEIGHT, commitment: COMMITMENT, logHash: otherHash } },
      }),
    })
    await expect(planPublish(d.bundle, OPTIONS)).rejects.toThrow(/torn pair/)
  })

  // ── The four /checkpoints answers ─────────────────────────────────────────

  it('waits on CHECKPOINT_PENDING', async () => {
    const d = deps({ api: fakeApi({ answer: { kind: 'pending', latest: HEIGHT - 720 } }) })
    const outcome = await planPublish(d.bundle, OPTIONS)
    expect(outcome.kind).toBe('waiting')
    expect(d.ipfsA.calls).toEqual([])
    expect(d.rpc.sent).toEqual([])
  })

  it('alerts on CHECKPOINT_NOT_RETAINED', async () => {
    const d = deps({ api: fakeApi({ answer: { kind: 'notRetained', oldest: HEIGHT + 720 } }) })
    await expect(planPublish(d.bundle, OPTIONS)).rejects.toThrow(/no longer retained/)
  })

  it('alerts on CHECKPOINT_MISSING', async () => {
    const d = deps({ api: fakeApi({ answer: { kind: 'missing' } }) })
    await expect(planPublish(d.bundle, OPTIONS)).rejects.toThrow(/gap/)
  })

  // ── The §8.2 two-implementation gate ──────────────────────────────────────

  it('hard-stops when the two services mint different CIDs — never picks one', async () => {
    const otherCid = cidFromDigest(Uint8Array.from(Buffer.from('46d44814b9c5af141c3aaab7c05dc5e844ead5f91f12858b021eba45768b4c0e', 'hex')))
    const d = deps({ ipfsB: fakeIpfs('pinner', otherCid) })
    await expect(planPublish(d.bundle, OPTIONS)).rejects.toThrow(/CID mismatch: kubo .* pinner /)
    expect(d.rpc.sent).toEqual([])
    expect(d.signer.signed).toEqual([])
  })

  it('hard-stops when both services agree on a CID that is not §8.2\'s shape', async () => {
    // 'b' + 58×'a' decodes cleanly but its prefix is not 01 70 12 20 — the
    // shape a raw-leaves (or otherwise misconfigured) add produces.
    const badCid = `b${'a'.repeat(58)}`
    const d = deps({ ipfsA: fakeIpfs('kubo', badCid), ipfsB: fakeIpfs('pinner', badCid) })
    await expect(planPublish(d.bundle, OPTIONS)).rejects.toThrow(/not §8.2's shape/)
  })

  // ── Idempotency off the chain ─────────────────────────────────────────────

  it('skips a height this key already anchored with the same commitment', async () => {
    const d = deps({ rpc: fakeRpc({ logs: [anchoredLog(COMMITMENT, PUBLISHER, HEIGHT)] }) })
    const outcome = await planPublish(d.bundle, OPTIONS)
    expect(outcome).toEqual({
      kind: 'already-anchored',
      nimiqHeight: HEIGHT,
      commitment: COMMITMENT,
      transactionHash: '0xabcd',
    })
    // Nothing else was spent: no IPFS traffic, no signing, no send.
    expect(d.ipfsA.calls).toEqual([])
    expect(d.signer.signed).toEqual([])
  })

  it('alerts when the API now serves a different commitment for an anchored height', async () => {
    const otherRoot: Hex = `0x${'cd'.repeat(32)}`
    const d = deps({ rpc: fakeRpc({ logs: [anchoredLog(otherRoot, PUBLISHER, HEIGHT)] }) })
    await expect(planPublish(d.bundle, OPTIONS)).rejects.toThrow(/divergence/)
  })

  it('ignores other publishers\' anchors at the same height', async () => {
    const other = '0x000000000000000000000000000000000000beef' as EvmAddress
    const d = deps({ rpc: fakeRpc({ logs: [anchoredLog(COMMITMENT, other, HEIGHT)] }) })
    const outcome = await planPublish(d.bundle, OPTIONS)
    expect(outcome.kind).toBe('anchor')
  })

  // ── The §9 cadence: on change, with a daily floor ─────────────────────────

  it('skips while the commitment is unchanged and the newest anchor is fresh', async () => {
    const d = deps({
      rpc: fakeRpc({ logs: [anchoredLog(COMMITMENT, PUBLISHER, HEIGHT - 720, NOW - 6 * 3_600)] }),
    })
    const outcome = await planPublish(d.bundle, OPTIONS)
    expect(outcome).toEqual({
      kind: 'unchanged',
      nimiqHeight: HEIGHT,
      commitment: COMMITMENT,
      lastAnchoredHeight: HEIGHT - 720,
      ageSeconds: 6 * 3_600,
      transactionHash: '0xabcd',
    })
    // Nothing else was spent: no IPFS traffic, no signing.
    expect(d.ipfsA.calls).toEqual([])
    expect(d.signer.signed).toEqual([])
  })

  it('anchors at the daily floor even when the commitment is unchanged', async () => {
    const d = deps({
      rpc: fakeRpc({ logs: [anchoredLog(COMMITMENT, PUBLISHER, HEIGHT - 720, NOW - DAILY_FLOOR_SEC - 60)] }),
    })
    const plan = await planned(d)
    expect(plan.trigger).toBe('floor')
    expect(plan.nimiqHeight).toBe(HEIGHT) // the latest boundary, never a backfill
    expect(plan.warnings).toEqual([]) // one day is the design, not an incident
    expect(describePublishPlan(plan).join('\n')).toContain('daily floor')
  })

  it('anchors on change regardless of how fresh the last anchor is', async () => {
    const otherRoot: Hex = `0x${'cd'.repeat(32)}`
    const d = deps({
      rpc: fakeRpc({ logs: [anchoredLog(otherRoot, PUBLISHER, HEIGHT - 720, NOW - 600)] }),
    })
    const plan = await planned(d)
    expect(plan.trigger).toBe('change')
    expect(plan.warnings).toEqual([])
  })

  it('warns when the newest own anchor is beyond the staleness limit', async () => {
    // Clients have been warning (§8.5 #8) — the schedule missed a floor.
    const d = deps({
      rpc: fakeRpc({
        logs: [anchoredLog(COMMITMENT, PUBLISHER, HEIGHT - 720, NOW - CONSTANTS.ANCHOR_STALENESS_LIMIT_SEC - 3_600)],
      }),
    })
    const plan = await planned(d)
    expect(plan.trigger).toBe('floor')
    expect(plan.warnings.some((w) => w.includes('missed at least one daily-floor anchor'))).toBe(true)
  })

  // ── §11.5 ─────────────────────────────────────────────────────────────────

  it('refuses to sign when the balance cannot cover the anchor', async () => {
    const d = deps({ rpc: fakeRpc({ balance: 1n }) })
    await expect(planPublish(d.bundle, OPTIONS)).rejects.toThrow(/holds 1 wei/)
  })

  it('alerts below the threshold while still anchoring', async () => {
    // Covers the transaction (max cost = 37_500 gas × 40 gwei = 1.5e15 wei)
    // but sits under the configured 1e17 threshold.
    const d = deps({ rpc: fakeRpc({ balance: 2n * 10n ** 15n }) })
    const plan = await planned(d)
    expect(plan.warnings.some((w) => w.startsWith('ALERT'))).toBe(true)
  })
})

// ── Execution ───────────────────────────────────────────────────────────────

describe('executePublish', () => {
  it('pins on both services, then signs to the contract and broadcasts', async () => {
    const d = deps()
    const plan = await planned(d)
    const result = await executePublish(d.bundle, plan)

    expect(d.ipfsA.calls).toEqual([{ pin: false }, { pin: true }])
    expect(d.ipfsB.calls).toEqual([{ pin: false }, { pin: true }])
    expect(d.signer.signed).toEqual([
      {
        chainId: CHAIN_ID,
        nonce: 7,
        gas: plan.gas,
        maxFeePerGas: plan.maxFeePerGas,
        maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
        data: plan.calldata,
        to: CONTRACT,
      },
    ])
    expect(d.rpc.sent).toEqual(['0x02deadbeef'])
    expect(result).toEqual({ transactionHash: '0xfeed', blockNumber: 4242n, gasUsed: 29_000n })
  })

  it('hard-stops when a pin answers a different CID than planning did', async () => {
    let calls = 0
    const flaky: IpfsAdd = {
      label: 'flaky',
      add: async () => {
        calls += 1
        return calls === 1 ? CID : `b${'a'.repeat(58)}`
      },
    }
    const d0 = deps()
    const d = { ...d0, bundle: { ...d0.bundle, ipfs: [flaky, d0.ipfsB] as const } }
    const plan = await planned(d as ReturnType<typeof deps>)
    await expect(executePublish(d.bundle, plan)).rejects.toThrow(/nondeterministic/)
    expect(d0.rpc.sent).toEqual([])
  })

  it('reports a reverted anchor transaction', async () => {
    const d = deps({ rpc: fakeRpc({ receiptStatus: 'reverted' }) })
    const plan = await planned(d)
    await expect(executePublish(d.bundle, plan)).rejects.toThrow(/reverted/)
  })

  it('is idempotent across a restart: the next run sees the anchor on chain and skips', async () => {
    // Run 1 anchors; the fake chain records the event the way eth_getLogs
    // would serve it back; run 2 — a fresh process with no local state —
    // decides already-anchored.
    const d = deps()
    const plan = await planned(d)
    await executePublish(d.bundle, plan)
    expect(d.rpc.sent).toHaveLength(1)

    const d2 = deps({ rpc: fakeRpc({ logs: [anchoredLog(plan.commitment, PUBLISHER, plan.nimiqHeight)] }) })
    const outcome = await planPublish(d2.bundle, OPTIONS)
    expect(outcome.kind).toBe('already-anchored')
    expect(d2.rpc.sent).toEqual([])
  })
})
