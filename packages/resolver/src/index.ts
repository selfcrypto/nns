/**
 * @nns/resolver — client-side NNS resolution.
 *
 * Quorum across independent resolvers, §8.3 proof verification against
 * `@nns/core`, and §8.6 delegated resolution for dotted queries. No protocol
 * rule is implemented here: every rule this package applies is core's, and
 * what it adds is transport and policy around them.
 *
 * Adoption is a security property, not distribution (§2.2): an app that
 * ships its own bundle is outside our frontend's reach, so the verification
 * it performs has to be the verification this package performs.
 */

export {
  NnsResolver,
  createResolver,
  resolve,
  type AvailableResult,
  type QuorumReport,
  type ResolveResult,
  type ResolverOptions,
  type Verification,
} from './resolve.js'

export { MAX_DELEGATE_TTL_SEC, type DelegateInfo } from './delegate.js'

export type { CheckpointRef } from './quorum.js'

export type { HttpFetch, HttpResponse, ResolverEndpoint } from './transport.js'

export { warn, type ResolveWarning, type WarningCode } from './warnings.js'

export {
  ConfigurationError,
  DelegateError,
  DocumentError,
  LookupError,
  NameError,
  ProofError,
  QuorumError,
  ResolverError,
  type ResolverErrorCode,
  type ResolverReply,
} from './errors.js'

// The document readers and the verifiers are exported deliberately. An
// integrator that fetches a §8.3 document by some other route — a cached
// response, a proof handed over in a QR code, a second implementation's
// output — must be able to run the same check against it rather than write
// their own, which would be the one place a divergence could enter.
export {
  readAvailableResponse,
  readInclusionDocument,
  readNonInclusionDocument,
  readResolveResponse,
  toHex,
  type AvailableResponse,
  type DelegateResponse,
  type InclusionDocument,
  type NonInclusionDocument,
  type ProvenLeaf,
  type ResolveResponse,
} from './documents.js'

export { verifyInclusion, verifyNonInclusion } from './verify.js'
