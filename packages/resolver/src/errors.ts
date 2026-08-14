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

/** §8.6 delegation failed — at the parent, or at the host. */
export class DelegateError extends ResolverError {
  override readonly name = 'DelegateError'

  constructor(code: 'PARENT_NOT_DELEGATING' | 'DELEGATE_FAILED', message: string) {
    super(code, message)
  }
}
