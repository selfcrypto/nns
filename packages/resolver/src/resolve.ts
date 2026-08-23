/**
 * `resolve(name)` — the public surface.
 *
 * Quorum and proof verification are on. Not "on by default" in the sense of a
 * flag whose other setting is supported: there is no option that turns
 * verification off. A served proof is always checked, and a check that fails
 * always throws. The one thing the host app configures is *how many*
 * independent resolvers must agree, because that number is a deployment
 * question (§8.5 ships `RESOLVER_QUORUM` as 2) and not a rule this package
 * gets to decide on its own — see the `quorum` option.
 *
 * The division of labour, kept to the same contract as `packages/api`: every
 * protocol rule is `@nns/core`'s. §4.1 and §4.4 name syntax is `parseQuery`,
 * §8.1 leaf encoding is `leafHash`, §8.1 recombination is `verifyProof`, §8.1
 * ordering is `compareNames`. What this file adds is transport, quorum policy
 * and the reconciliation of two clocks — none of which are protocol rules,
 * and none of which are restated anywhere in core.
 */

import { CONSTANTS, parseQuery, type Address, type NameRecord } from '@nns/core'

import {
  ANCHORS_NOT_CONFIGURED,
  anchorSettings,
  anchorWarnings,
  checkAnchor,
  type AnchorPolicy,
  type AnchorReport,
  type AnchorSettings,
} from './anchors.js'
import { DEFAULT_RESOLVERS } from './defaults.js'
import { DelegateCache, askDelegate, type DelegateInfo } from './delegate.js'
import {
  readAvailableResponse,
  readErrorCode,
  readResolveResponse,
  toHex,
  type DelegateResponse,
  type ResolveResponse,
} from './documents.js'
import { ConfigurationError, DelegateError, LookupError, NameError, ResolverError } from './errors.js'
import {
  agree,
  answered,
  belowSpecWarning,
  unavailable,
  type Agreement,
  type CheckpointRef,
  type Observation,
  type QuorumPolicy,
} from './quorum.js'
import { defaultFetch, type HttpFetch, type ResolverEndpoint } from './transport.js'
import { verifyInclusion, verifyNonInclusion } from './verify.js'
import { warn, type ResolveWarning } from './warnings.js'

// ── Results ─────────────────────────────────────────────────────────────────

/**
 * How much an answer is worth, in the terms §8.5 #6 requires be *visually*
 * distinguishable.
 *
 * - `PROVEN` — an inclusion proof for this exact answer recombined to a root
 *   at least `quorum.required` resolvers stand behind. Verified on-chain.
 * - `PROOF_PENDING` — the answer is good and the name works; no checkpoint
 *   commits to it yet (§8.7), or the checkpoint commits to an older value.
 *   A depth indicator. Not a warning.
 * - `DELEGATED` — a delegate host said so (§8.6). The parent's ownership is
 *   proven, the address is not. No cryptographic guarantee at all.
 */
export type Verification = 'PROVEN' | 'PROOF_PENDING' | 'DELEGATED'

/** Who was asked, how many had to agree, and how many did. On every result. */
export interface QuorumReport {
  readonly required: number
  readonly queried: number
  readonly agreed: number
  /** The resolvers whose answers were verified and agreed, by configured name. */
  readonly resolvers: readonly string[]
}

export interface ResolveResult {
  /** What was asked, verbatim — including the dot, for a delegated query. */
  readonly query: string
  /** The registered name that carried the answer. The parent, for a dotted query. */
  readonly name: string
  readonly address: Address
  /**
   * The §6 `E` record — the EVM address the owner declared, lowercase
   * `0x`-hex, `''` when none. One address for every EVM chain. Verified on
   * the same terms as `address`: it is in the agreement key, and a proof
   * committing to a different value keeps the answer at `PROOF_PENDING`.
   */
  readonly evm: string
  readonly verification: Verification
  /** The delegate host the name designates, `''` when none (§6 `D`). */
  readonly host: string
  /** The checkpoint the agreeing resolvers proved against, `null` when none served a proof. */
  readonly checkpoint: CheckpointRef | null
  /** State height, taken from the most conservative resolver that agreed. */
  readonly height: number
  /** Present only for a dotted query (§8.6). */
  readonly delegate: DelegateInfo | null
  readonly quorum: QuorumReport
  /** What §8.5 #1 concluded about the checkpoint above — or why it did not run. */
  readonly anchor: AnchorReport
  readonly warnings: readonly ResolveWarning[]
}

