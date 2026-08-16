import { useMemo, useState } from 'react'
import { chatMessages, chatThreads, type ChatThread, type ChatTx } from '../lib/chat'
import { getOwnedNames } from '../lib/api'
import { defaultTransport, fetchHistory } from '../lib/history'
import { primaryAddress } from '../lib/identity'
import { approxDate, ellipsizeAddress, formatApproxDate } from '../lib/format'
import { apiBase } from '../lib/nns'
import { useAsync } from '../lib/useAsync'
import type { Wallet } from '../lib/wallet'
import {
  inboxDownLine,
  inboxEmptyLine,
  inboxNoWalletLine,
  inboxNotConfiguredLine,
  inboxOtherBucketLabel,
  inboxOtherBucketNote,
  inboxWindowLine,
} from '../lib/wording'
import { Composer } from '../components/Composer'
import { EmptyState, Identicon, NameText, Spinner } from '../components/ui'

/**
 * The NC inbox (docs/app-chat.md §4), across the whole identity set: one
 * history fetch per address, merged and deduped in `chatMessages`. Threads
 * keyed (peer, name); ownership checked against the API, never taken from
 * the payload.
 */
export function InboxScreen({ wallet }: { wallet: Wallet | null }) {
  const viewers = wallet?.identity.addresses ?? []
  const transport = defaultTransport()
  const [openThread, setOpenThread] = useState<string | null>(null)

  const data = useAsync(
    viewers.length === 0 || transport === null
      ? null
      : async () => {
          const [pages, ownedPages] = await Promise.all([
            Promise.all(viewers.map((address) => fetchHistory(transport, address))),
            Promise.all(viewers.map((address) => getOwnedNames(apiBase(), address))),
          ])
          const txs: ChatTx[] = pages.flatMap((page) => [...page.txs])
          const oldestBlock = pages.reduce<number | null>(
            (oldest, page) =>
              page.oldestBlock === null ? oldest : oldest === null ? page.oldestBlock : Math.min(oldest, page.oldestBlock),
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

  const threads = useMemo(
    () => (data.status === 'done' ? chatThreads(chatMessages(data.value.txs, viewers)) : []),
    [data, viewers],
  )

  if (viewers.length === 0) {
    return (
      <div className="screen">
        <EmptyState title="No wallet connected" body={inboxNoWalletLine()} />
      </div>
    )
  }
  if (transport === null) {
    return (
      <div className="screen">
        <EmptyState title="Inbox not set up" body={inboxNotConfiguredLine()} />
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
  const mine = threads.filter((thread) => ownedNames.has(thread.name))
  const other = threads.filter((thread) => !ownedNames.has(thread.name))
  const selected = threads.find((thread) => `${thread.peer} ${thread.name}` === openThread) ?? null

  if (selected !== null) {
    return (
      <div className="screen">
        <button type="button" className="back" onClick={() => setOpenThread(null)}>
          ‹ Inbox
        </button>
        <ThreadView thread={selected} owned={ownedNames.has(selected.name)} wallet={wallet} />
      </div>
    )
  }

  return (
    <div className="screen">
      {threads.length === 0 && <EmptyState title="No messages" body={inboxEmptyLine()} />}
      <ThreadList threads={mine} onOpen={setOpenThread} />
      {other.length > 0 && (
        <details className="other-bucket">
          <summary>
            {inboxOtherBucketLabel()} ({other.length})
          </summary>
          <p className="note note-info">{inboxOtherBucketNote()}</p>
          <ThreadList threads={other} onOpen={setOpenThread} />
        </details>
      )}
      {oldestBlock !== null && (
        <p className="note note-info">{inboxWindowLine(formatApproxDate(approxDate(oldestBlock, height, Date.now())))}</p>
      )}
    </div>
  )
}

function ThreadList({ threads, onOpen }: { threads: readonly ChatThread[]; onOpen: (key: string) => void }) {
  if (threads.length === 0) return null
  return (
    <ul className="name-list">
      {threads.map((thread) => {
        const last = thread.messages[thread.messages.length - 1]
        return (
          <li key={`${thread.peer} ${thread.name}`}>
            <button type="button" className="name-row thread-row" onClick={() => onOpen(`${thread.peer} ${thread.name}`)}>
              <Identicon address={thread.peer} size={32} />
              <span className="thread-main">
                <span className="name-row-name">
                  <NameText>{thread.name}</NameText>
                </span>
                <span className="thread-peer nns-name">{ellipsizeAddress(thread.peer)}</span>
                <span className="thread-preview">{last?.message}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function ThreadView({ thread, owned, wallet }: { thread: ChatThread; owned: boolean; wallet: Wallet | null }) {
  return (
    <div className="thread">
      <div className="thread-head">
        <Identicon address={thread.peer} size={32} />
        <div>
          <p className="name-row-name">
            <NameText>{thread.name}</NameText>
          </p>
          {/* Always the address, never a reverse-resolved name (app-chat §5). */}
          <p className="thread-peer nns-name">{thread.peer}</p>
        </div>
      </div>
      {!owned && <p className="note note-info">{inboxOtherBucketNote()}</p>}
      <div className="bubbles">
        {thread.messages.map((message) => (
          <p key={message.hash} className={message.direction === 'in' ? 'bubble bubble-in' : 'bubble bubble-out'}>
            {message.message}
            <span className="bubble-time">{new Date(message.timestamp).toLocaleString()}</span>
          </p>
        ))}
      </div>
      <Composer
        name={thread.name}
        recipient={thread.peer}
        wallet={wallet}
        sender={wallet === null ? null : primaryAddress(wallet.identity)}
        heading="Reply"
      />
    </div>
  )
}
