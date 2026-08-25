import { describe, expect, it } from 'vitest'
import { EvmAmountError, FALLBACK_TRANSFER_GAS, USDT_POLYGON, erc20TransferData, evmErrorMessage, fetchPolBalanceFor, fetchUsdtBalanceFor, formatUsdt, gasLimitFor, parseUsdtAmount, sendUsdtOnPolygon, silentEvmAccount } from './evm'

const noFetch = (() => Promise.reject(new Error('no network in tests'))) as unknown as typeof fetch

describe('parseUsdtAmount', () => {
  it('takes integers and up to six decimals, exactly, with . or , between', () => {
    expect(parseUsdtAmount('25')).toBe(25_000_000n)
    expect(parseUsdtAmount('9.5')).toBe(9_500_000n)
    expect(parseUsdtAmount('9,5')).toBe(9_500_000n)
    expect(parseUsdtAmount('0,50')).toBe(500_000n)
    expect(parseUsdtAmount('0.000001')).toBe(1n)
  })

  it('refuses what is not an amount', () => {
    // One separator per amount: grouped thousands like 1.000,5 read
    // differently per locale, so they never parse.
    for (const bad of ['', '1.2345678', '1,2345678', '-2', '1e3', '0x10', ',5', '1.000,5', '1,000.5']) {
      expect(() => parseUsdtAmount(bad)).toThrow(EvmAmountError)
    }
  })

  it('round-trips through formatUsdt with trailing zeros trimmed', () => {
    expect(formatUsdt(parseUsdtAmount('9.50'))).toBe('9.5')
    expect(formatUsdt(parseUsdtAmount('25'))).toBe('25')
  })
})

describe('erc20TransferData', () => {
  it('is the transfer selector and two 32-byte-padded arguments', () => {
    const data = erc20TransferData('0x1b3f6a09e2c40d55c8a1b2c3d4e5f60718293a4b', 25_000_000n)
    expect(data).toBe(
      '0xa9059cbb' +
        '0000000000000000000000001b3f6a09e2c40d55c8a1b2c3d4e5f60718293a4b' +
        '00000000000000000000000000000000000000000000000000000000017d7840',
    )
    expect(data).toHaveLength(2 + 8 + 64 + 64)
  })
})

describe('USDT_POLYGON', () => {
  it('pins the contract and its six decimals — a wrong address here pays the void', () => {
    expect(USDT_POLYGON).toEqual({
      address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
      decimals: 6,
      symbol: 'USDT',
    })
  })
})

describe('evmErrorMessage', () => {
  it('digs the text out of object-shaped rejections — never [object Object]', () => {
    expect(evmErrorMessage({ code: -32000, message: 'insufficient funds for gas' })).toBe(
      'insufficient funds for gas',
    )
    expect(evmErrorMessage({ code: -32603, data: { message: 'execution reverted' } })).toBe('execution reverted')
    expect(evmErrorMessage(new Error('boom'))).toBe('boom')
    expect(evmErrorMessage({ code: 4001 })).not.toBe('[object Object]')
  })
})

describe('gasLimitFor', () => {
  it('pads a hex estimate half again', () => {
    expect(gasLimitFor('0x10000')).toBe(`0x${((0x10000n * 3n) / 2n).toString(16)}`)
  })

  it('falls back to the fixed limit for anything unusable', () => {
    for (const bad of [null, undefined, 42, '65536', '0x', {}]) {
      expect(gasLimitFor(bad)).toBe(`0x${FALLBACK_TRANSFER_GAS.toString(16)}`)
    }
  })
})

