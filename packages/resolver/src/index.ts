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

// `askDelegate` and `DelegateCache` are exported for one purpose: a delegate
// host — `@nns/delegate`, or anyone else's — testing itself against the client
// that will actually ask it. **App code must call `resolve()` instead.** This
// function returns an address nothing vouches for and attaches none of the
// labelling that makes that visible: no `DELEGATED_ANSWER`, no proof of the
// parent, no host taken from a record anyone verified. `resolve()` is what
// pairs the unproven half with the proven one.
export { DelegateCache, MAX_DELEGATE_TTL_SEC, askDelegate, type DelegateInfo } from './delegate.js'

// §8.5 #1 is `@nns/anchor/reader`'s rule, wired here and not restated. What
// this package adds is §8.5 #3's binding: the anchored commitment is compared
// against the checkpoint the proof verified against, recomputed from its own
// six components through core.
export {
  anchorWarnings,
  type AnchorNotRunReason,
  type AnchorPolicy,
  type AnchorReport,
} from './anchors.js'
export type { AnchorCheck, AnchorReadRpc } from '@nns/anchor/reader'
export { createAnchorReadRpc } from '@nns/anchor/reader'

// Two resolvers, no anchor publishers. Spread them rather than replacing
// them, so the day either list grows an integrator picks the new entries up
// by upgrading rather than by editing.
export { DEFAULT_ANCHOR_PUBLISHERS, DEFAULT_RESOLVERS } from './defaults.js'

/**
 * `formatAddress` is core's, re-exported here for one reason: the only
 * correct way to *display* what `resolve()` returns.
 *
 * `result.address` is the canonical compact form, which is what a payment
 * takes; a user reads the spaced form, and §4.3's rules about which glyphs
 * must be distinguishable are about what a user reads. This package already
 * owns that surface — it ships the stylesheet for it — so a host that took
 * the resolver and not `@nns/core` should not have to add a second dependency
 * to render an address the way every Nimiq wallet does. Notably the
 * single-file browser build (`dist/nns.js`) has no other way to reach it.
 *
 * Nothing else from core is re-exported: the builders in §6 are a different
 * job with a different dependency, and a barrel that forwards a whole package
 * is a barrel nobody can tell the boundary of.
 */
export { formatAddress } from '@nns/core'

export type { CheckpointRef } from './quorum.js'

export type { HttpFetch, HttpResponse, ResolverEndpoint } from './transport.js'

export { warn, type ResolveWarning, type WarningCode } from './warnings.js'

// §4.3 is a SHOULD that fails silently when it is not followed, so it ships
// as CSS rather than as advice. The stylesheet is also a file —
// `@nns/resolver/rendering.css` — for hosts with a CSS loader; the string and
// the injector are the path for hosts with no build step at all.
export {
  NNS_NAME_CLASS,
  RENDERING_CSS,
  injectRenderingCss,
  type AppendableNode,
  type StyleHost,
  type StyleSheetElement,
} from './rendering.js'

export {
  AnchorError,
  ConfigurationError,
  DelegateError,
  DocumentError,
  LookupError,
  NameError,
  ProofError,
  QuorumError,
  ResolverError,
  type DelegateErrorCode,
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
