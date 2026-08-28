/**
 * One search box, every outcome of docs/app-states.md §3, as a closed union
 * the screen renders case by case. All addresses and availability verdicts
 * come from `resolver()`; `/name` rides along for the overlays.
 */

import {
  CONSTANTS,
  parseQuery,
  validateNameShape,
  type LabelInvalidReason,
  type NameInvalidReason,
  type QueryParse,
} from '@nns/core'
import {
  AnchorError,
  DelegateError,
  LookupError,
  NameError,
  ProofError,
  QuorumError,
  type AvailableResult,
  type DelegateErrorCode,
  type ResolveResult,
} from '@nns/resolver'
import { getNameInfo, type NameInfo } from './api'
import { apiBase, resolver } from './nns'

export type SearchOutcome =
  | { readonly kind: 'invalid'; readonly fault: QueryFault }
  | {
      readonly kind: 'resolved'
      readonly result: ResolveResult
      /** The queried name's own record. **Always null for a dotted query** — NNS holds no record of a label. */
      readonly info: NameInfo | null
    }
  | { readonly kind: 'availability'; readonly name: string; readonly availability: AvailableResult; readonly info: NameInfo | null }
  | { readonly kind: 'grace'; readonly name: string; readonly info: NameInfo | null }
  | { readonly kind: 'parent-state'; readonly parent: string; readonly code: 'NOT_FOUND' | 'IN_GRACE' }
  | { readonly kind: 'delegate-failed'; readonly query: string; readonly code: DelegateErrorCode; readonly parent: ResolveResult | null }
  | { readonly kind: 'alarm'; readonly code: string; readonly message: string }
  | { readonly kind: 'unreachable'; readonly code: string; readonly message: string }

/**
 * §4.1 syntax for a typed query, with **rule 6 neutralised**. Reservation is
 * chain state, not a property of the string: a name released by a `U` (§6
 * `U`) — and since r18 an awarded short name — is an ordinary name that must
 * be searchable, resolvable and registrable. A browser cannot know
 * `state.unreserved`, so this does what the API's `/resolve` and
 * `@nns/resolver` both do: pass the candidate itself (the parent, for a
 * dotted query) as `unreserved`, which covers both membership routes in one
 * move. Whether the name is *still* held is the server's answer, and arrives
 * as `available.reason === 'RESERVED'`.
 *
 * Rules 1–5 stay client-side, `TOO_SHORT` included: a short name failing
 * rules 2–5 is on neither membership route, so nothing can ever release it.
 */
export function parseSearchQuery(query: string): QueryParse {
  const dot = query.indexOf('.')
  return parseQuery(query, new Set([dot < 0 ? query : query.slice(dot + 1)]))
}

/**
 * Is the name part shorter than `MIN_NAME_LEN`? **Length alone**, and
 * informational only — the caller shows `shortNameNoteLine()` beside the
 * field, never a refusal.
 *
 * This is the one thing a browser may say about a short name. Since r18 such a
 * name is reserved *by rule* rather than malformed, so the rule it fails is 6,
 * and rule 6 is chain state: a `U` can release any of them. Whether *this* one
 * is still held is the server's answer. Hence no `RESERVED_NAMES` read, no
 * `isReservedName`, and no verdict — a hint that denied would be
 * `parseSearchQuery`'s bug again, one rule further down.
 *
 * Measures the parent of a dotted query, the same split `parseSearchQuery`
 * makes: `§4.4` labels floor at 1 character, so `pay.nimiq` is nothing to note
 * while `pay.nim` is.
 */
export function isShortName(query: string): boolean {
  const dot = query.indexOf('.')
  const name = dot < 0 ? query : query.slice(dot + 1)
  return name.length > 0 && name.length < CONSTANTS.MIN_NAME_LEN
}

/**
 * What is wrong with a typed query, resolved to the rule a user can act on.
 * Codes only — `queryFaultLine()` in wording.ts turns one into a sentence, so
 * the field hint and the `invalid` card cannot drift apart.
 */
export type QueryFault =
  | { readonly kind: 'many-dots' }
  /** A dot with nothing on one side of it: `.`, `.shopper`, `shopper.`. */
  | { readonly kind: 'dot-shape' }
  | { readonly kind: 'label'; readonly reason: LabelInvalidReason }
  | { readonly kind: 'name'; readonly reason: NameInvalidReason }
  /**
   * A name rule failed and *which* is not known here — the resolver refused a
   * name the client parsed. Vague on purpose: better than naming a rule we
   * cannot show broke.
   */
  | { readonly kind: 'unspecified' }

