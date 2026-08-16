/**
 * Every user-visible string, keyed by docs/app-states.md. Components never
 * invent wording; a sentence missing here means the states doc needs amending
 * first.
 *
 * The load-bearing rules (states doc §5):
 * - Alarm vocabulary is reserved for halting failures and a pin mismatch.
 * - Never "unverified" for a healthy quorum-1 answer.
 * - Delegate failures are attributed to the host, never to the subdomain —
 *   NNS never reports whether a subdomain exists.
 * - Depth (proof pending, anchor pending) is neutral, never a warning.
 */

import type { QuorumReport, WarningCode } from '@nns/resolver'
import type { AppAction, GateReason } from './states'
import type { QueryInvalidReason } from '@nns/core'

// ── Verification lines ──────────────────────────────────────────────────────

/** "Verified by 1 resolver — Operator" · "Verified by 2 resolvers". */
export function verifiedByLine(quorum: QuorumReport): string {
  if (quorum.agreed === 1) {
    const operator = quorum.resolvers[0] ?? 'unnamed'
    return `Verified by 1 resolver — ${operator}`
  }
  return `Verified by ${quorum.agreed} resolvers`
}

export const proofPendingLine = (): string =>
  'Proof pending — checkpoints are cut every ~12 minutes. The name works now.'

export const delegatedLine = (parent: string): string => `Resolved by ${parent}`

export const delegatedExplainer = (parent: string): string =>
  `${parent} is verified on-chain and designates this resolver. The address is ${parent}'s word — no proof covers it.`

export const targetChangedLine = (): string =>
  'Repointed since the last checkpoint — the current address is newer than its proof.'

// ── Warning tones (states doc §2) ───────────────────────────────────────────

export type Tone = 'depth' | 'info' | 'couldnt-check' | 'alarm'

export const WARNING_TONE: Record<WarningCode, Tone> = {
  QUORUM_BELOW_SPEC: 'info',
  PROOF_PENDING: 'depth',
  TARGET_CHANGED_SINCE_CHECKPOINT: 'depth',
  DELEGATE_HOST_UNPROVEN: 'info',
  DELEGATED_ANSWER: 'info',
  ROOT_HEIGHTS_DIFFER: 'couldnt-check',
  ANCHOR_NOT_CHECKED: 'info',
  ANCHOR_UNAVAILABLE: 'couldnt-check',
  ANCHOR_QUORUM_NOT_MET: 'depth',
  ANCHOR_STALE: 'couldnt-check',
}

/**
 * Warnings whose content the UI already renders through a dedicated element,
 * so a second line would say it twice: the quorum count is the "Verified by
 * N" line, the delegated distinction is the badge and explainer, and
 * ANCHOR_NOT_CHECKED is the standing state while no publisher list ships —
 * a quiet status, not a note.
 */
export const RENDERED_ELSEWHERE: ReadonlySet<WarningCode> = new Set([
  'QUORUM_BELOW_SPEC',
  'DELEGATED_ANSWER',
  'PROOF_PENDING',
  'TARGET_CHANGED_SINCE_CHECKPOINT',
  'ANCHOR_NOT_CHECKED',
])

export const WARNING_TEXT: Record<WarningCode, string> = {
  QUORUM_BELOW_SPEC: 'One resolver is configured to answer.',
  PROOF_PENDING: proofPendingLine(),
  TARGET_CHANGED_SINCE_CHECKPOINT: targetChangedLine(),
  DELEGATE_HOST_UNPROVEN: 'The delegate host came from the live record, not a proven one.',
  DELEGATED_ANSWER: 'This address is the delegate host’s word — no proof covers it.',
  ROOT_HEIGHTS_DIFFER: 'Couldn’t compare resolver checkpoints this time.',
  ANCHOR_NOT_CHECKED: 'Second-chain check not run.',
  ANCHOR_UNAVAILABLE: 'Couldn’t check the second-chain anchor.',
  ANCHOR_QUORUM_NOT_MET: 'Anchor pending — publishers post each checkpoint within hours.',
  ANCHOR_STALE: 'Couldn’t confirm a recent anchor.',
}

// ── Halting failures (alarm tier) and availability failures ────────────────

export const alarmHeadline = (): string => 'Stop — resolvers disagree'