describe('sendUsdtOnPolygon over a fake provider', () => {
  const TO = '0x1b3f6a09e2c40d55c8a1b2c3d4e5f60718293a4b'
  const HASH = `0x${'ab'.repeat(32)}`

  const fake = (answers: Record<string, unknown | ((params: unknown) => unknown)>) => {
    const calls: { method: string; params?: readonly unknown[] }[] = []
    return {
      calls,
      provider: {
        request: (args: { method: string; params?: readonly unknown[] }) => {
          calls.push(args)
          const answer = answers[args.method]
          if (answer instanceof Error) return Promise.reject(answer)
          if (typeof answer === 'object' && answer !== null && 'reject' in (answer as object)) {
            return Promise.reject((answer as { reject: unknown }).reject)
          }
          return Promise.resolve(typeof answer === 'function' ? answer(args.params) : answer)
        },
      },
    }
  }

  it('always sends a gas field — Pay estimates nothing on its own', async () => {
    const { provider, calls } = fake({
      eth_requestAccounts: ['0xAA00000000000000000000000000000000000001'],
      eth_chainId: '0x89',
      eth_estimateGas: '0x10000',
      eth_sendTransaction: HASH,
    })
    const sent = await sendUsdtOnPolygon({ to: TO, units: 1_000_000n }, provider)
    expect(sent).toEqual({ ok: true, hash: HASH, from: '0xaa00000000000000000000000000000000000001' })
    const tx = (calls.find((c) => c.method === 'eth_sendTransaction')?.params?.[0] ?? {}) as Record<string, unknown>
    expect(tx['gas']).toBe(`0x${((0x10000n * 3n) / 2n).toString(16)}`)
    expect(tx['to']).toBe(USDT_POLYGON.address)
  })

  it('a failed estimation falls back to the fixed limit and still reaches the wallet', async () => {
    const { provider, calls } = fake({
      eth_requestAccounts: ['0xAA00000000000000000000000000000000000001'],
      eth_chainId: '0x89',
      eth_estimateGas: new Error('estimation failed'),
      eth_sendTransaction: HASH,
    })
    const sent = await sendUsdtOnPolygon({ to: TO, units: 1_000_000n }, provider)
    expect(sent.ok).toBe(true)
    const tx = (calls.find((c) => c.method === 'eth_sendTransaction')?.params?.[0] ?? {}) as Record<string, unknown>
    expect(tx['gas']).toBe(`0x${FALLBACK_TRANSFER_GAS.toString(16)}`)
  })

  it('reports object-shaped refusals readably, and 4001 as declined', async () => {
    const refused = fake({
      eth_requestAccounts: ['0xAA00000000000000000000000000000000000001'],
      eth_chainId: '0x89',
      eth_estimateGas: '0x10000',
      eth_sendTransaction: { reject: { code: -32000, message: 'insufficient funds for gas * price' } },
    })
    // No balance answers anywhere: the classification degrades to the
    // wallet's own words, never to a guessed culprit.
    const failure = await sendUsdtOnPolygon({ to: TO, units: 1n }, refused.provider, noFetch)
    expect(failure).toEqual({ ok: false, reason: 'failed', detail: 'insufficient funds for gas * price' })

    const declined = fake({
      eth_requestAccounts: ['0xAA00000000000000000000000000000000000001'],
      eth_chainId: '0x89',
      eth_estimateGas: '0x10000',
      eth_sendTransaction: { reject: { code: 4001 } },
    })
    expect(await sendUsdtOnPolygon({ to: TO, units: 1n }, declined.provider, noFetch)).toEqual({
      ok: false,
      reason: 'declined',
    })
    // A decline is a decline: no balance was read to explain it.
    expect(declined.calls.some((c) => c.method === 'eth_call' || c.method === 'eth_getBalance')).toBe(false)
  })

  it('names the measured culprit behind "insufficient funds" — the token first', async () => {
    // Holds 0.5 USDT, asked to send 1: the shortfall is USDT, whatever POL says.
    const short = fake({
      eth_requestAccounts: ['0xAA00000000000000000000000000000000000001'],
      eth_chainId: '0x89',
      eth_estimateGas: '0x10000',
      eth_sendTransaction: { reject: { code: -32000, message: 'insufficient funds' } },
      eth_call: `0x${(500_000n).toString(16).padStart(64, '0')}`,
    })
    expect(await sendUsdtOnPolygon({ to: TO, units: 1_000_000n }, short.provider, noFetch)).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'insufficient funds',
      cause: { kind: 'no-usdt', held: 500_000n },
    })

    // Enough USDT, zero POL: now — and only now — the fee is the story.
    const gasless = fake({
      eth_requestAccounts: ['0xAA00000000000000000000000000000000000001'],
      eth_chainId: '0x89',
      eth_estimateGas: '0x10000',
      eth_sendTransaction: { reject: { code: -32000, message: 'insufficient funds' } },
      eth_call: `0x${(2_000_000n).toString(16).padStart(64, '0')}`,
      eth_getBalance: '0x0',
    })
    expect(await sendUsdtOnPolygon({ to: TO, units: 1_000_000n }, gasless.provider, noFetch)).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'insufficient funds',
      cause: { kind: 'no-pol' },
    })

    // Both balances healthy: the wallet's words stand on their own.
    const healthy = fake({
      eth_requestAccounts: ['0xAA00000000000000000000000000000000000001'],
      eth_chainId: '0x89',
      eth_estimateGas: '0x10000',
      eth_sendTransaction: { reject: { code: -32000, message: 'insufficient funds' } },
      eth_call: `0x${(2_000_000n).toString(16).padStart(64, '0')}`,
      eth_getBalance: '0xde0b6b3a7640000',
    })
    expect(await sendUsdtOnPolygon({ to: TO, units: 1_000_000n }, healthy.provider, noFetch)).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'insufficient funds',
    })
  })

  it('switches the chain when the wallet is elsewhere — the sheet Kike saw', async () => {
    const { provider, calls } = fake({
      eth_requestAccounts: ['0xAA00000000000000000000000000000000000001'],
      eth_chainId: '0x1',
      wallet_switchEthereumChain: null,
      eth_estimateGas: '0x10000',
      eth_sendTransaction: HASH,
    })
    expect((await sendUsdtOnPolygon({ to: TO, units: 1n }, provider)).ok).toBe(true)
    expect(calls.some((c) => c.method === 'wallet_switchEthereumChain')).toBe(true)
  })
})

