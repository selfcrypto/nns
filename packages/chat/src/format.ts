/**
 * NC — name-to-owner messages: the wire format. The convention is
 * `docs/app-chat.md`; this package is its only implementation, shared by the
 * app and the chat index so there is exactly one parser. Pure: no I/O.
 *
 * The one rule that keeps it harmless: the prefix is `NC1` and must never
 * become anything starting `NNS1` — that boundary is what keeps every
 * message invisible to every NNS indexer (§7.5), instead of a forfeited,
 * log-spamming `UNKNOWN_TYPE`.
 *
 * **`@nimiqnames/core` is imported for one thing: `LAUNCH_HEIGHT`.** It used
 * to be imported for `validateNameSyntax` and `validateLabel`, because the
 * payload carried a subject name whose syntax had to be checked. It no longer
 * does (2026-09-15, below). Nothing here reaches core's state, the reducer,
 * the log or any root.
 */

import { CONSTANTS } from '@nimiqnames/core'
import { bytesToHex, hexToBytes } from './hex.js'

export const CHAT_PREFIX = 'NC1'
/** The network's measured silent-drop boundary (docs/rpc-reference.md §4). */
export const CHAT_MAX_BYTES = 64
export const CHAT_DUST_LUNA = 1n

/**
 * No NC message predates the registry it talks about.
 *
 * The inbox showed conversations from before the era it runs in, about names
 * whose ownership had since moved, so a thread could be headed by a name the
 * address no longer holds (Kike, 2026-09-15). A message below `LAUNCH_HEIGHT`
 * is about a registry that does not exist here, so it is not an NC message at
 * all. The floor belongs to the convention rather than to one reader: the app
 * and the index both apply it, and an index configured below it is refused.
 */
export const CHAT_MIN_HEIGHT = CONSTANTS.LAUNCH_HEIGHT

/**
 * Message budget in UTF-8 **bytes**: 64 − 3. Flat, because the payload is the
 * message and nothing else.
 *
 * It used to be `64 − 3 − subject − 1`, which left 57 bytes for a message
 * about a 5-character name and **11** for the longest dotted subject there is.
 */
export function chatByteBudget(): number {
  return CHAT_MAX_BYTES - CHAT_PREFIX.length
}

export function messageBytes(message: string): number {
  return new TextEncoder().encode(message).length
}

export type ChatEncodeFailure = 'EMPTY_MESSAGE' | 'CONTROL_CHARS' | 'OVER_BUDGET'

export type ChatEncodeResult =
  | { readonly ok: true; readonly dataHex: string }
  | { readonly ok: false; readonly reason: ChatEncodeFailure }

// eslint-disable-next-line no-control-regex -- the point is to refuse them
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * The payload is the message.
 *
 * It was `NC1<name>|<message>`, where `<name>` was the subject the sender
 * typed in. Kike, 2026-09-15: *"That var on the payload doesn't makes sense at
 * all. Name should be retrieved (if any) by the app with on-chain data against
 * the address that sent the message, and that's all."* He is right, and the
 * cost of the field was not only bytes: a sender-written name is the only
 * reason the inbox ever had to disclaim one. It marked an incoming message
 * whose subject the recipient did not own — in red, beside a hint saying that
 * names here come from the registry — so the screen contradicted itself about
 * two different names it never distinguished. With nothing asserted there is
 * nothing to check, and the peer's names come from `/address/{addr}/names`
 * like they always did.
 *
 * **The `NC1` prefix is kept.** `CHAT_MIN_HEIGHT` is what makes that safe:
 * every message from before this era is dropped, so an old three-field payload
 * can only reach a reader if it was sent in this era, where it reads as a
 * message beginning `name|`. A version bump was the alternative and would have
 * hidden those instead (Kike chose to keep the prefix).
 */
export function encodeChatPayload(message: string): ChatEncodeResult {
  if (message.length === 0) return { ok: false, reason: 'EMPTY_MESSAGE' }
  if (CONTROL.test(message)) return { ok: false, reason: 'CONTROL_CHARS' }
  const bytes = new TextEncoder().encode(`${CHAT_PREFIX}${message}`)
  if (bytes.length > CHAT_MAX_BYTES) return { ok: false, reason: 'OVER_BUDGET' }
  return { ok: true, dataHex: bytesToHex(bytes) }
}

export interface ChatPayload {
  readonly message: string
}

/** `null` for anything that is not a well-formed NC1 payload — never a throw. */
export function parseChatPayload(dataHex: string): ChatPayload | null {
  const bytes = hexToBytes(dataHex)
  if (bytes === null || bytes.length > CHAT_MAX_BYTES) return null
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  if (!text.startsWith(CHAT_PREFIX)) return null
  const message = text.slice(CHAT_PREFIX.length)
  if (message.length === 0 || CONTROL.test(message)) return null
  return { message }
}
