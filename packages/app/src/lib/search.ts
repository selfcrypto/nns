/**
 * One search box, every outcome of docs/app-states.md §3, as a closed union
 * the screen renders case by case. All addresses and availability verdicts
 * come from `resolver()`; `/name` rides along for the overlays.
 */

import { parseQuery, type QueryInvalidReason, type QueryParse } from '@nns/core'
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
  | { readonly kind: 'invalid'; readonly reason: QueryInvalidReason; readonly detail: string | null }
  | { readonly kind: 'resolved'; readonly result: ResolveResult; readonly info: NameInfo | null }
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
  if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason, detail: parsed.detail }

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
      return { kind: 'invalid', reason: 'BAD_NAME', detail: null }
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