export interface AvailableResult {
  readonly name: string
  readonly available: boolean
  /** Why not, when unavailable — a §4.1 reason or `TAKEN`. `null` when available. */
  readonly reason: string | null
  /** `PROVEN` only when a non-inclusion proof for this name verified (§8.5). */
  readonly verification: 'PROVEN' | 'PROOF_PENDING'
  readonly checkpoint: CheckpointRef | null
  readonly height: number
  readonly quorum: QuorumReport
  /** What §8.5 #1 concluded about the checkpoint above — or why it did not run. */
  readonly anchor: AnchorReport
  readonly warnings: readonly ResolveWarning[]
}

// ── Options ─────────────────────────────────────────────────────────────────

export interface ResolverOptions {
  /**
   * The independent resolvers to query. Must hold at least `quorum` entries.
   *
   * Defaults to {@link DEFAULT_RESOLVERS}, which is **empty** — no NNS API is
   * deployed yet — so a host app that omits it gets a {@link ConfigurationError}
   * naming that fact rather than a resolver that answers from nowhere.
   */
  readonly resolvers?: readonly ResolverEndpoint[]
  /**
   * §8.5 #1: read §9 anchors and require the checkpoint this answer was proven
   * against to be the one listed publishers anchored.
   *
   * Omitted by default, and **inert even when supplied** until
   * `ANCHOR_PUBLISHERS` has entries — nothing is deployed, so the shipped list
   * is empty and every result reports `not-checked`. The rule itself is
   * `@nns/anchor/reader`'s and exists once; what this package adds is tying the
   * anchored commitment to the `nameRoot` the proof verified against.
   */
  readonly anchors?: AnchorPolicy
  /**
   * How many must agree. Defaults to `CONSTANTS.RESOLVER_QUORUM`.
   *
   * Setting it lower is supported and **loud**: the constructor warns once on
   * the console, and every result carries `QUORUM_BELOW_SPEC` for the host
   * app to render. §8.5 #2's reasoning is that one resolver plus one anchor
   * publisher is one party, and a single party's proofs are internally
   * consistent whether or not it is honest (§2.1).
   */
  readonly quorum?: number
  readonly fetch?: HttpFetch
  readonly timeoutMs?: number
  /**
   * Timeout for the §8.6 delegate request. Defaults to `timeoutMs` when that
   * is set, and to 5,000 ms otherwise — **the same budget a resolver gets, on
   * purpose.**
   *
   * A shorter one is tempting: a delegate is a third party's box and the user
   * is looking at a payment screen. But cutting it short reports
   * `DELEGATE_FAILED` for a host that was working — a distant server doing a
   * TLS handshake into a cold process can legitimately take three seconds —
   * and a wrong answer from a working host is worse than a slow one, since the
   * user retries either way. What keeps a slow delegate from reading as a
   * broken registry is the labelling, not the clock: the answer is marked
   * `DELEGATED`, and the parent's on-chain resolution stays visible beside it
   * (see {@link DelegateError.parent}). The knob is here for a deployment that
   * knows its own hosts, not as a default worth changing.
   */
  readonly delegateTimeoutMs?: number
  /** Called for every warning raised, in addition to the warning riding on the result. */
  readonly onWarning?: (warning: ResolveWarning) => void
  /** Clock for the §8.6 delegate cache. Injectable so cache expiry is testable. */
  readonly now?: () => number
}

// ── Observations ────────────────────────────────────────────────────────────

