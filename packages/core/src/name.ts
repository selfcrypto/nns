/**
 * Name rules — spec §4.
 *
 * Independent of {@link ./config.ts | NnsConfig}: rule 6's published list is
 * `CONSTANTS.RESERVED_NAMES`, frozen at the launch freeze, so this module sits
 * at the bottom of the dependency order and can be tested with nothing else
 * present. The only thing it still takes from outside is `unreserved` — which
 * names a fired `U` has released — because that is chain state, not config.
 *
 * **Implementations MUST reject rather than normalise** (§4.1). Uppercase
 * input is invalid, not lowercased. A caller that wants leniency lowercases
 * before asking.
 */

import { CONSTANTS } from './constants.js'

/**
 * Stable reason codes. These appear in conformance vectors, so an independent
 * implementation is expected to reproduce them exactly — renaming one is a
 * breaking change to the vectors, not an internal detail.
 */
export type NameInvalidReason =
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'BAD_CHARACTER'
  | 'NO_LETTER'
  | 'LEADING_HYPHEN'
  | 'TRAILING_HYPHEN'
  | 'DOUBLE_HYPHEN'
  | 'INTERIOR_DIGIT'
  | 'BOUNDARY_DIGIT'
  | 'RESERVED'

export type NameValidation = { readonly ok: true } | { readonly ok: false; readonly reason: NameInvalidReason }

const OK: NameValidation = Object.freeze({ ok: true })
const no = (reason: NameInvalidReason): NameValidation => Object.freeze({ ok: false, reason })

const EMPTY_RESERVED: ReadonlySet<string> = new Set()

/**
 * The published half of `RESERVED_NAMES`, as a set, built once. The constant
 * is an array so it reads as a reviewable list; every lookup goes through
 * here, so membership never costs a scan.
 */
const LISTED_RESERVED: ReadonlySet<string> = new Set<string>(CONSTANTS.RESERVED_NAMES)

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9'
const isLetter = (ch: string): boolean => ch >= 'a' && ch <= 'z'
const isNameChar = (ch: string): boolean => isLetter(ch) || isDigit(ch) || ch === '-'

/**
 * §4.2 positional digit rule, plus the r6 boundary clause.
 *
 * Main rule: strip any leading run of digits and any trailing run of digits;
 * the remainder MUST contain no digits. Boundary clause: `0` and `1` may be
 * neither the first nor the last character.
 *
 * Checked in that order, because §4.2 states the main rule first and
 * introduces the boundary clause with "Additionally" — a name failing both
 * must report `INTERIOR_DIGIT`, or vectors disagree.
 */
function checkDigitRules(name: string): NameValidation {
  let start = 0
  let end = name.length
  while (start < end && isDigit(name[start] as string)) start++
  while (end > start && isDigit(name[end - 1] as string)) end--

  for (let i = start; i < end; i++) {
    if (isDigit(name[i] as string)) return no('INTERIOR_DIGIT')
  }

  const first = name[0] as string
  const last = name[name.length - 1] as string
  if (first === '0' || first === '1' || last === '0' || last === '1') return no('BOUNDARY_DIGIT')

  return OK
}

/** §4.1 rules 2–5: character set, at least one letter, hyphen placement, digits. */
function checkRules2to5(name: string): NameValidation {
  // 2. Character set: a-z, 0-9, '-' only. Uppercase lands here, as intended.
  let hasLetter = false
  for (const ch of name) {
    if (!isNameChar(ch)) return no('BAD_CHARACTER')
    if (isLetter(ch)) hasLetter = true
  }

  // 3. At least one letter.
  if (!hasLetter) return no('NO_LETTER')

  // 4. Hyphen placement.
  if (name.startsWith('-')) return no('LEADING_HYPHEN')
  if (name.endsWith('-')) return no('TRAILING_HYPHEN')
  if (name.includes('--')) return no('DOUBLE_HYPHEN')

  // 5. Positional digit rule (§4.2).
  return checkDigitRules(name)
}

/**
 * §4.1's by-rule membership route into `RESERVED_NAMES`: every 1–4 character
 * name satisfying rules 2–5. Checked as a rule — length plus rules 2–5 —
 * never by materialising the ~1.7M short names into a list, which is why the
 * published list carries no short entries. A short name failing rules 2–5 is
 * on neither membership route and can never be released.
 */
export const isShortReserved = (name: string): boolean =>
  name.length >= 1 && name.length < CONSTANTS.MIN_NAME_LEN && checkRules2to5(name).ok

/** §4.1's other membership route: an entry on the published list, exact match. */
export const isListedReserved = (name: string): boolean => LISTED_RESERVED.has(name)

/**
 * §4.1 rule 6 membership by either route — the published list or the by-rule
 * short names. Says nothing about *release*: a fired `U` is chain state, so
 * ask `isReserved(state, name)` when you hold a state.
 */
