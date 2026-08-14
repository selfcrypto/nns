/**
 * Warnings — everything that must reach the user without stopping them.
 *
 * The line between a warning and a thrown error is §8.5's, and it is drawn
 * deliberately. A proof that fails, a root that conflicts, two resolvers with
 * different answers: those throw, because §8.5 #7 says halt. A proof that has
 * not been cut yet, a delegated answer, a root the client could not compare:
 * those warn, because the name works and telling a user something is *wrong*
 * with a name they just paid for is how you train them to ignore you (§8.7).
 *
 * Every warning is on the result. Nothing here is logged and forgotten, and
 * nothing is silently swallowed — a host app that renders none of them has
 * made that choice visibly.
 */

export type WarningCode =
  /**
   * The configured quorum is below `CONSTANTS.RESOLVER_QUORUM`. Rides on
   * **every** result, not just the first: §8.5 #2's second resolver is the
   * whole defence against a single party's internally-consistent proofs, and
   * a client running without it should say so every time it answers.
   */
  | 'QUORUM_BELOW_SPEC'
  /**
   * The agreeing resolvers were at different checkpoint heights, so their
   * roots could not be compared to each other. Lag, not conflict — but the
   * root half of §8.5 #2 did not happen, and that is worth saying.
   */
  | 'ROOT_HEIGHTS_DIFFER'
  /**
   * §8.7: no checkpoint proves this record yet. A **depth indicator, not a
   * warning** in the alarming sense — the name resolves and payments to it
   * work. Render it as pending depth; §8.5 #5 is explicit that alarming
   * language here is a mistake.
   */
  | 'PROOF_PENDING'
  /**
   * A proof verified, but for a different target than the live answer — an
   * `S` landed since the checkpoint. The answer is not the proven one, so the
   * result is reported as pending depth rather than proven.
   */
  | 'TARGET_CHANGED_SINCE_CHECKPOINT'
  /** The delegate host used came from the live record, not from the proven one. */
  | 'DELEGATE_HOST_UNPROVEN'
  /**
   * §8.5 #6: this answer came from a delegate host and carries no
   * cryptographic guarantee. The parent's ownership is proven; the answer is
   * not. It MUST be visually distinguished from a verified result.
   */
  | 'DELEGATED_ANSWER'
  /**
   * §8.5 #1 did not run: no anchor publishers are configured, so the agreed
   * root was never compared against Ethereum. Present on every result until
   * the anchor reader ships, so the gap is loud rather than assumed closed.
   */
  | 'ANCHOR_NOT_CHECKED'

export interface ResolveWarning {
  readonly code: WarningCode
  readonly detail: string
}

export const warn = (code: WarningCode, detail: string): ResolveWarning => ({ code, detail })
