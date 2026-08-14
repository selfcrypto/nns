/**
 * Typed failures.
 *
 * The distinction this file exists to keep sharp is §8.7's: a **missing**
 * proof is not a **bad** proof. A resolver that has not reached the next
 * checkpoint serves `proof: null`, which is depth pending and a normal
 * answer; a resolver that serves a proof which does not recombine to its own
 * root is either broken or lying, and that is a hard failure. The first never
 * throws. The second always throws {@link ProofError}.
 */

// Type-only: erased at compile time, so it adds nothing to a bundle and
// nothing to the reader's import graph (`browser-safety.test.ts` skips
// `import type` for exactly this reason).
import type { AnchorCheck } from '@nns/anchor/reader'

export type ResolverErrorCode =
  /** The query is not a valid §4.1 name or §4.4 dotted query. */
  | 'NAME_INVALID'
  /** No resolver could be reached, or fewer than `quorum` answered. */
  | 'QUORUM_UNMET'
  /** Resolvers answered, and gave different answers (§8.5 #2). */
  | 'QUORUM_DISAGREEMENT'
  /** Two resolvers published different roots for the same checkpoint height (§8.5 #1). */
  | 'QUORUM_ROOT_MISMATCH'
  /** A served document is not the shape §8.3 fixes. */
  | 'DOCUMENT_MALFORMED'
  /** A served proof does not verify. Never returned as a result — always thrown. */
  | 'PROOF_INVALID'
  /** The name has no record. */
  | 'NOT_FOUND'
  /** The name exists but is in `GRACE`, where §7.3 turns resolution off. */
  | 'IN_GRACE'
  /**
   * A resolver's own `/checkpoints/{height}` document contradicts the proof it
   * served, or itself: its `nameRoot` is not the root the proof verified
   * against, or §8.1 over its own six components is not the `commitment` it
   * claims. One party, two states — nothing it serves can be tied to an anchor.
   */
  | 'CHECKPOINT_BINDING_INVALID'
  /**
   * Listed publishers anchored a different commitment for this checkpoint than
   * the resolver served (§8.5 #3, #7). The resolver's state is not the state
   * that was anchored, and §8.5 says stop rather than prefer one.
   */
  | 'ANCHOR_MISMATCH'
  /**
   * Listed publishers anchored **conflicting** commitments at one height
   * (§8.5 #7). The parties this client trusts to agree do not, and the client
   * has no basis to pick between them.
   */
  | 'ANCHOR_DIVERGENCE'
  /** A dotted query whose parent is not `REGISTERED` or sets no delegate host (§8.6). */
  | 'PARENT_NOT_DELEGATING'
  /** The delegate host failed, or answered with something that is not §8.6's shape. */
  | 'DELEGATE_FAILED'
  /** The resolver was constructed with a list that cannot meet its own quorum. */
  | 'CONFIGURATION'

export class ResolverError extends Error {
  override readonly name: string = 'ResolverError'
  readonly code: ResolverErrorCode

  constructor(code: ResolverErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** The query never reached the network: it is not a name or a dotted query. */
export class NameError extends ResolverError {
  override readonly name = 'NameError'
}

/** Configuration that cannot satisfy its own policy — thrown from the constructor. */
export class ConfigurationError extends ResolverError {
  override readonly name = 'ConfigurationError'

  constructor(message: string) {
    super('CONFIGURATION', message)
  }
}

/** One resolver's reply, as it arrived. Carried by {@link QuorumError} so a caller can show which party said what. */
export interface ResolverReply {
  /** The configured label for the endpoint, so error text names a party rather than a URL. */
  readonly resolver: string
  /** A one-line rendering of what this resolver answered, or why it did not. */
  readonly answer: string
}

/**
 * Quorum was not met, or was met and the parties disagreed.
 *
 * §8.5 #2 is explicit that disagreement stops resolution: never silently
 * prefer one. The replies ride along so the app can say which resolver said
 * what, which is the difference between an alarm a user can act on and one
 * they learn to dismiss.
 */
export class QuorumError extends ResolverError {
  override readonly name = 'QuorumError'
  readonly replies: readonly ResolverReply[]

  constructor(code: 'QUORUM_UNMET' | 'QUORUM_DISAGREEMENT' | 'QUORUM_ROOT_MISMATCH', message: string, replies: readonly ResolverReply[]) {
    super(code, message)
    this.replies = replies
  }
}

/** A served document is not §8.3's shape. `path` points at the offending field. */
export class DocumentError extends ResolverError {
  override readonly name = 'DocumentError'
  readonly path: string

  constructor(path: string, message: string) {
    super('DOCUMENT_MALFORMED', `${path}: ${message}`)
    this.path = path
  }
}

/**
 * A proof was served and does not hold.
 *
 * This is the hard failure of the whole package. It means a document whose
 * leaf we rebuilt from its own fields did not recombine, through its own
 * steps, to the root it claims — so the fields next to it are bound to
 * nothing. There is no degraded mode: the answer is discarded.
 */
export class ProofError extends ResolverError {
  override readonly name = 'ProofError'

  constructor(message: string) {
    super('PROOF_INVALID', message)
  }
}

/** The name resolves to nothing: absent, or in `GRACE` where §7.3 turns resolution off. */
export class LookupError extends ResolverError {
  override readonly name = 'LookupError'

  constructor(code: 'NOT_FOUND' | 'IN_GRACE', message: string) {
    super(code, message)
  }
}

/**
 * §8.5 #1's tier failed hard: the anchored commitment and the served
 * checkpoint are not the same value, or the listed publishers contradict each
 * other.
 *
 * These halt for the same reason a bad proof does. The tempting alternative is
 * to report "anchor mismatch" as a warning beside an answer that verified
 * locally — but a resolver whose checkpoint nobody anchored is either on a
 * fork or lying, and both are exactly what this tier exists to catch. §8.5 #7
 * says stop and warn, never silently prefer one.
 *
 * The reader's own typed answer rides along as `check` when there was one, so
 * an app can show which publishers said what.
 */
export class AnchorError extends ResolverError {
  override readonly name = 'AnchorError'
  /** The `@nns/anchor/reader` verdict behind this failure, when the reader produced one. */
  readonly check: AnchorCheck | null

  constructor(
    code: 'CHECKPOINT_BINDING_INVALID' | 'ANCHOR_MISMATCH' | 'ANCHOR_DIVERGENCE',
    message: string,
    check: AnchorCheck | null = null,
  ) {
    super(code, message)
    this.check = check
  }
}

/** §8.6 delegation failed — at the parent, or at the host. */
export class DelegateError extends ResolverError {
  override readonly name = 'DelegateError'

  constructor(code: 'PARENT_NOT_DELEGATING' | 'DELEGATE_FAILED', message: string) {
    super(code, message)
  }
}
