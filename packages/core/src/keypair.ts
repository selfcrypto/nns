/**
 * Offline Ed25519 keypair generation and Nimiq address derivation.
 *
 * A Nimiq address is the first 20 bytes of `blake2b-256(publicKey)`, rendered
 * through the base32 + IBAN codec in `address.ts`. That derivation is a pure
 * function of the public key, so it belongs here alongside the rest of the
 * protocol's byte layouts rather than in a tool that happens to need a key.
 *
 * Implemented on `@noble/curves` and `@noble/hashes` rather than `@nimiq/core`
 * for the reason `address.ts` gives: that package drags WASM into a component
 * whose whole contract is purity. Both noble packages are audited, dependency
 * free, and already the source of this package's keccak.
 *
 * ## Why "offline" is the point
 *
 * The alternative is asking a node to make a key with `createAccount`, which
 * puts the only copy inside that node's wallet and returns it over HTTP. If
 * the node exposes no export call, funds sent to such an address are
 * unrecoverable. Deriving locally means the key exists where you decided it
 * should exist, and the address can be checked before anything is sent to it.
 *
 * ## Purity
 *
 * This package's contract is "no I/O, no clock, no randomness", and everything
 * here honours it **except** {@link generateKeypair}, which needs entropy by
 * definition. The impurity is confined to that one function and its source is
 * a parameter, so a caller that wants determinism — a test, or a vector
 * generator — supplies its own bytes and gets a pure function back. Every
 * derivation step is exposed separately and is pure.
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import { blake2b } from '@noble/hashes/blake2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

import { ADDRESS_BYTES, addressFromBytes, type Address } from './address.js'

/** An Ed25519 private key is a 32-byte seed. */
export const PRIVATE_KEY_BYTES = 32
/** An Ed25519 public key is a 32-byte compressed point. */
export const PUBLIC_KEY_BYTES = 32

export class KeypairError extends Error {
  override readonly name = 'KeypairError'
}

const fail = (message: string): never => {
  throw new KeypairError(message)
}

/**
 * A keypair and the address it controls.
 *
 * Keys are lowercase hex because that is the form every consumer wants: the
 * RPC's `importRawKey` takes hex, and a key file holds text. Call
 * {@link privateKeyBytes} if you need the raw bytes back.
 */
export interface Keypair {
  /** 32-byte Ed25519 seed, 64 lowercase hex characters. **Secret.** */
  readonly privateKey: string
  /** 32-byte Ed25519 public key, 64 lowercase hex characters. */
  readonly publicKey: string
  /** The address the private key controls, compact 36-character form. */
  readonly address: Address
}

/** Accept either form on input, so callers need not convert first. */
export type KeyInput = string | Uint8Array

function toBytes(input: KeyInput, expected: number, what: string): Uint8Array {
  if (typeof input === 'string') {
    const s = input.startsWith('0x') || input.startsWith('0X') ? input.slice(2) : input
    if (s.length !== expected * 2) {
      fail(`${what} must be ${expected} bytes (${expected * 2} hex characters), got ${s.length}`)
    }
    if (!/^[0-9a-fA-F]*$/.test(s)) fail(`${what} is not hexadecimal`)
    return hexToBytes(s.toLowerCase())
  }
  if (input.length !== expected) {
    fail(`${what} must be ${expected} bytes, got ${input.length}`)
  }
  return input
}

/** The raw 32 bytes of a hex private key. */
export const privateKeyBytes = (privateKey: KeyInput): Uint8Array =>
  toBytes(privateKey, PRIVATE_KEY_BYTES, 'a private key')

/** Ed25519 public key for a private key. Pure. */
export function publicKeyFromPrivateKey(privateKey: KeyInput): string {
  return bytesToHex(ed25519.getPublicKey(privateKeyBytes(privateKey)))
}

/**
 * **The derivation.** `blake2b-256(publicKey)[0..20]`, then the base32 + IBAN
 * check digits of `address.ts`. Pure.
 *
 * The truncation is why the hash length matters: blake2b is parameterised by
 * output length and `blake2b-512(pk)[0..20]` is a *different* 20 bytes than
 * `blake2b-256(pk)[0..20]`, because the digest length is mixed into the
 * initial state. Getting this wrong produces a well-formed address — correct
 * checksum, correct alphabet, parses cleanly — that nobody holds the key to.
 */
export function addressFromPublicKey(publicKey: KeyInput): Address {
  const pk = toBytes(publicKey, PUBLIC_KEY_BYTES, 'a public key')
  const digest = blake2b.create({ dkLen: 32 }).update(pk).digest()
  return addressFromBytes(digest.slice(0, ADDRESS_BYTES))
}

/** Everything derivable from a private key. Pure — the vector-pinned path. */
export function keypairFromPrivateKey(privateKey: KeyInput): Keypair {
  const sk = privateKeyBytes(privateKey)
  const publicKey = bytesToHex(ed25519.getPublicKey(sk))
  return {
    privateKey: bytesToHex(sk),
    publicKey,
    address: addressFromPublicKey(publicKey),
  }
}

/** Source of 32 random bytes. Injected so the rest of this file stays pure. */
export type RandomBytes = (length: number) => Uint8Array

/**
 * `crypto.getRandomValues`, reached through a narrow structural type rather
 * than a global.
 *
 * `core` is consumed by `packages/app` in a browser and by Node elsewhere, so
 * it cannot import `node:crypto` and cannot assume DOM lib types. Web Crypto is
 * present in both (Node ≥ 19, every browser), but its ambient typing differs
 * between the two, so the cast describes only the one method we call.
 */
const platformRandomBytes: RandomBytes = (length) => {
  const webcrypto = (globalThis as {
    crypto?: { getRandomValues?: <T extends ArrayBufferView>(array: T) => T }
  }).crypto
  if (typeof webcrypto?.getRandomValues !== 'function') {
    return fail('no Web Crypto available on this platform: pass randomBytes explicitly')
  }
  return webcrypto.getRandomValues(new Uint8Array(length))
}

/**
 * Generate a fresh keypair.
 *
 * **The only function in `@nns/core` that is not a pure function of its
 * arguments** — see the note at the top of this file. `randomBytes` defaults
 * to the platform CSPRNG (`crypto.getRandomValues`, present in Node ≥ 19 and
 * every browser); pass your own to make the call deterministic.
 *
 * The result is verified before it is returned: the derived address must
 * round-trip through {@link keypairFromPrivateKey}. A keypair is not something
 * you find out was wrong later.
 */
export function generateKeypair(randomBytes?: RandomBytes): Keypair {
  const draw: RandomBytes = randomBytes ?? platformRandomBytes

  const seed = draw(PRIVATE_KEY_BYTES)
  if (seed.length !== PRIVATE_KEY_BYTES) {
    fail(`randomBytes returned ${seed.length} bytes, expected ${PRIVATE_KEY_BYTES}`)
  }
  // An all-zero seed is a valid Ed25519 key mathematically, and a sign the
  // entropy source is broken. Refusing costs nothing at 2^-256.
  if (seed.every((b) => b === 0)) fail('randomBytes returned all zeros; entropy source is broken')

  const keypair = keypairFromPrivateKey(seed)
  if (keypairFromPrivateKey(keypair.privateKey).address !== keypair.address) {
    fail('derivation is not self-consistent; refusing to return this keypair')
  }
  return keypair
}
