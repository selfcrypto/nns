/**
 * Verification. The whole point of the package.
 *
 * **No protocol rule is restated here.** The leaf preimage is
 * `core.leafHash`, which is §8.1's encoding; the recombination is
 * `core.verifyProof`, which is §8.1's node hashing; the ordering is
 * `core.compareNames`, which is §8.1's sort. This file contributes exactly
 * one thing core cannot: the decision about *which* of those to call for a
 * given document, and what the answer means. That is policy, and policy is
 * this package's job.
 *
 * Every failure throws {@link ProofError}. There is no "probably fine" path —
 * a document that does not verify is discarded, per §8.5 #7's alarm-and-halt.
 *
 * ## Why non-inclusion is checkable at all
 *
 * §8.3 proves a name absent by returning the leaves that lexicographically
 * bracket it. That is only a proof if three things hold, and all three are
 * checked below:
 *
 * 1. each bracketing leaf is itself in the tree — its own proof recombines to
 *    the same root;
 * 2. the bracket really brackets — `previous < name < next` under §8.1's
 *    bytewise order;
 * 3. nothing fits between the brackets — the two leaves are **adjacent**,
 *    `next.index === previous.index + 1`.
 *
 * Drop (3) and the "proof" shows only that two leaves exist somewhere in the
 * tree, which is compatible with the name sitting between them.
 *
 * At the tree's edges there is only one bracketing leaf, and §8.3 says the
 * proof path itself shows that leaf is the extreme one. It does, and here is
 * the argument that makes it checkable rather than assertable. `side` in a
 * §8.1 step names the side the **sibling** sits on. A leftmost node is the
 * left child at every level it has a sibling at, so every step reads
 * `right`. A rightmost node is either a right child — sibling on the `left` —
 * or an odd node promoted unchanged, which contributes no step at all; so
 * every step it does have reads `left`. Hence "all steps `right`" *is*
 * leftmost and "all steps `left`" *is* rightmost, and a server cannot claim
 * an edge case it is not in without producing a path that fails to
 * recombine.
 */

import { compareNames, leafHash, verifyProof, type NameRecord } from '@nns/core'

import { toHex as hex, type InclusionDocument, type NonInclusionDocument, type ProvenLeaf } from './documents.js'
import { ProofError } from './errors.js'

/**
 * Rebuild the leaf from the document's own fields and recombine it through
 * the document's own steps. Returns the record it proves.
 *
 * `root` comes from the caller, not from the leaf: on a non-inclusion
 * document the bracketing leaves must both prove against the *document's*
 * root, and letting each leaf carry its own would make two unrelated proofs
 * look like one.
 */
function verifyLeaf(leaf: ProvenLeaf, root: Uint8Array, where: string): NameRecord {
  const hash = leafHash(leaf.record)
  if (!verifyProof(hash, leaf.steps, root)) {
    throw new ProofError(
      `${where}: the leaf for "${leaf.record.name}" does not recombine to root 0x${hex(root)} — ` +
        'the served fields are bound to nothing',
    )
  }

  // `leaf_index` travels with the proof (§8.3) and non-inclusion adjacency is
  // computed from it, so it cannot be taken on faith. A node at an odd
  // position always has a sibling to its left — no promotion is possible —
  // which pins the parity of the index against the first step. An even index
  // is not checkable the same way: an even node may be the promoted odd one
  // out, and then the level contributes no step at all.
  const first = leaf.steps[0]
  if (leaf.index % 2 === 1 && (first === undefined || first.side !== 'left')) {
    throw new ProofError(`${where}: leaf_index ${leaf.index} is odd, so its first sibling must be on the left`)
  }

  return leaf.record
}

/**
 * An inclusion document proves `name`. Returns the record it proves — which
 * is the record **at the checkpoint**, and may lag the live answer served
 * beside it (§8.7). Reconciling those two is the caller's job.
 */
export function verifyInclusion(document: InclusionDocument, name: string): NameRecord {
  if (document.leaf.record.name !== name) {
    throw new ProofError(
      `proof is for "${document.leaf.record.name}", not "${name}" — a valid proof of the wrong thing`,
    )
  }
  return verifyLeaf(document.leaf, document.root, 'inclusion proof')
}

/** All steps sit on one side — the test for a leftmost or rightmost leaf. See the module note. */
const allSidesAre = (leaf: ProvenLeaf, side: 'left' | 'right'): boolean =>
  leaf.steps.every((step) => step.side === side)

/**
 * A non-inclusion document proves `name` absent from the tree the root
 * commits to.
 *
 * Because grace names are in the tree (§8.1), absence proves `AVAILABLE` —
 * not merely not-`REGISTERED`. That is the property §8.5 leans on before a
 * user pays to register.
 */
export function verifyNonInclusion(document: NonInclusionDocument, name: string): void {
  const { previous, next, root } = document

  if (previous === null && next === null) {
    // The empty tree. §8.1 makes its root 32 zero bytes, and that root is
    // itself the proof: no leaf exists, so no leaf can be produced.
    if (!root.every((byte) => byte === 0)) {
      throw new ProofError(
        `non-inclusion claims an empty tree, but the root is 0x${hex(root)} rather than 32 zero bytes`,
      )
    }
    return
  }

  if (previous !== null) {
    verifyLeaf(previous, root, 'non-inclusion (previous)')
    if (compareNames(previous.record.name, name) >= 0) {
      throw new ProofError(
        `non-inclusion: "${previous.record.name}" does not sort before "${name}", so it brackets nothing`,
      )
    }
  }

  if (next !== null) {
    verifyLeaf(next, root, 'non-inclusion (next)')
    if (compareNames(name, next.record.name) >= 0) {
      throw new ProofError(
        `non-inclusion: "${next.record.name}" does not sort after "${name}", so it brackets nothing`,
      )
    }
  }

  if (previous === null && next !== null) {
    // Claimed: nothing sorts before `next`. Checkable: `next` is the leftmost
    // leaf, which its own path shows.
    if (next.index !== 0 || !allSidesAre(next, 'right')) {
      throw new ProofError(
        `non-inclusion claims "${name}" sorts before every leaf, but "${next.record.name}" is not the leftmost leaf`,
      )
    }
    return
  }

  if (next === null && previous !== null) {
    if (!allSidesAre(previous, 'left')) {
      throw new ProofError(
        `non-inclusion claims "${name}" sorts after every leaf, but "${previous.record.name}" is not the rightmost leaf`,
      )
    }
    return
  }

  // Both present: the brackets must be adjacent, or the gap they describe is
  // wide enough to hold the name they claim it does not.
  if (previous !== null && next !== null && next.index !== previous.index + 1) {
    throw new ProofError(
      `non-inclusion: leaves ${previous.index} and ${next.index} are not adjacent, so "${name}" could sit between them`,
    )
  }
}
