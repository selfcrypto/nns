/**
 * Sign-in: a challenge the wallet signs, and its verification.
 *
 * The text is plain and says what it is for, so a signed challenge can never
 * be replayed as consent to anything else — it names this service's host,
 * the address, a nonce and an expiry, and nothing a transaction or another
 * service would ever ask anyone to sign. Verification is `core`'s
 * (`verifySignedMessage`); this file only decides what is signed and what
 * "the right signer" means.
 */

import { formatAddress, tryParseAddress, verifySignedMessage, type SignedMessageConvention } from '@nimiqnames/core'

export const CHALLENGE_TTL_MS = 10 * 60_000

/** The canonical spaced form, or null. Every address in this service goes through here. */
export function canonicalAddress(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const parsed = tryParseAddress(input.trim())
  return parsed === null ? null : formatAddress(parsed)
}

export function challengeText(address: string, host: string, nonce: string, validUntil: Date): string {
  return `NNS notifications for ${address} on ${host}. Nonce ${nonce}. Valid until ${validUntil.toISOString()}.`
}

export type ChallengeVerdict =
  | { readonly ok: true; readonly address: string; readonly convention: SignedMessageConvention }
  | { readonly ok: false; readonly reason: 'BAD_SIGNATURE' }
  | { readonly ok: false; readonly reason: 'ADDRESS_MISMATCH'; readonly signer: string }

/**
 * Whether `signature` is `address`'s signature over `text`.
 *
 * A valid signature from a different key is reported with the signer, so the
 * app can offer to sign in as that address instead: Nimiq Pay chooses which
 * of its addresses signs and the app cannot overrule it.
 */
export function verifyChallenge(
  text: string,
  address: string,
  publicKey: string,
  signature: string,
  conventions: readonly SignedMessageConvention[],
): ChallengeVerdict {
  let verified
  try {
    verified = verifySignedMessage(text, publicKey, signature, conventions)
  } catch {
    return { ok: false, reason: 'BAD_SIGNATURE' }
  }
  if (verified === null) return { ok: false, reason: 'BAD_SIGNATURE' }
  const signer = formatAddress(verified.address)
  if (signer !== address) return { ok: false, reason: 'ADDRESS_MISMATCH', signer }
  return { ok: true, address: signer, convention: verified.convention }
}
