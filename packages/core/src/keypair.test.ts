import { createPrivateKey, createPublicKey } from 'node:crypto'

import { blake2b } from '@noble/hashes/blake2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import { addressToBytes, parseAddress } from './address.js'
import {
  addressFromPublicKey,
  generateKeypair,
  KeypairError,
  keypairFromPrivateKey,
  PRIVATE_KEY_BYTES,
  publicKeyFromPrivateKey,
} from './keypair.js'

/**
 * Vectors. `privateKey → publicKey → address`.
 *
 * The keys are deliberately synthetic — counting from one, all-ones, and an
 * `NNS1`-prefixed pattern — because a vector file is published, and a
 * published private key must be one nobody could mistake for a real one.
 *
 * Both halves of the derivation are pinned against an outside authority rather
 * than against ourselves:
 *
 * - **Ed25519** — `crossCheckWithOpenSSL` below re-derives every public key
 *   through `node:crypto`, a completely separate implementation, and the
 *   RFC 8032 vector is included so a mistake in *how* we call OpenSSL cannot
 *   make the comparison vacuous.
 * - **blake2b-256** — pinned on the published `blake2b-256("abc")` digest.
 * - **The whole path** — an address produced by a Nimiq node's own
 *   `createAccount` was re-derived offline by `keypairFromPrivateKey` and
 *   matched. That check cannot live here: it needs a live key, and this file
 *   is public. It is recorded in `docs/decisions.md` instead.
 */
const VECTORS: ReadonlyArray<readonly [string, string, string]> = [
  [
    '0000000000000000000000000000000000000000000000000000000000000001',
    '4cb5abf6ad79fbf5abbccafcc269d85cd2651ed4b885b5869f241aedf0a5ba29',
    'NQ31FUKCB86246FMHAXBQBMV5NHLKB5H0VRY',
  ],
  [
    '0000000000000000000000000000000000000000000000000000000000000002',
    '7422b9887598068e32c4448a949adb290d0f4e35b9e01b0ee5f1a1e600fe2674',
    'NQ88MJTRUEMDYPYHSAYVRUXD4T357E3Y955T',
  ],
  [
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    '76a1592044a6e4f511265bca73a604d90b0529d1df602be30a19a9257660d1f5',
    'NQ23CJAM84C6NBJKD6149QHH4V50EM37GRJD',
  ],
  [
    '4e4e5331000000000000000000000000000000000000000000000000000000ff',
    '7f36ac1c19f52273863bcd67eaa6c1ca9652fc0c917627e4072abb95bdc6872c',
    'NQ8474GK922Y3HALJB5UQL7V81QDHCJB5EDB',
  ],
]

/** Raw Ed25519 public key via OpenSSL, for an independent second opinion. */
function crossCheckWithOpenSSL(seedHex: string): string {
  const wrapper = Buffer.from('302e020100300506032b657004220420', 'hex')
  const der = Buffer.concat([wrapper, Buffer.from(seedHex, 'hex')])
  const spki = createPublicKey(
    createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }),
  ).export({ format: 'der', type: 'spki' })
  return spki.subarray(spki.length - 32).toString('hex')
}

describe('the derivation is pinned outside this implementation', () => {
  it('agrees with OpenSSL on RFC 8032 vector 1', () => {
    const seed = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
    const expected = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
    expect(publicKeyFromPrivateKey(seed)).toBe(expected)
    expect(crossCheckWithOpenSSL(seed)).toBe(expected)
  })

  it.each(VECTORS)('agrees with OpenSSL on the public key for %s', (privateKey, publicKey) => {
    expect(publicKeyFromPrivateKey(privateKey)).toBe(publicKey)
    expect(crossCheckWithOpenSSL(privateKey)).toBe(publicKey)
  })

  it('uses blake2b-256, pinned on the published digest of "abc"', () => {
    const digest = blake2b.create({ dkLen: 32 }).update(new TextEncoder().encode('abc')).digest()
    expect(bytesToHex(digest)).toBe(
      'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319',
    )
  })

  it.each(VECTORS)('derives the address for %s', (privateKey, publicKey, address) => {
    expect(addressFromPublicKey(publicKey)).toBe(address)
    expect(keypairFromPrivateKey(privateKey)).toEqual({ privateKey, publicKey, address })
  })
})