/**
 * One resolver's answer about a name — including "there isn't one".
 *
 * Absence is an answer, not an error, and it is modelled as one so it reaches
 * the agreement comparison: one resolver saying `NOT_FOUND` while another
 * serves a record is exactly the disagreement §8.5 #2 halts on, and throwing
 * at the first 404 would let a lagging or lying resolver decide the outcome
 * before the others were heard.
 */
interface ResolveObservation extends Observation {
  readonly response: ResolveResponse | null
  readonly absent: 'NOT_FOUND' | 'IN_GRACE' | null
  /** The record the checkpoint commits to, `null` when no proof was served (§8.7). */
  readonly proven: NameRecord | null
}

interface AvailableObservation extends Observation {
  readonly available: boolean
  readonly reason: string | null
  readonly height: number
  readonly proved: boolean
}

const checkpointOf = (response: ResolveResponse): CheckpointRef | null =>
  response.proof === null ? null : { rootHex: toHex(response.proof.root), height: response.proof.nimiqHeight }

/**
 * A proof that commits to exactly the answer being served — the only thing
 * that earns `PROVEN`. `evm` joined `target` here in r26: both are §8.1 leaf
 * fields a client acts on, and a proof committing to a different EVM address
 * — a recent `E`, or a lying endpoint — must not read as "verified" either.
 */
const provesTheAnswer = (observation: ResolveObservation): boolean =>
  observation.proven !== null &&
  observation.response !== null &&
  observation.proven.status === 'REGISTERED' &&
  observation.proven.target === observation.response.target &&
  observation.proven.evm === observation.response.evm

// ── The resolver ────────────────────────────────────────────────────────────

export class NnsResolver {
  readonly #policy: QuorumPolicy
  readonly #anchors: AnchorSettings | null
  readonly #onWarning: ((warning: ResolveWarning) => void) | null
  readonly #cache: DelegateCache
  readonly #delegateTimeoutMs: number
  readonly #belowSpec: ResolveWarning | null

  constructor(options: ResolverOptions) {
    const required = options.quorum ?? CONSTANTS.RESOLVER_QUORUM
    const resolvers = options.resolvers ?? DEFAULT_RESOLVERS
    if (!Number.isSafeInteger(required) || required < 1) {
      throw new ConfigurationError(`quorum must be a positive integer, got ${String(options.quorum)}`)
    }
    if (resolvers.length < required) {
      throw new ConfigurationError(
        `quorum is ${required} but only ${resolvers.length} resolvers are configured — ` +
          'a quorum that cannot be met is a quorum that is not enforced' +
          (resolvers.length === 0 ? '. DEFAULT_RESOLVERS is empty: no NNS API is deployed yet, so pass your own' : ''),
      )
    }

    this.#anchors = options.anchors === undefined ? null : anchorSettings(options.anchors)
    this.#policy = {
      endpoints: resolvers,
      required,
      fetch: options.fetch ?? defaultFetch(),
      timeoutMs: options.timeoutMs ?? 5_000,
    }
    this.#onWarning = options.onWarning ?? null
    this.#cache = new DelegateCache(options.now ?? Date.now)
    this.#delegateTimeoutMs = options.delegateTimeoutMs ?? options.timeoutMs ?? 5_000
    this.#belowSpec = belowSpecWarning(required)

