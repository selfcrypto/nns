import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CHAT_MIN_HEIGHT,
  chatConversations,
  chatMessages,
  peerIdentity,
  type ChatConversation,
  type ChatTx,
  type PeerName,
} from '@nns/chat'
import { getOwnedNames, getParams } from '../lib/api'
import { chatEndpoint, explorerTxUrl } from '../config'
import { fetchChatIndex, type ChatIndexPage } from '../lib/chatIndex'
import { hideSender, loadHiddenSenders, unhideSender } from '../lib/hidden'
import { defaultTransport, fetchHistory } from '../lib/history'
import { actingAs, primaryAddress } from '../lib/identity'
import { formatBubbleTimestamp, formatThreadDate } from '../lib/dates'
import { approxDate, displayAddress, ellipsizeAddress, formatApproxDate, isTxHash } from '../lib/format'
import { writeClipboard } from '../lib/clipboard'
import { apiBase } from '../lib/nns'
import { useAsync } from '../lib/useAsync'
import type { Wallet } from '../lib/wallet'
import {
  SCREEN_SUB,
  SCREEN_TITLE,
  backToInboxAria,
  backToInboxLabel,
  copiedLabel,
  copyAddressLabel,
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
  peerMoreNamesLine,
  peerNamesHint,
  unhideSenderAction,
  viewOnExplorerLabel,
} from '../lib/wording'
import { Composer } from '../components/Composer'
import { Hint } from '../components/Hint'
import { IdentityBar } from '../components/IdentityBar'
import { ExternalIcon } from '../components/icons'
import { TrustBar } from '../components/TrustBar'
import { Identicon, NameText, Spinner } from '../components/ui'
import styles from './inbox.module.css'

/**
 * The NC inbox (docs/app-chat.md §4), across the whole identity set: one
 * history fetch per address, merged and deduped in `chatMessages`.
 *
 * **One conversation per peer**, as any messenger has.
 */
