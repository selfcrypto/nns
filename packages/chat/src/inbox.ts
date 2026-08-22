/**
 * Inbox derivation: raw transactions in, conversations out. Pure, so the
 * rules are tested rather than expressed in a component — and so the app and
 * the chat index agree on what a conversation is.
 */

import { SENDER_TYPE_HTLC, formatAddress, htlcAuthorizer } from '@nns/core'
import { parseChatPayload } from './format.js'


export interface ChatTx {
  readonly hash: string
  readonly blockNumber: number
  /** Milliseconds — measured on the real object (docs/rpc-reference.md §3). */
  readonly timestamp: number
  readonly from: string
  /**
   * The sender's account type (`fromType` on the RPC object) and the
   * transaction's proof, hex. Optional because a chat-index row does not
   * carry them — its `sender` is already attributed at scan time. Absent
   * fields mean `attributedFrom` answers `from` unchanged.
   */
  readonly fromType?: number | undefined
  readonly proof?: string | undefined
  readonly to: string
  readonly recipientData: string
  readonly executionResult: boolean
}

/**
 * Who a transaction is from, for every rule in this file: the account,
 * unless it is an HTLC whose proof names its authorizing key — §7.2's
 * effective sender (r25), read through core's parser rather than
 * reimplemented. Nimiq Pay signs every mini-app send from an HTLC it
 * routinely destroys; the raw `from` is therefore an address that stops
 * existing, holds no names, and can never receive a reply. The authorizing
 * key's address is the durable one, and it is what the registry attributes
 * ownership to — so it is the peer, the direction test, and the reply
 * target here too.
 *
 * Spaced form, matching what the RPC serves in `from`/`to` and what the
 * identity set holds.
 */
export function attributedFrom(tx: Pick<ChatTx, 'from' | 'fromType' | 'proof'>): string {
  if (tx.fromType !== SENDER_TYPE_HTLC || tx.proof === undefined) return tx.from
  const authorizer = htlcAuthorizer(tx.proof)
  return authorizer === null ? tx.from : formatAddress(authorizer)
}

export interface ChatMessage {
  readonly hash: string
  readonly direction: 'in' | 'out'
  readonly peer: string
  readonly name: string
  readonly message: string
  readonly timestamp: number
  readonly blockNumber: number
}

export function chatMessages(txs: readonly ChatTx[], myAddresses: readonly string[]): readonly ChatMessage[] {
  const messages: ChatMessage[] = []
  const mine = new Set(myAddresses)
  const seen = new Set<string>()
  for (const tx of txs) {
    if (!tx.executionResult) continue
    if (seen.has(tx.hash)) continue // one tx appears in several addresses' histories
    seen.add(tx.hash)
    const payload = parseChatPayload(tx.recipientData)
    if (payload === null) continue
    const from = attributedFrom(tx)
    // Between two of my own addresses, the sender's view wins: 'out'.
    const incoming = mine.has(tx.to) && !mine.has(from)
    if (!incoming && !mine.has(from)) continue
    messages.push({
      hash: tx.hash,
      direction: incoming ? 'in' : 'out',
      peer: incoming ? from : tx.to,
      name: payload.name,
      message: payload.message,
      timestamp: tx.timestamp,
      blockNumber: tx.blockNumber,
    })
  }
  return messages.sort((a, b) => a.timestamp - b.timestamp)
}

export interface ChatConversation {
  /**
   * A conversation is **one per peer address**, not one per (peer, name).
   * The name a message carries is its subject — which of the recipient's
   * names it is about — and one person may write about several over time;
   * keying on it made the same person two rows, which is not what a
   * conversation is. The subject stays visible per message (`subjectBreaks`).
   */
  readonly peer: string
  readonly messages: readonly ChatMessage[]
  readonly lastTimestamp: number
  /** The newest message's subject — what a reply puts on the wire. */
  readonly lastName: string
}

export function chatConversations(messages: readonly ChatMessage[]): readonly ChatConversation[] {
  const byPeer = new Map<string, ChatMessage[]>()
  for (const message of messages) {
    const existing = byPeer.get(message.peer)
    if (existing) existing.push(message)
    else byPeer.set(message.peer, [message])
  }
  return [...byPeer.values()]
    .map((thread) => {
      const last = thread[thread.length - 1]
      return {
        peer: thread[0]?.peer ?? '',
        messages: thread,
        lastTimestamp: last?.timestamp ?? 0,
        lastName: last?.name ?? '',
      }
    })
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
}

export interface SubjectBreak {
  readonly message: ChatMessage
  /** True on the first message and wherever the subject name changes. */
  readonly showSubject: boolean
}

/**
 * Where to draw "about <name>" inside a conversation. Pure, so the rule is
 * tested rather than written into JSX: the subject is announced once, and
 * again only where it actually changes.
 */
export function subjectBreaks(messages: readonly ChatMessage[]): readonly SubjectBreak[] {
  let previous: string | null = null
  return messages.map((message) => {
    const showSubject = message.name !== previous
    previous = message.name
    return { message, showSubject }
  })
}

// ── Who the peer is ─────────────────────────────────────────────────────────

/**
 * A message's sender is an address, and the address is all the wire carries —
 * putting a sender name in the payload would spend scarce bytes on a claim
 * anyone could forge. The names an address *holds* are a registry fact
 * instead, so identity is reverse-resolved from the API and never read from
 * the payload. `docs/app-chat.md` §5 used to forbid this on the grounds that
 * it "presents an unverified claim as identity"; that conflated the payload's
 * name field, which is a claim, with an owner → names lookup, which is not.
 */
export interface PeerName {
  readonly name: string
  readonly status: 'REGISTERED' | 'GRACE'
}

/** How many names fit a thread header before the rest become a count. */
export const PEER_NAMES_SHOWN = 3

export interface PeerIdentity {
  readonly shown: readonly string[]
  readonly more: number
}

/**
 * The names to show for an address, most identifying first.
 *
 * `GRACE` is excluded: the name has stopped resolving, so showing it as
 * current identity would be a small lie at exactly the moment a reader is
 * deciding whether to trust a message. Order is shortest-then-alphabetical
 * and the cap is a display bound, not a rule — an address may hold hundreds.
 */
export function peerIdentity(names: readonly PeerName[], max = PEER_NAMES_SHOWN): PeerIdentity {
  const live = names
    .filter((entry) => entry.status === 'REGISTERED')
    .map((entry) => entry.name)
    .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
  return { shown: live.slice(0, max), more: Math.max(0, live.length - max) }
}