    // Loud at construction, not only on results: an app that never renders a
    // warning still gets told once that it is running without the quorum.
    if (this.#belowSpec !== null && options.onWarning === undefined) {
      console.warn(`[@nns/resolver] ${this.#belowSpec.detail}`)
    }
  }

  /** Drop every cached §8.6 delegate answer. */
  clearCache(): void {
    this.#cache.clear()
  }

  #report<O extends Observation>(agreement: Agreement<O>): QuorumReport {
    return {
      required: this.#policy.required,
      queried: agreement.queried,
      agreed: agreement.witnesses.length,
      resolvers: agreement.witnesses.map((witness) => witness.endpoint.name),
    }
  }

  #raise(warnings: readonly ResolveWarning[]): readonly ResolveWarning[] {
    if (this.#onWarning !== null) for (const warning of warnings) this.#onWarning(warning)
    return warnings
  }

  /**
   * §8.5 #1 for the checkpoint the quorum proved against.
   *
   * Runs after agreement and after proof verification, never instead of them:
   * an anchor says the *checkpoint* is the one publishers attested, and a
   * proof says the *answer* is in that checkpoint. Neither substitutes for the
   * other, which is why this sits on `result.anchor` rather than promoting
   * `verification` to a fourth value — `PROVEN` would otherwise mean something
   * different depending on a deployment setting.
   */
  async #anchorFor<O extends Observation>(agreement: Agreement<O>): Promise<AnchorReport> {
    if (this.#anchors === null) return ANCHORS_NOT_CONFIGURED
    return await checkAnchor(
      { settings: this.#anchors, fetch: this.#policy.fetch, timeoutMs: this.#policy.timeoutMs },
      agreement.checkpoint,
      agreement.provenBy,
    )
  }

  /**
   * Resolve a name, or a §4.4 dotted query.
   *
   * @throws {NameError} the query is not a §4.1 name or a §4.4 dotted query
   * @throws {LookupError} the name has no record, or is in `GRACE` (§7.3)
   * @throws {QuorumError} too few resolvers answered, or they disagreed
   * @throws {ProofError} a served proof did not verify — always a hard failure
   * @throws {DelegateError} a dotted query whose parent delegates nowhere, or whose host failed
   */
  async resolve(query: string): Promise<ResolveResult> {
    // §4.1/§4.4 syntax is core's, not this package's. Reservation is
    // neutralised: a reserved name awarded by a `U` (§6 `U`) is registered and
    // resolves like any other, which is the same reasoning that keeps rule 6
    // out of the API's /resolve. The candidate goes in as `unreserved`, which
    // covers both membership routes — the published list and r18's by-rule
    // short names — in one move.
    const dot = query.indexOf('.')
    const parsed = parseQuery(query, new Set([dot < 0 ? query : query.slice(dot + 1)]))
    if (!parsed.ok) {
      throw new NameError('NAME_INVALID', `${query} is not a name or a dotted query: ${parsed.reason}`)
    }

    if (parsed.query.kind === 'name') return await this.#resolveName(query, parsed.query.name)

    const { label, parent } = parsed.query
    // §8.6 step 1: the parent is resolved normally, with proof. Everything
    // this package can prove about a delegated answer is proven right here;
    // the step after it is the unproven half, and is labelled as such.
    const resolved = await this.#resolveName(query, parent)
    if (resolved.host === '') {
      throw new DelegateError(
        'PARENT_NOT_DELEGATING',
        `"${parent}" is registered but designates no delegate host, so "${query}" resolves to nothing (§8.6)`,
        resolved,
      )
    }

    // Everything from here is the unproven half. When it fails, the proven
    // half goes onto the error rather than being thrown away with it: the
    // caller can still show that the parent resolves, and that only the host
    // its owner designated did not answer. `resolve` keeps throwing — a
    // success shape whose `address` may be absent would make every caller
    // null-check the field that was the point of the call.
    let answer: { readonly response: DelegateResponse; readonly ttl: number }
    try {
      answer = await askDelegate(this.#policy.fetch, this.#cache, resolved.host, parent, label, this.#delegateTimeoutMs)
    } catch (error) {
      if (error instanceof DelegateError && error.parent === null) throw error.withParent(resolved)
      throw error
    }
    const { response, ttl } = answer

    const warnings = [
      ...resolved.warnings.filter((warning) => warning.code !== 'PROOF_PENDING'),
      warn(
        'DELEGATED_ANSWER',
        `${resolved.host} answered for "${query}". "${parent}" and its delegate host are proven; ` +
          'this address is not, and must be shown differently from a verified result (§8.5 #6)',
      ),
      ...(resolved.verification === 'PROVEN'
        ? []
        : [warn('DELEGATE_HOST_UNPROVEN', `no checkpoint yet commits to "${parent}" designating ${resolved.host}`)]),
    ]

    return {
      ...resolved,
      address: response.address,
      // The parent's record, not the label's: §8.6 answers carry an address
      // and a ttl, nothing more, and inheriting the parent's EVM record onto
      // a subdomain would attribute it to an owner who never declared it.
      evm: '',
      verification: 'DELEGATED',
      delegate: { parent, label, host: resolved.host, ttl },
      warnings: this.#raise(warnings),
    }
  }

  /**
   * Is this name free to register?
   *
   * §8.5 requires the app to ask this through a **non-inclusion proof**
   * before letting a user pay, and that proof is what this verifies. Because
   * grace names are in the tree (§8.1), a verified absence proves `AVAILABLE`
   * rather than merely not-`REGISTERED`.
   *
   * The reserved list is the serving resolver's, not this package's — see the
   * `RESERVED` reason, which is data rather than proof.
   */
  async available(name: string): Promise<AvailableResult> {
    // Reservation is the serving resolver's answer (`RESERVED`, below), not
    // a structural failure — so the by-rule short reservation (§4.1, r18) is
    // neutralised here exactly as in resolve().
    const parsed = parseQuery(name, new Set([name]))
    if (!parsed.ok || parsed.query.kind !== 'name') {
      // §4.4 labels are never protocol state and never registrable, so a
      // dotted query has no availability to report.
      throw new NameError('NAME_INVALID', `${name} is not a registrable name (§4.1)`)
    }

    const agreement = await agree(this.#policy, `available/${encodeURIComponent(name)}`, (fetched) => {
      if (fetched.status === 503) return unavailable<AvailableObservation>('not synced')
      if (fetched.status !== 200) {
        throw new ResolverError('NAME_INVALID', `resolver rejected "${name}": ${readErrorCode(fetched.body) ?? fetched.status}`)
      }

      const response = readAvailableResponse(fetched.body)
      let proved = false
      if (response.available && response.proof !== null) {
        verifyNonInclusion(response.proof, name)
        proved = true
      }

      return answered<AvailableObservation>({
        key: `${response.available}:${response.reason ?? ''}`,
        summary: response.available ? 'available' : `unavailable: ${response.reason ?? 'unknown'}`,
        checkpoint:
          response.proof === null ? null : { rootHex: toHex(response.proof.root), height: response.proof.nimiqHeight },
        available: response.available,
        reason: response.reason,
        height: response.height,
        proved,
      })
    })

    const first = agreement.witnesses[0]?.observation as AvailableObservation
    const proved = agreement.witnesses.some((witness) => witness.observation.proved)
    const anchor = await this.#anchorFor(agreement)
    const warnings = [
      ...agreement.warnings,
      ...(this.#belowSpec === null ? [] : [this.#belowSpec]),
      ...(proved
        ? []
        : [
            warn(
              'PROOF_PENDING',
              first.available
                ? 'no checkpoint proves this name absent yet (§8.7)'
                : `unavailability is reported, not proven — "${first.reason ?? 'unknown'}" is state or list data, not a §8.3 proof`,
            ),
          ]),
      ...anchorWarnings(anchor),
    ]

    return {
      name,
      available: first.available,
      reason: first.reason,
      verification: proved ? 'PROVEN' : 'PROOF_PENDING',
      checkpoint: agreement.checkpoint,
      height: Math.min(...agreement.witnesses.map((witness) => (witness.observation as AvailableObservation).height)),
      quorum: this.#report(agreement),
      anchor,
      warnings: this.#raise(warnings),
    }
  }

  async #resolveName(query: string, name: string): Promise<ResolveResult> {
    const agreement = await agree(this.#policy, `resolve/${encodeURIComponent(name)}`, (fetched) => {
      if (fetched.status === 503) return unavailable<ResolveObservation>('not synced')

      if (fetched.status === 404) {
        const code = readErrorCode(fetched.body)
        if (code !== 'NOT_FOUND' && code !== 'IN_GRACE') {
          throw new ResolverError('NOT_FOUND', `resolver answered 404 ${code ?? 'with no error code'}`)
        }
        return answered<ResolveObservation>({
          key: `ABSENT:${code}`,
          summary: code === 'NOT_FOUND' ? 'not registered' : 'in grace',
          checkpoint: null,
          response: null,
          absent: code,
          proven: null,
        })
      }

      if (fetched.status !== 200) {
        throw new ResolverError(
          'NAME_INVALID',
          `resolver rejected "${name}": ${readErrorCode(fetched.body) ?? fetched.status}`,
        )
      }

      const response = readResolveResponse(fetched.body)
      if (response.name !== name) {
        throw new ResolverError('QUORUM_DISAGREEMENT', `asked for "${name}", got an answer for "${response.name}"`)
      }

      // Verify before comparing. The record this returns is the *checkpoint's*
      // — it may legitimately lag the live fields beside it.
      const proven = response.proof === null ? null : verifyInclusion(response.proof, name)

      return answered<ResolveObservation>({
        key: `FOUND:${response.target}:${response.evm}:${response.status}:${response.host}`,
        summary: `${response.target} (${response.status}) at height ${response.height}`,
        checkpoint: checkpointOf(response),
        response,
        absent: null,
        proven,
      })
    })

    const observations = agreement.witnesses.map((witness) => witness.observation as ResolveObservation)
    const first = observations[0] as ResolveObservation

    // Quorum agreed the name resolves to nothing. Reported only now, so the
    // resolvers have all been heard and a lone 404 cannot end the call.
    if (first.absent !== null) {
      throw first.absent === 'NOT_FOUND'
        ? new LookupError('NOT_FOUND', `"${name}" is not registered`)
        : new LookupError('IN_GRACE', `"${name}" has expired and is in its grace period — §7.3 turns resolution off`)
    }

    const live = first.response as ResolveResponse
    const anchor = await this.#anchorFor(agreement)
    const proven = observations.some(provesTheAnswer)
    // A proof arrived and commits to something else: an `S` landed since the
    // checkpoint. Not an error — but the answer is not the proven one, and
    // saying "verified on-chain" over it would be false.
    const stale = !proven && observations.some((observation) => observation.proven !== null)

    const warnings = [
      ...agreement.warnings,
      ...(this.#belowSpec === null ? [] : [this.#belowSpec]),
      ...(proven
        ? []
        : stale
          ? [
              warn(
                'TARGET_CHANGED_SINCE_CHECKPOINT',
                `the last checkpoint commits to a different target for "${name}" — the current one is not yet proven (§8.7)`,
              ),
            ]
          : [warn('PROOF_PENDING', `no checkpoint proves "${name}" yet — recently registered, anchor pending (§8.7)`)]),
      ...anchorWarnings(anchor),
    ]

    return {
      query,
      name,
      address: live.target,
      evm: live.evm,
      verification: proven ? 'PROVEN' : 'PROOF_PENDING',
      host: live.host,
      checkpoint: agreement.checkpoint,
      height: Math.min(...observations.map((observation) => (observation.response as ResolveResponse).height)),
      delegate: null,
      quorum: this.#report(agreement),
      anchor,
      warnings: this.#raise(warnings),
    }
  }
}

/** Construct a resolver. Sugar for `new NnsResolver(options)`. */
export const createResolver = (options: ResolverOptions): NnsResolver => new NnsResolver(options)

/**
 * One-shot resolution.
 *
 * Convenient, and it throws away the §8.6 delegate cache with the instance —
 * an app resolving more than one name should hold an {@link NnsResolver}.
 */
export const resolve = async (query: string, options: ResolverOptions): Promise<ResolveResult> =>
  await new NnsResolver(options).resolve(query)
