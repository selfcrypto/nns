/**
 * Off-chain message signing, verified: "this address said this".
 *
 * Nothing here is protocol. No root, no log line and no verdict depends on
 * it; it exists because a service outside the protocol (`packages/notify`)
 * needs an address to prove it is behind a request, and the wallets already
 * sign arbitrary text — the Hub through `signMessage`, Nimiq Pay through the
 * mini app SDK's `sign()`. The verification is here rather than in that
 * service for the same reason the address derivation is: it is a byte layout
 * every consumer must agree on, and `core` is where those live.
 *
 * ## The convention
 *
 * The Nimiq wallets do not sign the text itself. They sign
 *
 *     sha256( "\x16Nimiq Signed Message:\n" ‖ decimal(len(message)) ‖ message )
 *
 * — the prefix so a signed message can never be mistaken for a transaction or
 * any other Nimiq structure, the length so two messages cannot share a
 * digest by concatenation, and the hash so the signer's device signs 32
 * bytes whatever the text's size. `HubApi.MSG_PREFIX` is that prefix, and
 * the Keyguard's `SignMessage` request is the reference. That is the
 * `'nimiq'` convention.
 *
 * Nimiq Pay's `sign()` is typed but undocumented, and its provider descends
 * from a different code base, so it may sign the raw bytes instead. Rather
 * than guess, {@link verifySignedMessage} takes the list of conventions to
 * try and reports which one the signature satisfies; the `'raw'` convention
 * is the Ed25519 signature over the message bytes with no prefix and no
 * hash. A caller that has pinned the wallet's behaviour passes one; a probe
 * passes both and learns.
 *
 * ## Purity
 *
 * Every function is a pure function of its arguments. {@link signMessage}
 * takes the private key it signs with; nothing here draws randomness.
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

import type { Address } from './address.js'
import { addressFromPublicKey, privateKeyBytes, type KeyInput } from './keypair.js'

/** `HubApi.MSG_PREFIX`: what every Nimiq wallet prepends before hashing. */
export const SIGNED_MESSAGE_PREFIX = '\x16Nimiq Signed Message:\n'

/** An Ed25519 signature is 64 bytes. */
export const SIGNATURE_BYTES = 64

export type SignedMessageConvention = 'nimiq' | 'raw'

/** Try the wallet convention first; a probe of an unknown signer tries both. */
export const SIGNED_MESSAGE_CONVENTIONS: readonly SignedMessageConvention[] = ['nimiq', 'raw']

export class SignedMessageError extends Error {
  override readonly name = 'SignedMessageError'
}


const messageBytes = (message: string | Uint8Array): Uint8Array =>
  typeof message === 'string' ? utf8ToBytes(message) : message

function toBytes(input: KeyInput, expected: number, what: string): Uint8Array {
  if (typeof input === 'string') {
    const s = input.startsWith('0x') || input.startsWith('0X') ? input.slice(2) : input
    if (s.length !== expected * 2 || !/^[0-9a-fA-F]*$/.test(s)) {
      throw new SignedMessageError(`${what} must be ${expected} bytes of hex, got ${JSON.stringify(input)}`)
    }
    return hexToBytes(s.toLowerCase())
  }
  if (input.length !== expected) throw new SignedMessageError(`${what} must be ${expected} bytes, got ${input.length}`)
  return input
}

/**
 * The 32 bytes a Nimiq wallet signs for a message: the prefix, the byte
 * length in decimal ASCII, the message, through SHA-256.
 */
export function signedMessageDigest(message: string | Uint8Array): Uint8Array {
  const body = messageBytes(message)
  const head = utf8ToBytes(`${SIGNED_MESSAGE_PREFIX}${body.length}`)
  const data = new Uint8Array(head.length + body.length)
  data.set(head, 0)
  data.set(body, head.length)
  return sha256(data)
}

/** What Ed25519 is asked to sign under each convention. */
const signedBytes = (message: string | Uint8Array, convention: SignedMessageConvention): Uint8Array =>
  convention === 'nimiq' ? signedMessageDigest(message) : messageBytes(message)

/**
 * Sign a message as a wallet would. Pure; for tests, tooling and the probe
 * page's self-check — a service verifying signatures never holds a key.
 * Returns the 64-byte signature as lowercase hex.
 */
export function signMessage(
  privateKey: KeyInput,
  message: string | Uint8Array,
  convention: SignedMessageConvention = 'nimiq',
): string {
  return bytesToHex(ed25519.sign(signedBytes(message, convention), privateKeyBytes(privateKey)))
}

export interface VerifiedMessage {
  /** The address the public key derives to — the signer. */
  readonly address: Address
  /** Lowercase hex, as given. */
  readonly publicKey: string
  /** Which convention the signature satisfied. */
  readonly convention: SignedMessageConvention
}

/**
 * Verify a signature over a message and name the signer.
 *
 * Returns `null` when the signature satisfies none of the conventions tried,
 * and throws only for malformed inputs — a key or signature of the wrong
 * size is a caller bug, not a failed verification. The conventions are tried
 * in the order given, so a caller that knows its wallet passes exactly one
 * and a mismatch is a plain `null`.
 */
export function verifySignedMessage(
  message: string | Uint8Array,
  publicKey: KeyInput,
  signature: KeyInput,
  conventions: readonly SignedMessageConvention[] = SIGNED_MESSAGE_CONVENTIONS,
): VerifiedMessage | null {
  const pk = toBytes(publicKey, 32, 'a public key')
  const sig = toBytes(signature, SIGNATURE_BYTES, 'a signature')
  for (const convention of conventions) {
    let ok = false
    try {
      ok = ed25519.verify(sig, signedBytes(message, convention), pk)
    } catch {
      ok = false
    }
    if (ok) return { address: addressFromPublicKey(pk), publicKey: bytesToHex(pk), convention }
  }
  return null
}
