import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import { keypairFromPrivateKey } from './keypair.js'
import {
  SIGNED_MESSAGE_PREFIX,
  SignedMessageError,
  signMessage,
  signedMessageDigest,
  verifySignedMessage,
} from './signed-message.js'

// Synthetic, as keypair.test.ts's vectors are: a published key nobody could
// mistake for a real one.
const KEY = keypairFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000001')
const OTHER = keypairFromPrivateKey('0000000000000000000000000000000000000000000000000000000000000002')
const TEXT = 'NNS notifications for NQ07 0000 0000 0000 0000 0000 0000 0000 0000 on nimiqnames.com. Nonce 42.'

describe('signedMessageDigest', () => {
  it('is sha256 over the Hub prefix, the decimal byte length and the message', () => {
    const expected = sha256(new TextEncoder().encode(`${SIGNED_MESSAGE_PREFIX}${TEXT.length}${TEXT}`))
    expect(bytesToHex(signedMessageDigest(TEXT))).toBe(bytesToHex(expected))
  })

  it('counts bytes, not code points', () => {
    const text = 'ñ'
    const expected = sha256(new TextEncoder().encode(`${SIGNED_MESSAGE_PREFIX}2${text}`))
    expect(bytesToHex(signedMessageDigest(text))).toBe(bytesToHex(expected))
  })
})

describe('verifySignedMessage', () => {
  it('names the signer and the convention for a wallet-style signature', () => {
    const signature = signMessage(KEY.privateKey, TEXT)
    expect(verifySignedMessage(TEXT, KEY.publicKey, signature)).toEqual({
      address: KEY.address,
      publicKey: KEY.publicKey,
      convention: 'nimiq',
    })
  })

  it('recognises a raw signature when asked to try it, and not otherwise', () => {
    const signature = signMessage(KEY.privateKey, TEXT, 'raw')
    expect(verifySignedMessage(TEXT, KEY.publicKey, signature)?.convention).toBe('raw')
    expect(verifySignedMessage(TEXT, KEY.publicKey, signature, ['nimiq'])).toBeNull()
  })

  it('fails on a tampered message, a wrong key and a wrong signature', () => {
    const signature = signMessage(KEY.privateKey, TEXT)
    expect(verifySignedMessage(`${TEXT}.`, KEY.publicKey, signature)).toBeNull()
    expect(verifySignedMessage(TEXT, OTHER.publicKey, signature)).toBeNull()
    expect(verifySignedMessage(TEXT, KEY.publicKey, signMessage(OTHER.privateKey, TEXT))).toBeNull()
  })

  it('accepts 0x-prefixed and byte inputs alike', () => {
    const signature = signMessage(KEY.privateKey, TEXT)
    expect(verifySignedMessage(TEXT, `0x${KEY.publicKey}`, `0x${signature}`)?.address).toBe(KEY.address)
    expect(verifySignedMessage(new TextEncoder().encode(TEXT), KEY.publicKey, signature)?.address).toBe(KEY.address)
  })

  it('throws, rather than answering null, for a malformed key or signature', () => {
    expect(() => verifySignedMessage(TEXT, 'abcd', 'ff')).toThrow(SignedMessageError)
    expect(() => verifySignedMessage(TEXT, KEY.publicKey, 'ff')).toThrow(SignedMessageError)
  })
})
