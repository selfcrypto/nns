/**
 * §8.3 proof documents, derived from a checkpoint's name records.
 *
 * Pure: records in, JSON-shaped objects out. Every hash and every tree walk
 * comes from `@nns/core` — this file only renders what core derives, and the
 * "done when" of `tasks/02-api.md` holds because a client verifies these
 * documents with core alone: rebuild the leaf with `encodeLeaf`/`leafHash`
 * from the fields, recombine with `verifyProof`, compare to the checkpoint's
 * `name_root`. No code here is in that path.
 *
 * The field names inside a proof document are §8.3's, verbatim — `delegate`,
 * `nimiq_height`, `leaf_index` — not this API's camelCase, because §8.3 is a
 * wire format shared with every other implementation. Hashes are `0x`-hex as
 * §8.3 prints them. `anchor` is `null` until `packages/anchor` exists and
 * publishes; the field is present so its shape is claimed now.
 *
 * A proof is served for whatever the checkpoint holds — including a `GRACE`
 * record: grace names are in the tree (§8.1), which is exactly what makes
 * non-inclusion prove `AVAILABLE` rather than merely not-`REGISTERED`.
 */

import {
  formatAddress,
  merkleNonInclusion,
  merkleProof,
  type MerkleProof,
  type NameRecord,
} from '@nns/core'

/** What proof derivation needs to know about the checkpoint it serves. */
export interface ProofContext {
  /** Name records at the checkpoint height, already verified to reproduce `rootHex`. */
  readonly records: ReadonlyMap<string, NameRecord>
  /** The checkpoint height — §8.3's `nimiq_height`. */
  readonly nimiqHeight: number
  /** `checkpoints.name_root`, bare lowercase hex. */
  readonly rootHex: string
}

const hex0x = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`

/**
 * One proven leaf: the record fields plus its path, §8.3's names.
 *
 * The document carries **every field the §8.1 leaf encodes**, because a client
 * re-derives the leaf hash from these fields and a proof whose leaf the
 * verifier cannot rebuild binds nothing. `delegate` and `evm` (r26) are the
 * fields that witness that rule now — `recovery` carried it until r20 deleted
 * the recovery address. See `docs/decisions.md`.
 */
function leafDocument(proof: MerkleProof): Record<string, unknown> {
  return {
    name: proof.record.name,
    owner: formatAddress(proof.record.owner),
    target: formatAddress(proof.record.target),
    evm: proof.record.evm,
    expiry: proof.record.expiry,
    status: proof.record.status,
    delegate: proof.record.host,
    leaf_index: proof.index,
    proof: proof.steps.map((step) => ({ hash: hex0x(step.hash), side: step.side })),
  }
}

/** The §8.3 inclusion document, or `null` when the name is not in the checkpoint tree. */
export function inclusionDocument(context: ProofContext, name: string): Record<string, unknown> | null {
  const proof = merkleProof({ names: context.records }, name)
  if (proof === null) return null
  return {
    ...leafDocument(proof),
    root: `0x${context.rootHex}`,
    nimiq_height: context.nimiqHeight,
    anchor: null,
  }
}

/**
 * The §8.3 non-inclusion document, or `null` when the name *is* in the
 * checkpoint tree — then there is nothing to prove absent.
 *
 * The bracketing leaves each carry their own proof; at the tree's edges a
 * single boundary leaf suffices, and on an empty tree both are `null` — the
 * root being 32 zero bytes is itself the proof.
 */
export function nonInclusionDocument(context: ProofContext, name: string): Record<string, unknown> | null {
  if (context.records.has(name)) return null
  const proof = merkleNonInclusion({ names: context.records }, name)
  return {
    kind: proof.kind,
    previous: 'previous' in proof ? leafDocument(proof.previous) : null,
    next: 'next' in proof ? leafDocument(proof.next) : null,
    root: `0x${context.rootHex}`,
    nimiq_height: context.nimiqHeight,
    anchor: null,
  }
}
