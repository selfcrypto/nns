import { useMemo, useState } from 'react'
import { chatMessages, chatThreads, type ChatThread } from '../lib/chat'
import { getOwnedNames } from '../lib/api'
import { fetchHistory, fetchTransport } from '../lib/history'
import { historyEndpoint } from '../config'
import { approxDate, ellipsizeAddress, formatApproxDate } from '../lib/format'
import { apiBase } from '../lib/nns'
import { useAsync } from '../lib/useAsync'
import {
  inboxEmptyLine,
  inboxNoWalletLine,
  inboxNotConfiguredLine,
  inboxOtherBucketLabel,
  inboxOtherBucketNote,
  inboxWindowLine,
  unreachableLine,
} from '../lib/wording'
import { Composer } from '../components/Composer'
import { EmptyState, Identicon, NameText, Spinner } from '../components/ui'

/**
 * The NC inbox (docs/app-chat.md §4). Read-only against the operator-run
 * history endpoint; threads keyed (peer, name); threads about names this
 * address owns lead, the rest sit muted below — a message's name field is
 * the sender's claim, so ownership is checked against the API, never taken
 * from the payload.
 */
export function InboxScreen({ viewer }: { viewer: string | null }) {
  const endpoint = historyEndpoint()
  const [openThread, setOpenThread] = useState<string | null>(null)

  const data = useAsync(
    viewer === null || endpoint === null
      ? null
      : async () => {
          const [page, owned] = await Promise.all([
            fetchHistory(fetchTransport(endpoint), viewer),
            getOwnedNames(apiBase(), viewer),
          ])
          return { page, ownedNames: new Set(owned.names.map((entry) => entry.name)), height: owned.height }
        },
    [viewer, endpoint],
  )

  const threads = useMemo(
    () => (data.status === 'done' ? chatThreads(chatMessages(data.value.page.txs, viewer ?? '')) : []),
    [data, viewer],
  )

  if (viewer === null) {
    return (
      <div className="screen">
        <EmptyState title="Open in Nimiq Pay" body={inboxNoWalletLine()} />
      </div>
    )
  }
  if (endpoint === null) {
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
    return (
      <div className="screen">
        <p className="field-error">{unreachableLine()}</p>
      </div>
    )
  }

  const { ownedNames, height, page } = data.value
  const mine = threads.filter((thread) => ownedNames.has(thread.name))
  const other = threads.filter((thread) => !ownedNames.has(thread.name))
  const selected = threads.find((thread) => `${thread.peer} ${thread.name}` === openThread) ?? null

  if (selected !== null) {
    return (
      <div className="screen">
        <button type="button" className="back" onClick={() => setOpenThread(null)}>
          ‹ Inbox
        </button>
        <ThreadView thread={selected} owned={ownedNames.has(selected.name)} />
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
      {page.oldestBlock !== null && (
        <p className="note note-info">
          {inboxWindowLine(formatApproxDate(approxDate(page.oldestBlock, height, Date.now())))}
        </p>
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

function ThreadView({ thread, owned }: { thread: ChatThread; owned: boolean }) {
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
      <Composer name={thread.name} ownName={false} heading="Reply" />
    </div>
  )
}
