import { keypairFromPrivateKey, signMessage } from '@nimiqnames/core'
import { describe, expect, it } from 'vitest'

import { canonicalAddress, challengeText, verifyChallenge } from './session.js'

const KEY = keypairFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000001')
const OTHER = keypairFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000002')
const address = canonicalAddress(KEY.address)!
const TEXT = challengeText(address, 'nimiqnames.com', 'n0nce', new Date('2026-09-23T00:00:00Z'))

describe('the challenge', () => {
  it('says what it is for, in words', () => {
    expect(TEXT).toBe(`NNS notifications for ${address} on nimiqnames.com. Nonce n0nce. Valid until 2026-09-23T00:00:00.000Z.`)
  })

  it('accepts the address’s own signature under an allowed convention', () => {
    expect(verifyChallenge(TEXT, address, KEY.publicKey, signMessage(KEY.privateKey, TEXT), ['nimiq', 'raw'])).toEqual({
      ok: true,
      address,
      convention: 'nimiq',
    })
    expect(verifyChallenge(TEXT, address, KEY.publicKey, signMessage(KEY.privateKey, TEXT, 'raw'), ['nimiq'])).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    })
  })

  it('names the signer when a different key signed', () => {
    const verdict = verifyChallenge(TEXT, address, OTHER.publicKey, signMessage(OTHER.privateKey, TEXT), ['nimiq'])
    expect(verdict).toEqual({ ok: false, reason: 'ADDRESS_MISMATCH', signer: canonicalAddress(OTHER.address) })
  })

  it('treats garbage as a bad signature rather than a crash', () => {
    expect(verifyChallenge(TEXT, address, 'zz', 'zz', ['nimiq'])).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
    expect(canonicalAddress('not an address')).toBeNull()
    expect(canonicalAddress(42)).toBeNull()
  })
})