export function InboxScreen({
  wallet,
  onConnect,
}: {
  wallet: Wallet | null
  /** For the no-wallet card's own copy of the identity control. */
  onConnect: (() => void) | null
}) {
  const viewers = wallet === null ? [] : actingAs(wallet.identity)
  const transport = defaultTransport()
  // The index when an operator runs one, the chain when nobody does. Both
  // answer the same shape, and both hand back payloads this app parses itself.
  const index = chatEndpoint()
  const source = index !== null ? 'index' : transport !== null ? 'chain' : null
  const [openPeer, setOpenPeer] = useState<string | null>(null)
  const [hidden, setHidden] = useState<readonly string[]>(() => loadHiddenSenders(localStorage))

  const [reloadNonce, setReloadNonce] = useState(0)
  const retryTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const expectedMsgCountRef = useRef<number | null>(null)

  const clearRetryTimers = useCallback(() => {
    retryTimersRef.current.forEach(clearTimeout)
    retryTimersRef.current = []
    expectedMsgCountRef.current = null
  }, [])

  const handleMessageSent = useCallback((_peer: string, currentCount: number) => {
    clearRetryTimers()
    expectedMsgCountRef.current = currentCount + 1

    // 1. Immediate refetch
    setReloadNonce((n) => n + 1)

    // 2. Refetch every 5 seconds, up to 3 times (5s, 10s, 15s), then stop
    const t1 = setTimeout(() => {
      setReloadNonce((n) => n + 1)
    }, 5000)

    const t2 = setTimeout(() => {
      setReloadNonce((n) => n + 1)
    }, 10000)

    const t3 = setTimeout(() => {
      setReloadNonce((n) => n + 1)
      clearRetryTimers()
    }, 15000)

    retryTimersRef.current = [t1, t2, t3]
  }, [clearRetryTimers])

  useEffect(() => {
    return () => {
      clearRetryTimers()
    }
  }, [clearRetryTimers])

  const data = useAsync(
    viewers.length === 0 || source === null
      ? null
      : async () => {
          // `/params` is here only for the head, which turns a block height
          // into the date the window line shows. It replaced one
          // `getOwnedNames` per connected address: those were fetched to check
          // a message's subject against the names you hold, and there is no
          // subject any more (2026-09-15).
          const [pages, params] = await Promise.all([
            Promise.all(
              viewers.map(async (address): Promise<ChatIndexPage> => {
                if (index !== null) return fetchChatIndex(index, address)
                // A raw history pull declares no window: what it saw is all it
                // can claim, and `oldestBlock` already carries that.
                return { ...(await fetchHistory(transport!, address)), startHeight: null }
              }),
            ),
            getParams(apiBase()),
          ])
          const txs: ChatTx[] = pages.flatMap((page) => [...page.txs])
          // The index states the window it was built with; a raw history pull
          // can only report the deepest row it happened to see.
          const claimed = pages.reduce<number | null>(
            (oldest, page) => {
              const claim = page.startHeight ?? page.oldestBlock
              return claim === null ? oldest : oldest === null ? claim : Math.min(oldest, claim)
            },
            null,
          )
          // Never claim a window wider than what is shown: `chatMessages` drops
          // everything below `CHAT_MIN_HEIGHT`, so an index whose scan began
          // earlier does not entitle the line to promise those blocks.
          const oldestBlock = claimed === null ? null : Math.max(claimed, CHAT_MIN_HEIGHT)
          return { txs, oldestBlock, height: params.height }
        },
    [viewers.join(' '), transport === null, reloadNonce],
  )

  const [cachedData, setCachedData] = useState<{
    txs: ChatTx[]
    oldestBlock: number | null
    height: number
  } | null>(null)

  useEffect(() => {
    if (data.status === 'done') {
      setCachedData(data.value)
    }
  }, [data])

  const activeData = data.status === 'done' ? data.value : cachedData

  const conversations = useMemo(
    () => (activeData !== null ? chatConversations(chatMessages(activeData.txs, viewers)) : []),
    [activeData, viewers],
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

  const height = activeData !== null ? activeData.height : 0
  const oldestBlock = activeData !== null ? activeData.oldestBlock : null

  const selected = conversations.find((one) => one.peer === openPeer) ?? null
  const shown = conversations.filter((one) => !hidden.includes(one.peer))
  const muted = conversations.filter((one) => hidden.includes(one.peer))

  // Stop retries as soon as the expected message appears in the conversation
  useEffect(() => {
    if (expectedMsgCountRef.current !== null && selected) {
      if (selected.messages.length >= expectedMsgCountRef.current) {
        clearRetryTimers()
      }
    }
  }, [conversations, selected, clearRetryTimers])

  return (
    <div className={`screen inbox-screen ${styles.lightThemeWrapper}`}>
      <div className={styles.heroSection}>
        <div className={styles.heroContent}>
          {/* Header */}
          <div className={styles.inboxHeader}>
            <h1 className={styles.inboxTitle}>{SCREEN_TITLE.inbox}</h1>
            <p className={styles.inboxSubtitle}>{SCREEN_SUB.inbox}</p>
          </div>

          {/* Main Glassmorphism Panel */}
          <div className={styles.inboxPanel}>
            {/* A refresh that failed over a list already shown: the list stays, the
                failure is said — silently stale was the redesign's default. */}
            {data.status === 'error' && activeData !== null && <p className={styles.errorBanner}>{inboxDownLine()}</p>}
            {viewers.length === 0 ? (
              <div className={styles.emptyCard}>
                <div className={styles.emptyIcon}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="4" width="20" height="16" rx="2" />
                    <path d="M7 15h0M2 10h20" />
                  </svg>
                </div>
                <h3 className={styles.emptyTitle}>{inboxNoWalletTitle()}</h3>
                <p className={styles.emptyBody}>{inboxNoWalletLine()}</p>
                {/* The identity control, moved here — this card exists only
                    while there is no wallet, the state it draws as a lone
                    Connect button, so there is no panel to open. Not while
                    detection is still running: the bar's "Checking wallet…"
                    under this card's "No wallet connected" is a card
                    contradicting itself (MyNames.tsx says it at length). */}
                {wallet !== null && (
                  <IdentityBar wallet={wallet} onConnect={onConnect} onDisconnect={null} expanded={false} onToggle={() => {}} placement="empty" />
                )}
              </div>
            ) : source === null ? (
              <div className={styles.emptyCard}>
                <div className={styles.emptyIcon}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </div>
                <h3 className={styles.emptyTitle}>{inboxNotConfiguredTitle()}</h3>
                <p className={styles.emptyBody}>{inboxNotConfiguredLine()}</p>
              </div>
            ) : activeData === null && (data.status === 'loading' || data.status === 'idle') ? (
              <div className={styles.loadingWrap}>
                <Spinner />
              </div>
            ) : activeData === null && data.status === 'error' ? (
              <p className={styles.errorBanner}>{inboxDownLine()}</p>
            ) : selected !== null ? (
              <ConversationView
                conversation={selected}
                names={namesFor(selected.peer)}
                wallet={wallet}
                hidden={hidden.includes(selected.peer)}
                onSent={handleMessageSent}
                onBack={() => setOpenPeer(null)}
                onHide={() => setHidden(hideSender(localStorage, selected.peer))}
                onUnhide={() => setHidden(unhideSender(localStorage, selected.peer))}
              />
            ) : (
              <>
                {conversations.length === 0 && (
                  <div className={styles.emptyCard}>
                    <div className={styles.emptyIcon}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                    </div>
                    <h3 className={styles.emptyTitle}>{inboxEmptyTitle()}</h3>
                    <p className={styles.emptyBody}>{inboxEmptyLine()}</p>
                  </div>
                )}
                <ConversationList conversations={shown} namesFor={namesFor} onOpen={setOpenPeer} />
                {muted.length > 0 && (
                  <details className={styles.hiddenBucket}>
                    <summary className={styles.hiddenSummary}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                      <span>{hiddenSendersLabel(muted.length)}</span>
                    </summary>
                    <div style={{ marginTop: '10px' }}>
                      <ConversationList conversations={muted} namesFor={namesFor} onOpen={setOpenPeer} />
                    </div>
                  </details>
                )}
                {oldestBlock !== null && (
                  <p className={styles.retentionBox}>
                    {inboxWindowLine(formatApproxDate(approxDate(oldestBlock, height, Date.now())))}
                  </p>
                )}
              </>
            )}
          </div>

          <TrustBar screen="inbox" />
        </div>
      </div>
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
          {index > 0 && <span> · </span>}
          <NameText>{name}</NameText>
        </span>
      ))}
      {identity.more > 0 && <span style={{ fontSize: '11px', opacity: 0.7, marginLeft: '4px' }}>{peerMoreNamesLine(identity.more)}</span>}
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
  const nowMs = Date.now()
  return (
    <ul className={styles.threadList}>
      {conversations.map((conversation) => {
        const last = conversation.messages[conversation.messages.length - 1]
        const names = namesFor(conversation.peer)
        return (
          <li key={conversation.peer}>
            <button
              type="button"
              className={styles.threadCard}
              onClick={() => onOpen(conversation.peer)}
            >
              <div className={styles.threadAvatar}>
                <Identicon address={conversation.peer} size={40} />
              </div>
              <div className={styles.threadMain}>
                <div className={styles.threadTopRow}>
                  <div className={styles.threadName}>
                    <PeerTitle address={conversation.peer} names={names} />
                  </div>
                  <span className={styles.threadTime}>
                    {formatThreadDate(conversation.lastTimestamp, nowMs)}
                  </span>
                </div>
                <p className={styles.threadPreview}>{last?.message}</p>
              </div>
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
  wallet,
  hidden,
  onSent,
  onBack,
  onHide,
  onUnhide,
}: {
  conversation: ChatConversation
  names: readonly PeerName[]
  wallet: Wallet | null
  hidden: boolean
  onSent?: ((peer: string, currentCount: number) => void) | undefined
  onBack: () => void
  onHide: () => void
  onUnhide: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bubblesEndRef = useRef<HTMLDivElement | null>(null)
  const hasPeerNames = peerIdentity(names).shown.length > 0

  // The whole spaced address, not the ellipsized one the row shows: half an
  // address on the clipboard is worse than none.
  const handleCopyAddress = useCallback(() => {
    if (!conversation.peer) return
    void writeClipboard(displayAddress(conversation.peer)).then((outcome) => {
      if (outcome === 'failed') return
      setCopied(true)
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = setTimeout(() => {
        setCopied(false)
      }, 2000)
    })
  }, [conversation.peer])

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    }
  }, [])

  // The newest bubble into view when the thread opens or grows. The bubbles
  // box scrolls on its own; the page is left where the reader put it.
  useEffect(() => {
    requestAnimationFrame(() => {
      const container = bubblesEndRef.current?.parentElement
      if (container) container.scrollTop = container.scrollHeight
    })
  }, [conversation.messages.length])

  const nowMs = Date.now()

  return (
    <div className={styles.conversationView}>
      {/* Cohesive, left-aligned header bar */}
      <div className={styles.threadHeader}>
        <div className={styles.threadPeerInfo}>
          <button type="button" className={styles.backBtn} onClick={onBack} aria-label={backToInboxAria()} title={backToInboxAria()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            <span className={styles.backBtnText}>{backToInboxLabel()}</span>
          </button>
          <div className={styles.threadAvatar}>
            <Identicon address={conversation.peer} size={36} />
          </div>
          <div className={styles.peerHeaderMain}>
            {/* A peer holding no live name has nothing to put on the top line,
                and printing the address there left it on screen twice — once
                ellipsized as a title and once in the row below. The hint is
                gone with it: "names above an address" describes nothing when
                there are none (2026-09-15). */}
            {hasPeerNames && (
              <div className={styles.peerHeaderTitle}>
                <PeerTitle address={conversation.peer} names={names} />
                <Hint>{peerNamesHint()}</Hint>
              </div>
            )}
            <div className={styles.peerAddressRow}>
              <span className={hasPeerNames ? styles.peerHeaderAddress : `${styles.peerHeaderAddress} ${styles.peerHeaderAddressOnly}`}>
                {ellipsizeAddress(conversation.peer)}
              </span>
              <button
                type="button"
                className={`${styles.copyAddressBtn} ${copied ? styles.isCopied : ''}`}
                onClick={handleCopyAddress}
                title={copied ? copiedLabel() : copyAddressLabel()}
                aria-label={copied ? copiedLabel() : copyAddressLabel()}
              >
                {copied ? (
                  <>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span className={styles.copiedFeedback}>{copiedLabel()}</span>
                  </>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>

        <button
          type="button"
          className={styles.muteActionBtn}
          onClick={() => {
            if (hidden) {
              onUnhide()
            } else {
              onHide()
              onBack() // Returns to inbox where sender is neatly moved to hidden bucket
            }
          }}
          title={hidden ? unhideSenderAction() : hideSenderAction()}
        >
          {hidden ? (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <span>{unhideSenderAction()}</span>
            </>
          ) : (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
              <span>{hideSenderAction()}</span>
            </>
          )}
        </button>
      </div>

      {/* Message stream */}
      <div className={styles.bubblesArea}>
        {conversation.messages.map((message) => (
          <div key={message.hash} className={styles.bubbleGroup}>
            <div className={message.direction === 'in' ? styles.bubbleIn : styles.bubbleOut}>
              <span>{message.message}</span>
              {/* Time and link share a row rather than stacking: the bubble is
                  `white-space: pre-wrap`, so an inline anchor beside the time
                  would render the JSX's own indentation. */}
              <span className={styles.bubbleMeta}>
                <span className={styles.bubbleTime}>{formatBubbleTimestamp(message.timestamp, nowMs)}</span>
                {isTxHash(message.hash) && (
                  <a
                    className={styles.bubbleTxLink}
                    href={explorerTxUrl(message.hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={viewOnExplorerLabel()}
                    aria-label={viewOnExplorerLabel()}
                  >
                    <ExternalIcon />
                  </a>
                )}
              </span>
            </div>
          </div>
        ))}
        <div ref={bubblesEndRef} />
      </div>

      {/* Clean reply composer */}
      <div className={styles.composerBox}>
        <Composer
          name=""
          recipient={conversation.peer}
          wallet={wallet}
          sender={wallet === null ? null : primaryAddress(wallet.identity)}
          heading={null}
          onSent={onSent ? () => onSent(conversation.peer, conversation.messages.length) : undefined}
        />
      </div>
    </div>
  )
}
