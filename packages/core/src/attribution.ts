/**
 * §7.2's **effective sender** — ownership follows the authorizing key, not
 * the account container (r25).
 *
 * "Owner = the sending account" silently assumed accounts and keys are the
 * same thing. Nimiq Pay broke the assumption in production: it keeps its
 * spendable balance in an HTLC — the "Remote wallet" — signs every mini-app
 * transaction from it, and destroys the contract routinely (a 14-day cycle,
 * and immediately when the user presses Recover). An emptied contract is
 * pruned, and the pruned address has no key and never can: contract
 * addresses derive from the creation transaction, not a keypair. A name
 * registered through Pay was orphaned on mainnet 99 minutes after
 * registration (`nimiqpaytest`, 2026-08-21).
 *
 * The durable key signs every one of those transactions anyway. An HTLC
 * early-resolve is invalid without the contract sender's signature, the
 * contract sender is the user's persistent Local wallet, and the signature
 * travels in the transaction's own proof — decoded from that registration:
 *
 *     G nimiqpaytest, block 59,516,314 — proof 0x01 (EarlyResolve),
 *       sig 1: NQ14… (Nimiq's co-signer)   sig 2: NQ88… (the Local wallet)
 *
 * So attribution needs nothing beyond the NNS-bearing transaction itself —
 * no account lookups (the contract is pruned; state queries do not replay),
 * no new message type, no payload bytes. That self-containment is what makes
 * the rule deterministic: two implementations replaying the same
 * transactions parse the same proof bytes. Proven by replay before adoption:
 * the affected mainnet range re-derived the orphaned name to the Local
 * wallet with every other name byte-identical (decisions.md, "Ownership
 * follows the authorizing key").
 *
 * ── The parsing contract (§7.2) ──────────────────────────────────────────
 *
 * Byte-exact and deliberately brittle: anything that is not one of the two
 * pinned shapes answers null, and null means "attribute to the account,
 * exactly as before r25". A parser that guesses at unrecognised layouts is a
 * consensus divergence waiting to happen; one that refuses them degrades to
 * the prior rule. If Nimiq's serialization changes at a future fork, a
 * revision pins the new shapes — this file never guesses at them.
 *
 * Nimiq PoS HTLC proof (core-rs-albatross `OutgoingHTLCTransactionProof`):
 *
 *   0x01 EarlyResolve    { sigproof(recipient), sigproof(sender) } — 197 bytes
 *   0x02 TimeoutResolve  { sigproof(sender) }                      —  99 bytes
 *   0x00 RegularTransfer { …hash preimage…, sigproof(recipient) }  — not attributed
 *
 * where a SignatureProof is `0x00` (Ed25519, no flags, no WebAuthn fields),
 * a 32-byte public key, `0x00` (empty merkle path), a 64-byte signature —
 * 98 bytes. The **sender** signature is the authorizer: EarlyResolve's is the
 * second, TimeoutResolve's is the only one. RegularTransfer is a hash-lock
 * claim by the counterparty — the contract funder authorized nothing — so it
 * stays account-attributed.
 *
 * NOT verified here: the signatures themselves. The chain already did that —
 * an invalid proof never reaches a block, so inclusion is the verification.
 * Re-verifying ed25519 in the reducer would buy nothing and cost a
 * dependency on transaction serialization.
 */

import { addressFromPublicKey } from './keypair.js'
import type { Address } from './address.js'

/** Nimiq account type for HTLC contracts, as the RPC's `fromType` reports it. */
export const SENDER_TYPE_HTLC = 2

const SIGPROOF_BYTES = 98
const EARLY_RESOLVE_BYTES = 1 + 2 * SIGPROOF_BYTES
const TIMEOUT_RESOLVE_BYTES = 1 + SIGPROOF_BYTES

/**
 * The public key of one strict Ed25519 SignatureProof, or null if these bytes
 * are any other shape.
 */
function sigproofPublicKey(proof: Uint8Array, offset: number): Uint8Array | null {
  // Type/flags byte: 0x00 is Ed25519 with no flags. Anything else (ES256,
  // WebAuthn flags) changes the layout, so no fixed offset below is safe.
  if (proof[offset] !== 0x00) return null
  // Empty merkle path — a multisig proof would put a tree here.
  if (proof[offset + 33] !== 0x00) return null
  return proof.subarray(offset + 1, offset + 33)
}

/**
 * The address whose key authorized this HTLC spend, or null when the proof is
 * not one of the two attributable shapes. Null always means "fall back to the
 * account sender" — never an error, never a forfeit.
 */
export function htlcAuthorizer(proofHex: string): Address | null {
  if (proofHex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(proofHex)) return null
  const proof = new Uint8Array(proofHex.length / 2)
  for (let index = 0; index < proof.length; index += 1) {
    proof[index] = Number.parseInt(proofHex.slice(index * 2, index * 2 + 2), 16)
  }

  // EarlyResolve: recipient's signature first, sender's second. The sender —
  // the key that funded the contract and still exists after it is pruned —
  // is the authorizer.
  if (proof[0] === 0x01 && proof.length === EARLY_RESOLVE_BYTES) {
    const publicKey = sigproofPublicKey(proof, 1 + SIGPROOF_BYTES)
    return publicKey === null ? null : addressFromPublicKey(publicKey)
  }
  // TimeoutResolve: the sender alone.
  if (proof[0] === 0x02 && proof.length === TIMEOUT_RESOLVE_BYTES) {
    const publicKey = sigproofPublicKey(proof, 1)
    return publicKey === null ? null : addressFromPublicKey(publicKey)
  }
  return null
}

/**
 * The address a transaction's messages are attributed to under the
 * experimental rule: the account sender, unless the sender is an HTLC whose
 * proof names its authorizing key.
 *
 * Applied once, at the top of `reduce()` — every owner check, WRONG_SENDER
 * check and refund obligation downstream then uses the attributed address
 * without knowing this rule exists. Refunds in particular *must* follow it: a
 * refund paid to a pruned contract's address is burned, since nobody can ever
 * sign for it.
 */
export function effectiveSender(tx: {
  readonly sender: Address
  readonly senderType?: number
  readonly proof?: string
}): Address {
  if (tx.senderType !== SENDER_TYPE_HTLC || tx.proof === undefined) return tx.sender
  return htlcAuthorizer(tx.proof) ?? tx.sender
}