export const alarmBody = (code: string): string => {
  switch (code) {
    case 'PROOF_INVALID':
      return 'A resolver served a proof that does not hold. Do not pay any address it showed. This is the failure the verification exists to catch.'
    case 'QUORUM_DISAGREEMENT':
    case 'QUORUM_ROOT_MISMATCH':
      return 'The configured resolvers gave different answers. No address is shown, because there is no basis to pick one.'
    case 'CHECKPOINT_BINDING_INVALID':
      return 'A resolver contradicted its own checkpoint. Do not pay any address it showed.'
    case 'ANCHOR_MISMATCH':
      return 'The anchored checkpoint does not match what this resolver served. Do not pay any address it showed.'
    case 'ANCHOR_DIVERGENCE':
      return 'Anchor publishers contradict each other about the registry. Resolution is stopped.'
    default:
      return 'Verification failed. No address is shown.'
  }
}

export const unreachableLine = (): string =>
  'Couldn’t reach enough resolvers. Nothing is wrong with the name — try again.'

// ── Delegates (never blame the subdomain) ───────────────────────────────────

export const delegateFailedLine = (parent: string): string =>
  `${parent}’s resolver did not answer. Whether the subdomain exists is only its owner’s to say.`

export const parentNotDelegatingLine = (parent: string): string =>
  `${parent} doesn’t delegate subdomains.`

// ── Name states (states doc §1) ─────────────────────────────────────────────

export const availableLine = (): string => 'Available'

export const reservedLine = (): string =>
  'Reserved — held by the registry and not open for registration.'

export const graceLine = (untilDate: string): string =>
  `Expired — in grace until ${untilDate}. It still belongs to its owner and can be renewed. It is not available.`

export const pendingTransferLine = (newOwner: string, whenDate: string): string =>
  `Transferring to ${newOwner}, ${whenDate}. Until then it stays under the current owner’s control.`

export const forSaleLine = (priceNim: string): string => `For sale at ${priceNim} NIM`

export const feeChangeLine = (whenDate: string): string =>
  `Fees change ${whenDate} — a scheduled governance update.`

export const renewDueLine = (whenDate: string): string => `Renew before ${whenDate}`

/** List-row form of the grace state: renewable until the grace **end** date. */
export const graceBadge = (untilDate: string): string => `In grace — renew by ${untilDate}`

// ── Gate reasons (states doc §4; shown on disabled actions) ─────────────────

export const GATE_REASON_TEXT: Record<GateReason, string> = {
  taken: 'This name is registered.',
  reserved: 'Reserved names can’t be registered.',
  'in-grace': 'In grace — only renewal works until it ends.',
  'no-record': 'This name isn’t registered.',
  'no-viewer': 'Connect a wallet to act on names.',
  'not-owner': 'Only the owner can do this.',
  'nothing-to-cancel': 'Nothing is pending on this name.',
  'offer-irrevocable': 'The offer is in its irrevocable window.',
  'offer-open': 'An offer is already open — cancel it first.',
  'no-offer': 'No open offer on this name.',
}

// ── Input validation (§4.1 in plain words, field-level) ────────────────────

const NAME_REASON_TEXT: Record<string, string> = {
  TOO_SHORT: 'Names this short are reserved — 5 characters or more.',
  TOO_LONG: 'Too long — 24 characters at most.',
  BAD_CHARACTER: 'Only a–z, 0–9 and hyphens.',
  NO_LETTER: 'A name needs at least one letter.',
  LEADING_HYPHEN: 'Can’t start with a hyphen.',
  TRAILING_HYPHEN: 'Can’t end with a hyphen.',
  DOUBLE_HYPHEN: 'No two hyphens in a row.',
  INTERIOR_DIGIT: 'Digits can’t sit inside letters — only lead or trail.',
  BOUNDARY_DIGIT: 'Digits can only lead or trail, not both.',
  RESERVED: 'This name is reserved.',
}

export function invalidQueryLine(reason: QueryInvalidReason, detail: string | null): string {
  if (reason === 'TOO_MANY_DOTS') return 'One dot at most — name, or label.name.'
  const base = reason === 'BAD_LABEL' ? 'The part before the dot: ' : ''
  const explained = detail !== null ? NAME_REASON_TEXT[detail] : undefined
  return `${base}${explained ?? 'Not a valid name.'}`
}

// ── Buy (§8.5 #10 — wording fixed now, flow blocked on the probe) ──────────

export const custodialWarning = (): string =>
  'Settlement is custodial: if this purchase loses a race or hits a cancelled offer, the refund comes from the marketplace operator — auditable in the public log, but a promise, not a protocol rule.'

