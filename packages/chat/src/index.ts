/**
 * @nns/chat — the NC message convention (`docs/app-chat.md`).
 *
 * **Not protocol.** Nothing in this package reaches `@nns/core`'s state, the
 * reducer, the log, the conformance vectors, a checkpoint or a root, and
 * nothing about NC goes in the spec. It exists so the app and the chat index
 * share one parser instead of drifting apart — the failure the app's
 * single-implementation rule was written to prevent.
 */

export { CHAT_DUST_LUNA, CHAT_MAX_BYTES, CHAT_PREFIX, chatByteBudget, encodeChatPayload, messageBytes, parseChatPayload, validateChatSubject } from './format.js'
export type { ChatEncodeFailure, ChatEncodeResult, ChatPayload } from './format.js'
export { bytesToHex, hexToBytes } from './hex.js'
export { PEER_NAMES_SHOWN, attributedFrom, chatConversations, chatMessages, peerIdentity, subjectBreaks } from './inbox.js'
export type { ChatConversation, ChatMessage, ChatTx, PeerIdentity, PeerName, SubjectBreak } from './inbox.js'
