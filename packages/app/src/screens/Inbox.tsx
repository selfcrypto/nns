import { useMemo, useState } from 'react'
import {
  chatConversations,
  chatMessages,
  peerIdentity,
  subjectBreaks,
  type ChatConversation,
  type ChatTx,
  type PeerName,
} from '@nns/chat'
import { getOwnedNames } from '../lib/api'
import { chatEndpoint } from '../config'
import { fetchChatIndex, type ChatIndexPage } from '../lib/chatIndex'
import { hideSender, loadHiddenSenders, unhideSender } from '../lib/hidden'
import { defaultTransport, fetchHistory } from '../lib/history'
import { primaryAddress } from '../lib/identity'
import { approxDate, ellipsizeAddress, formatApproxDate } from '../lib/format'
import { apiBase } from '../lib/nns'
import { useAsync } from '../lib/useAsync'
import type { Wallet } from '../lib/wallet'
import {
  hiddenSendersLabel,
  hideSenderAction,
  inboxDownLine,
  inboxEmptyLine,
  inboxEmptyTitle,
  inboxNoWalletLine,
  inboxNoWalletTitle,
  inboxNotConfiguredLine,
  inboxNotConfiguredTitle,
  inboxWindowLine,
  notYourNameLine,
  peerMoreNamesLine,
  peerNamesHint,
  unhideSenderAction,
} from '../lib/wording'
import { Composer } from '../components/Composer'
import { EmptyState, Identicon, NameText, Spinner } from '../components/ui'

/**
 * The NC inbox (docs/app-chat.md §4), across the whole identity set: one
 * history fetch per address, merged and deduped in `chatMessages`.
 *
 * **One conversation per peer**, as any messenger has. It used to be one per
 * (peer, name), split into "yours" and a collapsed "other messages" bucket by
 * whether the subject name was owned here — a test that assumed every message
 * was incoming, and so filed conversations the reader had *started* under a
 * spoofing warning. The doubt now sits on the single incoming message it is
 * true of, and the reader gets a hide list for the rest.
 *
 * Who a peer is comes from the registry (`/address/{addr}/names`), never from
 * the payload: the subject name is the sender's claim, the names beside an
 * address are the indexer's answer.
 */
export function InboxScreen({ wallet }: { wallet: Wallet | null }) {
  const viewers = wallet?.identity.addresses ?? []
  const transport = defaultTransport()
  // The index when an operator runs one, the chain when nobody does. Both
  // answer the same shape, and both hand back payloads this app parses itself.
  const index = chatEndpoint()
  const source = index !== null ? 'index' : transport !== null ? 'chain' : null
  const [openPeer, setOpenPeer] = useState<string | null>(null)
  const [hidden, setHidden] = useState<readonly string[]>(() => loadHiddenSenders(localStorage))

  const data = useAsync(
    viewers.length === 0 || source === null
      ? null
      : async () => {
          const [pages, ownedPages] = await Promise.all([
            Promise.all(
              viewers.map(async (address): Promise<ChatIndexPage> => {
                if (index !== null) return fetchChatIndex(index, address)
                // A raw history pull declares no window: what it saw is all it
                // can claim, and `oldestBlock` already carries that.
                return { ...(await fetchHistory(transport!, address)), startHeight: null }
              }),
            ),
            Promise.all(viewers.map((address) => getOwnedNames(apiBase(), address))),
          ])
          const txs: ChatTx[] = pages.flatMap((page) => [...page.txs])
          // The index states the window it was built with; a raw history pull
          // can only report the deepest row it happened to see.
          const oldestBlock = pages.reduce<number | null>(
            (oldest, page) => {
              const claim = page.startHeight ?? page.oldestBlock
              return claim === null ? oldest : oldest === null ? claim : Math.min(oldest, claim)
            },
            null,
          )
          return {
            txs,
            oldestBlock,
            ownedNames: new Set(ownedPages.flatMap((page) => page.names.map((entry) => entry.name))),
            height: ownedPages[0]?.height ?? 0,
          }
        },
    [viewers.join(' '), transport === null],
  )

  const conversations = useMemo(
    () => (data.status === 'done' ? chatConversations(chatMessages(data.value.txs, viewers)) : []),
    [data, viewers],
  )

  const peers = useMemo(() => [...new Set(conversations.map((one) => one.peer))].sort(), [conversations])

  // Identity is a second, independent read: the inbox renders without it and
  // falls back to the address, so a slow or failed registry never withholds
  // anyone's messages.
  const peerNames = useAsync(
    peers.length === 0
      ? null
      : async () => {
          const pages = await Promise.all(peers.map((peer) => getOwnedNames(apiBase(), peer)))
          return new Map(peers.map((peer, index) => [peer, pages[index]?.names ?? []] as const))
        },
    [peers.join(' ')],
  )
  const namesFor = (address: string): readonly PeerName[] =>
    peerNames.status === 'done' ? (peerNames.value.get(address) ?? []) : []

  if (viewers.length === 0) {
    return (
      <div className="screen">
        <EmptyState title={inboxNoWalletTitle()} body={inboxNoWalletLine()} />
      </div>
    )
  }
  if (source === null) {
    return (
      <div className="screen">
        <EmptyState title={inboxNotConfiguredTitle()} body={inboxNotConfiguredLine()} />
      </div>
    )
  }
  if (data.status === 'loading' || data.status === 'idle') {
    return (
      <div className="screen">
        <Spinner />
      </div>
    )
  }
  if (data.status === 'error') {
    // The inbox service, not the resolvers — and nothing is lost.
    return (
      <div className="screen">
        <p className="field-error">{inboxDownLine()}</p>
      </div>
    )
  }

  const { ownedNames, height, oldestBlock } = data.value
  const selected = conversations.find((one) => one.peer === openPeer) ?? null
  const shown = conversations.filter((one) => !hidden.includes(one.peer))
  const muted = conversations.filter((one) => hidden.includes(one.peer))

  if (selected !== null) {
    return (
      <div className="screen">
        <button type="button" className="back" onClick={() => setOpenPeer(null)}>
          ‹ Inbox
        </button>
        <ConversationView
          conversation={selected}
          names={namesFor(selected.peer)}
          ownedNames={ownedNames}
          wallet={wallet}
          hidden={hidden.includes(selected.peer)}
          onHide={() => setHidden(hideSender(localStorage, selected.peer))}
          onUnhide={() => setHidden(unhideSender(localStorage, selected.peer))}
        />
      </div>
    )
  }

  return (
    <div className="screen">
      {conversations.length === 0 && <EmptyState title={inboxEmptyTitle()} body={inboxEmptyLine()} />}
      <ConversationList conversations={shown} namesFor={namesFor} onOpen={setOpenPeer} />
      {muted.length > 0 && (
        <details className="hidden-bucket">
          <summary>{hiddenSendersLabel(muted.length)}</summary>
          <ConversationList conversations={muted} namesFor={namesFor} onOpen={setOpenPeer} />
        </details>
      )}
      {oldestBlock !== null && (
        <p className="note note-info">{inboxWindowLine(formatApproxDate(approxDate(oldestBlock, height, Date.now())))}</p>
      )}
    </div>
  )
}

