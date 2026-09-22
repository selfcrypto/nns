import { CONSTANTS, formatAddress, parse, parseAddress } from '@nimiqnames/core'
import { describe, expect, it } from 'vitest'

import { describeMessage } from './describe.js'

const hex = (text: string): string => Buffer.from(text, 'ascii').toString('hex')
const ALICE = parseAddress('NQ34 248H 248H 248H 248H 248H 248H 248H 248H')
const PROTOCOL = CONSTANTS.PROTOCOL_ADDRESS
const DUST = CONSTANTS.DUST_VALUE

const say = (payload: string, recipient: string = PROTOCOL, value: bigint = DUST): string =>
  describeMessage(parse(hex(payload)), recipient, value)

describe('describeMessage', () => {
  it('reads every §6 message out in words', () => {
    expect(say('NNS1Ggaston', CONSTANTS.TREASURY_ADDRESS, 625_000_000n)).toBe('registers gaston for 1 year')
    expect(say('NNS1Ggaston|coinbase|L')).toBe('registers gaston for 100 years, referred by coinbase')
    expect(say('NNS1Ngaston')).toBe('renews gaston for 1 year')
    expect(say('NNS1Sgaston', ALICE)).toBe(`points gaston at ${formatAddress(ALICE)}`)
    expect(say('NNS1Sgaston')).toBe('points gaston back at its owner')
    expect(say('NNS1Egaston|MKoKX39T3ZuaroF47DSYQ2ht9gM')).toBe(
      'binds gaston to 0x30aa0a5f7f53dd9b9aae8178ec349843686df603',
    )
    expect(say('NNS1Egaston|')).toBe('clears the EVM address of gaston')
    expect(say('NNS1Xgaston', ALICE)).toBe(`transfers gaston to ${formatAddress(ALICE)}`)
    expect(say('NNS1Dgaston|nns.example.com')).toBe('serves subdomains of gaston from nns.example.com')
    expect(say('NNS1Kgaston')).toBe('cancels what is pending on gaston')
    expect(say('NNS1Ogaston|100000000')).toBe('offers gaston for 1,000 NIM')
    expect(say('NNS1Bgaston', CONSTANTS.MARKETPLACE_ADDRESS, 100_000_000n)).toBe('buys gaston for 1,000 NIM')
    expect(say('NNS1M62275744|0', ALICE, 150_000n)).toBe(
      `settles 1.5 NIM owed at block 62,275,744 #0 to ${formatAddress(ALICE)}`,
    )
    expect(say('NNS1Agaston|62500000|62400000')).toBe('auctions gaston from 625 NIM until block 62,400,000')
    expect(say('NNS1P62500000|500|62400000')).toBe(
      'sets the base fee to 625 NIM and the commission to 5% from block 62,400,000',
    )
    expect(say('NNS1Ugaston')).toBe('releases gaston from the reserved list')
    expect(say('NNS1Ugaston|L', ALICE)).toBe(`awards gaston to ${formatAddress(ALICE)} for 100 years`)
    expect(say('NNS1F', 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000', 120_580_000_000n)).toBe(
      'burns 1,205,800 NIM',
    )
  })

  it('escapes a payload field the way the payload itself is rendered, so a name cannot inject a line', () => {
    expect(say('NNS1Ggas\nton')).toBe('registers gas%0aton for 1 year')
    expect(say('NNS1Dgaston|a%b.com')).toBe('serves subdomains of gaston from a%25b.com')
  })

  it('names the parse failure for a payload that is not a message', () => {
    expect(describeMessage(parse(hex('NNS1Zwhat')), PROTOCOL, DUST)).toBe('undecodable: UNKNOWN_TYPE')
    expect(describeMessage(parse('zz'), PROTOCOL, DUST)).toBe('undecodable: NOT_HEX')
  })
})
