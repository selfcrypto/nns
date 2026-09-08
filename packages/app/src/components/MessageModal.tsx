import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CHAT_DUST_LUNA, chatByteBudget, encodeChatPayload, messageBytes } from '@nns/chat'
import { defaultTransport } from '../lib/history'
import { performSend, type SendResult } from '../lib/send'
import { ellipsizeAddress } from '../lib/format'
import { sameAddress } from '../lib/states'
import type { Wallet } from '../lib/wallet'
import {
  CHAT_ENCODE_TEXT,
  GATE_REASON_TEXT,
  chatBudgetLine,
  chatOwnNameLine,
  chatPublicNotice,
  sendConfirmedLine,
  sendConfirmingLine,
  sendDeclinedLine,
  sendNoRpcLine,
  sendSubmittingLine,
  sendRejectedLine,
  sendSettlingLine,
  sendUncheckedLine,
  sendUnconfirmedLine,
} from '../lib/wording'

export function MessageModal({
  isOpen,
  onClose,
  name,
  recipient,
  wallet,
  sender,
  subdomainNote,
  onConnect,
}: {
  isOpen: boolean
  onClose: () => void
  name: string
  /** The recipient address (the owner of the name, or delegate host). */
  recipient: string | null
  wallet: Wallet | null
  /** The signing address — the primary address of the viewer's identity. */
  sender: string | null
  subdomainNote?: string | null | undefined
  onConnect?: (() => void) | null | undefined
}) {
  const [text, setText] = useState('')
  const [progress, setProgress] = useState<'idle' | 'submitting' | 'confirming'>('idle')
  const [result, setResult] = useState<SendResult | null>(null)

  // Escape key closes modal
  useEffect(() => {
    if (!isOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && progress === 'idle') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose, progress])

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setText('')
      setProgress('idle')
      setResult(null)
    }
  }, [isOpen])

  if (!isOpen || typeof document === 'undefined') return null

  const ownName = recipient !== null && sender !== null && sameAddress(recipient, sender)
  const budget = chatByteBudget(name)
  const used = messageBytes(text)
  const encoded = text.trim() === '' ? null : encodeChatPayload(name, text)
  const failure = encoded !== null && !encoded.ok ? encoded.reason : null

  const canSend =
    !ownName &&
    encoded?.ok === true &&
    recipient !== null &&
    sender !== null &&
    wallet !== null &&
    progress === 'idle'

  const handleSend = async () => {
    if (encoded?.ok !== true || recipient === null || sender === null || wallet === null) return
    const transport = defaultTransport()
    setResult(null)
    const outcome = await performSend({
      wallet,
      transport,
      request: { sender, recipient, value: CHAT_DUST_LUNA, dataHex: encoded.dataHex },
      confirm: {
        poll: async (hash) => {
          if (hash === null || transport === null) return false
          const tx = await transport('getTransactionByHash', [hash])
          return typeof tx === 'object' && tx !== null && (tx as Record<string, unknown>)['executionResult'] === true
        },
      },
      onPhase: setProgress,
    })
    setProgress('idle')
    setResult(outcome)
    if (outcome.status === 'confirmed') {
      setText('')
    }
  }

  return createPortal(
    <>
      <div className="modal-scrim" onClick={() => progress === 'idle' && onClose()} aria-hidden="true" />
      <div className="modal-container" role="dialog" aria-modal="true" aria-labelledby="message-modal-title">
        <div className="modal-header">
          <div className="modal-header-left">
            <div className="modal-icon-badge" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
            </div>
            <div className="modal-header-text">
              <h3 id="message-modal-title" className="modal-title">Message the owner</h3>
              <p className="modal-subtitle">
                To: <span className="modal-recipient-name">{name}</span>
                {recipient && <span className="modal-recipient-addr"> · {ellipsizeAddress(recipient)}</span>}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close"
            disabled={progress !== 'idle'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        {subdomainNote ? (
          <div className="modal-notice-banner">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
            <span>{subdomainNote}</span>
          </div>
        ) : (
          <div className="modal-notice-banner">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
            <span>{chatPublicNotice()}</span>
          </div>
        )}

        {ownName ? (
          <p className="note note-info">{chatOwnNameLine()}</p>
        ) : (
          <>
            <div className="modal-input-wrap">
              <textarea
                className="modal-textarea"
                rows={3}
                maxLength={budget}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Write your message here…"
                aria-label={`Message the owner of ${name}`}
                disabled={progress !== 'idle' || result?.status === 'confirmed'}
              />
              <div className="modal-textarea-footer">
                <span className={used > budget ? 'modal-char-count is-over' : 'modal-char-count'}>
                  {chatBudgetLine(used, budget)}
                </span>
              </div>
            </div>

            {failure !== null && failure !== 'EMPTY_MESSAGE' && (
              <p className="field-error">{CHAT_ENCODE_TEXT[failure]}</p>
            )}

            {wallet === null && (
              <div className="modal-wallet-warning">
                <div className="modal-wallet-warning-text">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
                    <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
                    <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
                  </svg>
                  <span>Connect wallet first to send a message.</span>
                </div>
                {onConnect && (
                  <button type="button" className="modal-wallet-connect-btn" onClick={onConnect}>
                    Connect Wallet
                  </button>
                )}
              </div>
            )}

            {progress === 'submitting' && (
              <div className="modal-status-box is-loading">
                <span className="btn-spinner" aria-hidden="true" />
                <span>{sendSubmittingLine()}</span>
              </div>
            )}
            {progress === 'confirming' && (
              <div className="modal-status-box is-loading">
                <span className="btn-spinner" aria-hidden="true" />
                <span>{sendConfirmingLine()}</span>
              </div>
            )}

            {result !== null && (
              <div className={`modal-status-box ${result.status === 'confirmed' ? 'is-success' : 'is-error'}`}>
                {result.status === 'confirmed' && (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                    <span>{sendConfirmedLine()}</span>
                  </>
                )}
                {result.status === 'declined' && <span>{sendDeclinedLine()}</span>}
                {result.status === 'settling' && <span>{sendSettlingLine()}</span>}
                {result.status === 'rejected' && <span>{sendRejectedLine()}</span>}
                {result.status === 'unconfirmed' && <span>{sendUnconfirmedLine()}</span>}
                {result.status === 'unchecked' && <span>{sendUncheckedLine()}</span>}
                {result.status === 'blocked' && <span>{sendNoRpcLine()}</span>}
                {result.status === 'failed' && <span>Couldn’t send: {result.detail}</span>}
              </div>
            )}

            <div className="modal-footer">
              <button
                type="button"
                className="modal-btn-cancel"
                onClick={onClose}
                disabled={progress !== 'idle'}
              >
                {result?.status === 'confirmed' ? 'Done' : 'Cancel'}
              </button>
              {result?.status !== 'confirmed' && (
                wallet === null ? (
                  onConnect && (
                    <button
                      type="button"
                      className="modal-btn-send"
                      onClick={onConnect}
                    >
                      Connect Wallet
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    className="modal-btn-send"
                    disabled={!canSend}
                    title={wallet === null ? GATE_REASON_TEXT['no-viewer'] : undefined}
                    onClick={() => void handleSend()}
                  >
                    {progress === 'submitting' ? (
                      <span className="btn-loading-content">
                        <span className="btn-spinner" aria-hidden="true" />
                        Submitting…
                      </span>
                    ) : progress === 'confirming' ? (
                      <span className="btn-loading-content">
                        <span className="btn-spinner" aria-hidden="true" />
                        Confirming…
                      </span>
                    ) : (
                      'Send message'
                    )}
                  </button>
                )
              )}
            </div>
          </>
        )}
      </div>
    </>,
    document.body
  )
}