describe('silentEvmAccount and fetchUsdtBalanceFor', () => {
  const provider = (answers: Record<string, unknown>) => ({
    request: (args: { method: string }) =>
      answers[args.method] instanceof Error
        ? Promise.reject(answers[args.method])
        : Promise.resolve(answers[args.method]),
  })
  const rpcFetch = (result: unknown) =>
    (() => Promise.resolve({ json: () => Promise.resolve({ result }) })) as unknown as typeof fetch

  it('silently reads the already-authorized account, lowercased, and never prompts', async () => {
    expect(await silentEvmAccount(provider({ eth_accounts: ['0xAA00000000000000000000000000000000000001'] }))).toBe(
      '0xaa00000000000000000000000000000000000001',
    )
    expect(await silentEvmAccount(provider({ eth_accounts: [] }))).toBeNull()
    expect(await silentEvmAccount(provider({ eth_accounts: new Error('nope') }))).toBeNull()
  })

  it('reads balanceOf through the wallet when it is on Polygon', async () => {
    const units = await fetchUsdtBalanceFor(
      '0xaa00000000000000000000000000000000000001',
      provider({
        eth_chainId: '0x89',
        eth_call: '0x0000000000000000000000000000000000000000000000000000000000bebc20',
      }),
      noFetch,
    )
    expect(units).toBe(12_500_000n)
  })

  it('falls back to the public Polygon endpoint when the wallet cannot answer', async () => {
    // Wrong chain: the wallet's eth_call would answer for the wrong network.
    expect(
      await fetchUsdtBalanceFor(
        '0xaa00000000000000000000000000000000000001',
        provider({ eth_chainId: '0x1' }),
        rpcFetch('0x0000000000000000000000000000000000000000000000000000000000000f4240'),
      ),
    ).toBe(1_000_000n)
    // Provider refuses reads outright.
    expect(
      await fetchUsdtBalanceFor(
        '0xaa00000000000000000000000000000000000001',
        provider({ eth_chainId: new Error('unsupported') }),
        rpcFetch('0x01'),
      ),
    ).toBe(1n)
  })

  it('hides rather than lies when nothing answers', async () => {
    expect(
      await fetchUsdtBalanceFor('0xaa00000000000000000000000000000000000001', provider({ eth_chainId: '0x1' }), noFetch),
    ).toBeNull()
  })

  it('reads POL the same three ways: wallet on Polygon, public fallback, null on a miss', async () => {
    expect(
      await fetchPolBalanceFor(
        '0xaa00000000000000000000000000000000000001',
        provider({ eth_chainId: '0x89', eth_getBalance: '0x0' }),
        noFetch,
      ),
    ).toBe(0n)
    expect(
      await fetchPolBalanceFor(
        '0xaa00000000000000000000000000000000000001',
        provider({ eth_chainId: '0x1' }),
        rpcFetch('0x0de0b6b3a7640000'),
      ),
    ).toBe(1_000_000_000_000_000_000n)
    expect(
      await fetchPolBalanceFor('0xaa00000000000000000000000000000000000001', provider({ eth_chainId: '0x1' }), noFetch),
    ).toBeNull()
  })
})