describe('addressFromPublicKey', () => {
  it('is blake2b-256 truncated to 20 bytes, not some other 20 bytes', () => {
    const [, publicKey, address] = VECTORS[0]!
    const expected = blake2b.create({ dkLen: 32 }).update(hexToBytes(publicKey)).digest().slice(0, 20)
    expect(bytesToHex(addressToBytes(parseAddress(address)))).toBe(bytesToHex(expected))
  })

  it('is NOT blake2b-512 truncated — the digest length changes the bytes', () => {
    const [, publicKey, address] = VECTORS[0]!
    const wrong = blake2b.create({ dkLen: 64 }).update(hexToBytes(publicKey)).digest().slice(0, 20)
    expect(bytesToHex(wrong)).not.toBe(bytesToHex(addressToBytes(parseAddress(address))))
  })

  it('produces addresses that parse, so a bad one cannot hide behind the codec', () => {
    for (const [, publicKey, address] of VECTORS) {
      expect(parseAddress(addressFromPublicKey(publicKey))).toBe(address)
    }
  })

  it('rejects a public key of the wrong length', () => {
    expect(() => addressFromPublicKey('00'.repeat(31))).toThrow(KeypairError)
    expect(() => addressFromPublicKey(new Uint8Array(33))).toThrow(/32 bytes/)
  })
})

describe('input forms all agree', () => {
  const [privateKey, , address] = VECTORS[0]!

  it('accepts hex, 0x-prefixed hex, uppercase hex and raw bytes alike', () => {
    const forms = [privateKey, `0x${privateKey}`, privateKey.toUpperCase(), hexToBytes(privateKey)]
    for (const form of forms) expect(keypairFromPrivateKey(form).address).toBe(address)
  })

  it('always reports the private key back as lowercase hex', () => {
    expect(keypairFromPrivateKey(privateKey.toUpperCase()).privateKey).toBe(privateKey)
  })

  it('rejects non-hex and wrong lengths', () => {
    expect(() => keypairFromPrivateKey('zz'.repeat(32))).toThrow(/hexadecimal/)
    expect(() => keypairFromPrivateKey('00'.repeat(31))).toThrow(/32 bytes/)
    expect(() => keypairFromPrivateKey(new Uint8Array(16))).toThrow(KeypairError)
  })
})

describe('generateKeypair', () => {
  it('is deterministic when the entropy is', () => {
    const fixed = (length: number) => new Uint8Array(length).fill(7)
    const a = generateKeypair(fixed)
    const b = generateKeypair(fixed)
    expect(a).toEqual(b)
    expect(a).toEqual(keypairFromPrivateKey('07'.repeat(32)))
  })

  it('returns a keypair whose address re-derives from its own private key', () => {
    const keypair = generateKeypair()
    expect(keypairFromPrivateKey(keypair.privateKey)).toEqual(keypair)
    expect(parseAddress(keypair.address)).toBe(keypair.address)
  })

  it('draws exactly 32 bytes', () => {
    let asked = -1
    generateKeypair((length) => {
      asked = length
      return new Uint8Array(length).fill(3)
    })
    expect(asked).toBe(PRIVATE_KEY_BYTES)
  })

  it('produces a different key every call', () => {
    const seen = new Set(Array.from({ length: 16 }, () => generateKeypair().privateKey))
    expect(seen.size).toBe(16)
  })

  it('refuses an all-zero seed, which means the entropy source is broken', () => {
    expect(() => generateKeypair((length) => new Uint8Array(length))).toThrow(/entropy/)
  })

  it('refuses a source that returns the wrong number of bytes', () => {
    expect(() => generateKeypair(() => new Uint8Array(16))).toThrow(/16 bytes/)
  })
})
