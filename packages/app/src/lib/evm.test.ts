import { describe, expect, it } from 'vitest'
import { EvmAmountError, USDT_POLYGON, erc20TransferData, formatUsdt, parseUsdtAmount } from './evm'

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