export const isReservedName = (name: string): boolean => isListedReserved(name) || isShortReserved(name)

/**
 * §4.1 rules 2–5 alone — the *shape* of the string, with length ignored in
 * both directions.
 *
 * This exists because `validateNameSyntax` deliberately answers `TOO_SHORT`
 * for a short name that fails rules 2–5, hiding which rule it failed (see the
 * comment on that line, and §4.2's `sud0` vector). That is the right answer
 * for a validity check and the wrong one for a *message* to a user: `??`,
 * `-ab`, `1234` and `sud0` are not too short, and telling someone a name is
 * "reserved" when it can never exist is worse than saying nothing. A caller
 * rendering an explanation asks this for the real reason.
 *
 * Never a validity check on its own — it has no floor and no ceiling, so
 * `validateNameSyntax` or `validateName` is what decides whether a name is
 * usable.
 */
export const validateNameShape = (name: string): NameValidation => checkRules2to5(name)

/**
 * §4.1 rules 1–5: everything that is a property of the string alone, with
 * rule 1's floor left off.
 *
 * This is the check for a caller that has no chain state — a builder, or an
 * API route taking a reserved name as a legitimate subject. It accepts a
 * well-formed short name, because a released or awarded one is an ordinary
 * name and every owner operation must be encodable for it. `TOO_SHORT` still
 * fails: a short name failing rules 2–5 is on *neither* membership route, so
 * nothing can ever release it and no message may carry it.
 */
export function validateNameSyntax(name: string): NameValidation {
  if (name.length > CONSTANTS.MAX_NAME_LEN) return no('TOO_LONG')
  // Length claims a malformed short name before the specific rule does, which
  // keeps §4.2's `sud0` a length rejection, as its vector notes.
  if (name.length < CONSTANTS.MIN_NAME_LEN) return checkRules2to5(name).ok ? OK : no('TOO_SHORT')
  return checkRules2to5(name)
}

/**
 * §4.1 validity, in the order the spec lists its six rules. A name is valid
 * iff every one holds.
 *
 * Since r18 validity is state-dependent below `MIN_NAME_LEN`: a well-formed
 * short name is reserved *by rule*, and rule 1's floor binds only while a
 * name is still reserved — released by a fired `U`, it is a normal name.
 *
 * Rule 6 reads `CONSTANTS.RESERVED_NAMES` and takes no list parameter: the
 * list is a consensus input, and a caller able to supply a different one is a
 * caller able to derive a different root.
 *
 * @param unreserved names released from the reserved set by a fired `U`
 * (`state.unreserved`). Empty by default, which is the launch state — a
 * stateless caller gets `RESERVED` for every held name.
 */
export function validateName(name: string, unreserved: ReadonlySet<string> = EMPTY_RESERVED): NameValidation {
  // 1–5.
  const syntax = validateNameSyntax(name)
  if (!syntax.ok) return syntax

  // 6. Not currently reserved: a member by either route, not yet released.
  // This subsumes rule 1's floor — a well-formed short name reaches here as a
  // by-rule member, so it is RESERVED while held and ordinary once released.
  if (isReservedName(name) && !unreserved.has(name)) return no('RESERVED')

  return OK
}

export const isValidName = (name: string, unreserved?: ReadonlySet<string>): boolean =>
  validateName(name, unreserved).ok

/*
 * A two-band split at twelve characters lived here through 2026-09-10. §10.1
 * now prices by length over seven rows of one base fee (`feeMultiplier` in
 * `constants.ts`, `feeFor` in `reduce.ts`); the tier is still measured from
 * the name itself, never declared on the wire (§6.1).
 */

// ── Dotted queries (§4.4) ───────────────────────────────────────────────────

export type LabelInvalidReason = 'TOO_SHORT' | 'TOO_LONG' | 'BAD_CHARACTER' | 'LEADING_HYPHEN' | 'TRAILING_HYPHEN' | 'DOUBLE_HYPHEN'

export type LabelValidation = { readonly ok: true } | { readonly ok: false; readonly reason: LabelInvalidReason }

/**
 * §4.4 subdomain label. The positional digit rule deliberately does **not**
 * apply: labels are not scarce, not sold, and not confusable with registered
 * names, because the parent disambiguates them. Nor is a letter required.
 *
 * Labels are never protocol state — nothing here reaches the log or the tree.
 */
export function validateLabel(label: string): LabelValidation {
  if (label.length < 1) return { ok: false, reason: 'TOO_SHORT' }
  if (label.length > CONSTANTS.MAX_LABEL_LEN) return { ok: false, reason: 'TOO_LONG' }
  for (const ch of label) {
    if (!isNameChar(ch)) return { ok: false, reason: 'BAD_CHARACTER' }
  }
  if (label.startsWith('-')) return { ok: false, reason: 'LEADING_HYPHEN' }
  if (label.endsWith('-')) return { ok: false, reason: 'TRAILING_HYPHEN' }
  if (label.includes('--')) return { ok: false, reason: 'DOUBLE_HYPHEN' }
  return { ok: true }
}