export const sendsDisabledLine = (): string =>
  'Sending isn’t enabled in this build yet.'

// ── Send flows (docs/app-ux.md §4 — one state machine, one vocabulary) ─────

export const ACTION_LABEL: Record<AppAction, string> = {
  register: 'Register',
  setTarget: 'Change where it points',
  transfer: 'Transfer ownership',
  delegate: 'Set subdomain resolver',
  cancel: 'Cancel what’s pending',
  renew: 'Renew',
  offer: 'Put up for sale',
  buy: 'Buy',
}

export const sendSubmittingLine = (): string => 'Waiting for the wallet…'

export const sendConfirmingLine = (): string => 'Sent — confirming…'

export const sendConfirmedLine = (): string => 'Done.'

export const sendDeclinedLine = (): string => 'Nothing was sent.'

/** Never "sent ✓": the network did not show the effect, and that is all anyone can say. */
export const sendUnconfirmedLine = (): string =>
  'Not confirmed — the network did not include this transaction. Check the name again before retrying.'

/**
 * The checker was down, not the send — a broken checker never reads as a
 * negative result. No failure claim, no retry prompt: a retry re-signs a
 * different transaction and can pay a second fee.
 */
export const sendUncheckedLine = (): string =>
  'Sent to the wallet — couldn’t confirm, because the service didn’t answer. It may well have gone through; check again later.'

export const sendNoRpcLine = (): string =>
  'No RPC endpoint is configured (VITE_NNS_RPC), so nothing can be broadcast.'

export const payProbeGatedLine = (): string =>
  'Sending from Nimiq Pay waits on the fee test. The desktop app with Nimiq Hub can send today.'

export const connectHubLabel = (): string => 'Connect Nimiq Hub'

export const addAddressLabel = (): string => 'Add another address'

export const buyAcknowledgeLabel = (): string =>
  'I understand a refund would come from the marketplace operator'

// ── Pinning (§8.5; states doc §2 — mismatch is the alarm tier) ─────────────

export const pinFirstUseLine = (): string => 'First time you’ve used this name on this device.'

export const pinMismatchTitle = (): string => 'Stop — this name changed address'

export const pinMismatchBody = (query: string, sinceDate: string): string =>
  `When you last used ${query} on this device (${sinceDate}), it pointed to a different address. The owner may have repointed it — or someone is redirecting payments. Do not pay until you know which.`

export const pinPreviousLabel = (): string => 'Address you used before'

export const pinCurrentLabel = (): string => 'Address it points to now'

export const pinOverrideLabel = (): string => 'Use the new address anyway'

export const pinOverrideConfirmLabel = (): string => 'Yes — replace what this device remembers'

// ── NC chat (docs/app-chat.md §5 — wording is part of the threat model) ────

export const messageOwnerLabel = (): string => 'Message the owner'

export const chatPublicNotice = (): string =>
  'Messages are public, permanent, and attached to your address — anyone can read them on-chain, forever.'

export const chatOwnNameLine = (): string =>
  'This name is yours — a message to yourself can’t be sent.'

export const chatBudgetLine = (used: number, budget: number): string => `${used}/${budget} bytes`

export const CHAT_ENCODE_TEXT: Record<'BAD_NAME' | 'EMPTY_MESSAGE' | 'CONTROL_CHARS' | 'OVER_BUDGET', string> = {
  BAD_NAME: 'Not a valid name.',
  EMPTY_MESSAGE: 'Write something first.',
  CONTROL_CHARS: 'Plain text only — no control characters.',
  OVER_BUDGET: 'Too long — messages travel in a 64-byte transaction.',
}

export const inboxWindowLine = (sinceDate: string): string => `Messages since ${sinceDate}.`

export const inboxOtherBucketLabel = (): string => 'Other messages'

export const inboxOtherBucketNote = (): string =>
  'About names that aren’t yours at this address — the name in a message is the sender’s claim, nothing more.'

export const inboxNoWalletLine = (): string =>
  'Your inbox is read from your wallet address, and there’s no wallet here.'

export const inboxNotConfiguredLine = (): string =>
  'No RPC endpoint configured. Set VITE_NNS_RPC to the operator-run relay URL.'

/** Attributed to the inbox service, never to resolvers — and nothing is lost. */
export const inboxDownLine = (): string =>
  'Couldn’t load messages — the inbox service didn’t answer. Your messages are on-chain and will appear when it returns.'

export const inboxEmptyLine = (): string =>
  'When someone messages one of your names, it lands here.'
