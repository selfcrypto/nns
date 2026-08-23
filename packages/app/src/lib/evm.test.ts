import { describe, expect, it } from 'vitest'
import { EvmAmountError, FALLBACK_TRANSFER_GAS, USDT_POLYGON, erc20TransferData, evmErrorMessage, formatUsdt, gasLimitFor, parseUsdtAmount, sendUsdtOnPolygon } from './evm'

describe('parseUsdtAmount', () => {
  it('takes integers and up to six decimals, exactly', () => {
    expect(parseUsdtAmount('25')).toBe(25_000_000n)
    expect(parseUsdtAmount('9.5')).toBe(9_500_000n)
    expect(parseUsdtAmount('0.000001')).toBe(1n)
  })

  it('refuses what is not an amount', () => {
    for (const bad of ['', '1,5', '1.2345678', '-2', '1e3', '0x10']) {
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
    const failure = await sendUsdtOnPolygon({ to: TO, units: 1n }, refused.provider)
    expect(failure).toEqual({ ok: false, reason: 'failed', detail: 'insufficient funds for gas * price' })

    const declined = fake({
      eth_requestAccounts: ['0xAA00000000000000000000000000000000000001'],
      eth_chainId: '0x89',
      eth_estimateGas: '0x10000',
      eth_sendTransaction: { reject: { code: 4001 } },
    })
    expect(await sendUsdtOnPolygon({ to: TO, units: 1n }, declined.provider)).toEqual({
      ok: false,
      reason: 'declined',
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
