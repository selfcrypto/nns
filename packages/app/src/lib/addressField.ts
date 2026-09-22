/**
 * Reading a field that takes **an address or a name** (Rico, 2026-09-15:
 * *"Doesn't make sense not be able to transfer a name filling another name as
 * destination … This service is all about using names. How bad it looks if we
 * are the first ones not allowing it"*).
 *
 * Pure, and separate from the component for the usual reason: this package's
 * Vitest environment is `node`, so anything a component decides for itself is
 * an untested branch. The resolution itself stays in the component — it is a
 * network call — but *what the text is* and *what an outcome means for the
 * field* are decided here.
 *
 * The field hands `prepareAction` an address and never a name: the pure
 * action layer keeps taking the one thing it can validate without a network,
 * and the review line keeps naming the address that will actually be
 * recorded.
 */

import { formatAddress, tryParseAddress } from '@nimiqnames/core'
import { parseSearchQuery, queryFault, type QueryFault, type SearchOutcome } from './search'
import { lookupFailedLine, lookupInGraceLine, lookupNoAddressLine, lookupUnavailableLine } from './wording'

export type FieldRead =
  | { readonly kind: 'empty' }
  /** A Nimiq address, in the spaced form every review line uses. */
  | { readonly kind: 'address'; readonly address: string }
  /** A query worth resolving. Lowercased, as `search()` would. */
  | { readonly kind: 'name'; readonly query: string }
  /** Not an address and not a name either, with the reason the field can state. */
  | { readonly kind: 'fault'; readonly fault: QueryFault | 'address' }

/**
 * What the user has typed so far.
 *
 * An `NQ` prefix is the tell that an address was *intended*: names are
 * lowercase by §4.1, so a half-typed or mistyped address can never also be a
 * plausible name, and saying "not a Nimiq address" about `rico` is exactly
 * the mistake this field was reported for.
 */
export function readAddressField(raw: string): FieldRead {
  const text = raw.trim()
  if (text === '') return { kind: 'empty' }

  const address = tryParseAddress(text)
  if (address !== null) return { kind: 'address', address: formatAddress(address) }
  if (/^nq/i.test(text)) return { kind: 'fault', fault: 'address' }

  const query = text.toLowerCase()
  const parsed = parseSearchQuery(query)
  if (parsed.ok) return { kind: 'name', query }
  return { kind: 'fault', fault: queryFault(query) ?? { kind: 'unspecified' } }
}

export type FieldLookup =
  | { readonly kind: 'address'; readonly address: string; readonly from: string; readonly delegated: boolean }
  | { readonly kind: 'none'; readonly line: string }

/**
 * What a resolution means for the field.
 *
 * A delegated answer is **taken, and said**: the address is the host's word
 * rather than the chain's (§8.6), and a field that refused it would be the
 * same "we don't take names" complaint one level down. What the field must
 * not do is pass it off as proven, so the note beside it names the host's
 * part and the address itself is visible before anything is signed.
 */
export function addressFromOutcome(outcome: SearchOutcome, query: string): FieldLookup {
  switch (outcome.kind) {
    case 'resolved':
      return {
        kind: 'address',
        address: formatAddress(outcome.result.address),
        from: query,
        delegated: outcome.result.verification === 'DELEGATED',
      }
    case 'availability':
      return { kind: 'none', line: lookupNoAddressLine(query) }
    case 'grace':
      return { kind: 'none', line: lookupInGraceLine(query) }
    case 'parent-state':
    case 'delegate-failed':
    case 'invalid':
      return { kind: 'none', line: lookupFailedLine(query) }
    case 'alarm':
    case 'unreachable':
    case 'propagating':
      return { kind: 'none', line: lookupUnavailableLine(query) }
  }
}