/**
 * `null` means "nothing to refuse" — which includes a well-formed short name,
 * whose fate is the server's (`isShortName` + the note carry that case).
 *
 * Two things happen here that a bare `parseSearchQuery` cannot do:
 *
 * 1. **A dot with an empty side is its own fault.** `parseQuery` validates the
 *    empty side as a name or a label, so `shopper.` came out as a name rule and
 *    `.shopper` as a label rule, both about a string the user never typed. The
 *    shape is what is wrong, so say that.
 * 2. **`TOO_SHORT` is re-asked as a shape question.** `validateNameSyntax`
 *    returns it for *any* string under `MIN_NAME_LEN` that also fails rules
 *    2–5, deliberately (§4.2's `sud0` vector) — so `??`, `-ab`, `1234` and
 *    `sud0` all arrived claiming to be about length, and worse, claiming to be
 *    *reserved*. They are not: failing rules 2–5 puts a short name on neither
 *    membership route, no `U` can ever release it (verified — the reducer
 *    forfeits `INVALID_NAME`, and `encodeUnreserve` refuses to build it), so it
 *    can never exist. `validateNameShape` names the rule that actually failed.
 */
export function queryFault(query: string): QueryFault | null {
  if (query === '') return null
  if (query.split('.').length - 1 > 1) return { kind: 'many-dots' }

  const dot = query.indexOf('.')
  if (dot >= 0 && (dot === 0 || dot === query.length - 1)) return { kind: 'dot-shape' }

  const parsed = parseSearchQuery(query)
  if (parsed.ok) return null
  if (parsed.reason === 'TOO_MANY_DOTS') return { kind: 'many-dots' }
  if (parsed.reason === 'BAD_LABEL') return { kind: 'label', reason: parsed.detail as LabelInvalidReason }

  const reason = parsed.detail as NameInvalidReason
  if (reason !== 'TOO_SHORT') return { kind: 'name', reason }
  // Short *and* malformed. The shape check always has the specific answer: a
  // sound shape under the floor is `isShortReserved`, which parses fine above.
  const shape = validateNameShape(dot < 0 ? query : query.slice(dot + 1))
  return { kind: 'name', reason: shape.ok ? 'TOO_SHORT' : shape.reason }
}

/** The name info is an overlay, never the answer — its failure must not sink a verified resolution. */
const infoOrNull = async (name: string): Promise<NameInfo | null> => {
  try {
    return await getNameInfo(apiBase(), name)
  } catch {
    return null
  }
}

export async function search(rawQuery: string): Promise<SearchOutcome> {
  const query = rawQuery.trim().toLowerCase()
  const parsed = parseSearchQuery(query)
  if (!parsed.ok) {
    // Through `queryFault` so the card says what the field said — never the raw
    // first failing code, which is the misreading this whole path had.
    return { kind: 'invalid', fault: queryFault(query) ?? { kind: 'unspecified' } }
  }

  const plainName = parsed.query.kind === 'name' ? parsed.query.name : null

  try {
    const result = await resolver().resolve(query)
    const info = plainName !== null ? await infoOrNull(plainName) : null
    return { kind: 'resolved', result, info }
  } catch (error) {
    if (error instanceof LookupError) {
      if (plainName === null) {
        // A dotted query failed at the parent: word it about the parent.
        return {
          kind: 'parent-state',
          parent: parsed.query.kind === 'dotted' ? parsed.query.parent : query,
          code: error.code as 'NOT_FOUND' | 'IN_GRACE',
        }
      }
      if (error.code === 'IN_GRACE') {
        return { kind: 'grace', name: plainName, info: await infoOrNull(plainName) }
      }
      // NOT_FOUND: the register path needs the non-inclusion proof (§8.5).
      const availability = await resolver().available(plainName)
      return { kind: 'availability', name: plainName, availability, info: await infoOrNull(plainName) }
    }
    if (error instanceof DelegateError) {
      return { kind: 'delegate-failed', query, code: error.code as DelegateErrorCode, parent: error.parent }
    }
    if (error instanceof NameError) {
      return { kind: 'invalid', fault: { kind: 'unspecified' } }
    }
    if (error instanceof ProofError || error instanceof AnchorError) {
      return { kind: 'alarm', code: error.code, message: error.message }
    }
    if (error instanceof QuorumError) {
      return error.code === 'QUORUM_UNMET'
        ? { kind: 'unreachable', code: error.code, message: error.message }
        : { kind: 'alarm', code: error.code, message: error.message }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'unreachable', code: 'NETWORK', message }
  }
}