// ── Delegate resolver host (§6 `D`) ─────────────────────────────────────────

export type HostInvalidReason =
  | 'TOO_LONG'
  | 'BAD_CHARACTER'
  | 'LEADING_DOT'
  | 'TRAILING_DOT'
  | 'LEADING_HYPHEN'
  | 'TRAILING_HYPHEN'
  | 'LEADING_SLASH'
  | 'DOUBLE_DOT'
  | 'DOUBLE_SLASH'

export type HostValidation = { readonly ok: true } | { readonly ok: false; readonly reason: HostInvalidReason }

/**
 * §6 `D` delegate host: a hostname with an optional short path. `https://` is
 * implied and MUST NOT be included — a scheme is rejected by the character set,
 * since `:` is not permitted.
 *
 * The empty host is **valid** and means "clear the delegation".
 *
 * §6 is explicit that "validation must be exact or indexers diverge on the
 * same message", so every clause is checked here and nowhere else.
 */
export function validateHost(host: string): HostValidation {
  if (host.length === 0) return { ok: true }
  if (host.length > CONSTANTS.MAX_HOST_LEN) return { ok: false, reason: 'TOO_LONG' }

  for (const ch of host) {
    if (!(isLetter(ch) || isDigit(ch) || ch === '.' || ch === '-' || ch === '/')) {
      return { ok: false, reason: 'BAD_CHARACTER' }
    }
  }

  if (host.startsWith('.')) return { ok: false, reason: 'LEADING_DOT' }
  if (host.endsWith('.')) return { ok: false, reason: 'TRAILING_DOT' }
  if (host.startsWith('-')) return { ok: false, reason: 'LEADING_HYPHEN' }
  if (host.endsWith('-')) return { ok: false, reason: 'TRAILING_HYPHEN' }
  if (host.startsWith('/')) return { ok: false, reason: 'LEADING_SLASH' }
  if (host.includes('..')) return { ok: false, reason: 'DOUBLE_DOT' }
  if (host.includes('//')) return { ok: false, reason: 'DOUBLE_SLASH' }

  return { ok: true }
}

// ── Referrer (§6 `G`) ────────────────────────────────────────────────────────

/**
 * §6 `G` `ref`: 1…`MAX_REF_LEN` characters from `a-z`, `0-9`, `-`.
 *
 * Returns a boolean rather than a reason, because a `ref` that fails is never
 * an error: §6 requires an unknown, malformed or absent referrer to be
 * "recorded as absent" with the registration proceeding normally. Accounting
 * must never be able to reject a paid registration.
 */
export function isValidRef(ref: string): boolean {
  if (ref.length < 1 || ref.length > CONSTANTS.MAX_REF_LEN) return false
  for (const ch of ref) {
    if (!(isLetter(ch) || isDigit(ch) || ch === '-')) return false
  }
  return true
}

export type Query =
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'dotted'; readonly label: string; readonly parent: string }

export type QueryInvalidReason = 'TOO_MANY_DOTS' | 'BAD_LABEL' | 'BAD_NAME'

export type QueryParse =
  | { readonly ok: true; readonly query: Query }
  | { readonly ok: false; readonly reason: QueryInvalidReason; readonly detail: NameInvalidReason | LabelInvalidReason | null }

/**
 * Split a query into a plain name or a `label.parent` pair (§4.4). A dot is
 * resolution syntax, never a registrable character; more than one is invalid
 * in v1.
 *
 * Syntax only. Whether `parent` is currently `REGISTERED` and carries a
 * delegate host is state, and belongs to the resolver.
 */
export function parseQuery(query: string, unreserved?: ReadonlySet<string>): QueryParse {
  const dots = query.split('.').length - 1
  if (dots > 1) return { ok: false, reason: 'TOO_MANY_DOTS', detail: null }

  if (dots === 0) {
    const check = validateName(query, unreserved)
    return check.ok
      ? { ok: true, query: { kind: 'name', name: query } }
      : { ok: false, reason: 'BAD_NAME', detail: check.reason }
  }

  const at = query.indexOf('.')
  const label = query.slice(0, at)
  const parent = query.slice(at + 1)

  const labelCheck = validateLabel(label)
  if (!labelCheck.ok) return { ok: false, reason: 'BAD_LABEL', detail: labelCheck.reason }

  const parentCheck = validateName(parent, unreserved)
  if (!parentCheck.ok) return { ok: false, reason: 'BAD_NAME', detail: parentCheck.reason }

  return { ok: true, query: { kind: 'dotted', label, parent } }
}