/**
 * A peer's names, or their address when they hold none. Never the subject
 * name of a message — that would be pairing someone's address with a name
 * they were only written *about*.
 */
function PeerTitle({ address, names }: { address: string; names: readonly PeerName[] }) {
  const identity = peerIdentity(names)
  if (identity.shown.length === 0) return <span className="nns-name">{ellipsizeAddress(address)}</span>
  return (
    <>
      {identity.shown.map((name, index) => (
        <span key={name}>
          {index > 0 && <span className="peer-sep"> · </span>}
          <NameText>{name}</NameText>
        </span>
      ))}
      {identity.more > 0 && <span className="peer-more">{peerMoreNamesLine(identity.more)}</span>}
    </>
  )
}

function ConversationList({
  conversations,
  namesFor,
  onOpen,
}: {
  conversations: readonly ChatConversation[]
  namesFor: (address: string) => readonly PeerName[]
  onOpen: (peer: string) => void
}) {
  if (conversations.length === 0) return null
  return (
    <ul className="name-list">
      {conversations.map((conversation) => {
        const last = conversation.messages[conversation.messages.length - 1]
        const names = namesFor(conversation.peer)
        return (
          <li key={conversation.peer}>
            <button type="button" className="name-row thread-row" onClick={() => onOpen(conversation.peer)}>
              <Identicon address={conversation.peer} size={32} />
              <span className="thread-main">
                <span className="name-row-name">
                  <PeerTitle address={conversation.peer} names={names} />
                </span>
                {names.length > 0 && <span className="thread-peer nns-name">{ellipsizeAddress(conversation.peer)}</span>}
                <span className="thread-preview">{last?.message}</span>
              </span>
              <span className="thread-time">{new Date(conversation.lastTimestamp).toLocaleDateString()}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function ConversationView({
  conversation,
  names,
  ownedNames,
  wallet,
  hidden,
  onHide,
  onUnhide,
}: {
  conversation: ChatConversation
  names: readonly PeerName[]
  ownedNames: ReadonlySet<string>
  wallet: Wallet | null
  hidden: boolean
  onHide: () => void
  onUnhide: () => void
}) {
  return (
    <div className="thread">
      <div className="thread-head">
        <Identicon address={conversation.peer} size={32} />
        <div className="thread-head-main">
          <p className="name-row-name">
            <PeerTitle address={conversation.peer} names={names} />
          </p>
          {/* The address always stays visible: the names above it are a registry
              lookup, and the address is the thing that actually sent. */}
          <p className="thread-peer nns-name">{conversation.peer}</p>
        </div>
        <button type="button" className="back-link" onClick={hidden ? onUnhide : onHide}>
          {hidden ? unhideSenderAction() : hideSenderAction()}
        </button>
      </div>
      {names.length > 0 && <p className="note note-info">{peerNamesHint()}</p>}
      <div className="bubbles">
        {subjectBreaks(conversation.messages).map(({ message, showSubject }) => (
          <div key={message.hash} className="bubble-group">
            {showSubject && (
              <p className="subject-break">
                about <NameText>{message.name}</NameText>
              </p>
            )}
            <p className={message.direction === 'in' ? 'bubble bubble-in' : 'bubble bubble-out'}>
              {message.message}
              <span className="bubble-time">{new Date(message.timestamp).toLocaleString()}</span>
            </p>
            {/* Only an incoming message can be wrong about whose name it is. */}
            {message.direction === 'in' && !ownedNames.has(message.name) && (
              <p className="note note-info bubble-note">{notYourNameLine()}</p>
            )}
          </div>
        ))}
      </div>
      <Composer
        name={conversation.lastName}
        recipient={conversation.peer}
        wallet={wallet}
        sender={wallet === null ? null : primaryAddress(wallet.identity)}
        heading="Reply"
      />
    </div>
  )
}
