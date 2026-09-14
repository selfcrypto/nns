import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ellipsizeAddress } from '../lib/format'
import { connectInstead } from '../lib/states'
import type { Wallet } from '../lib/wallet'
import { closeLabel, connectWalletLabel, GATE_REASON_TEXT, messageOwnerLabel, messageSubdomainLabel, toLabel } from '../lib/wording'
import { Composer } from './Composer'

/**
 * The bottom sheet a name card opens to message its owner (or, for a
 * subdomain, the address it resolved to). A shell only: the byte budget, the
 * encode, the send and the confirm loop are `Composer`'s, the one NC
 * composer the Inbox uses too — a second copy of that machine drifted for
 * exactly one PR (2026-09-09) before it was folded back.
 */
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
  /** The recipient address (the owner of the name, or the subdomain's address). */
  recipient: string | null
  wallet: Wallet | null
  /** The signing address — the primary address of the viewer's identity. */
  sender: string | null
  subdomainNote?: string | null | undefined
  onConnect?: (() => void) | null | undefined
}) {
  // Closing mid-send would unmount the composer with a transaction in flight
  // and the result never shown; the composer says when it is busy.
  const [busy, setBusy] = useState(false)
  const close = () => {
    if (!busy) onClose()
  }

  useEffect(() => {
    if (!isOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose, busy])

  if (!isOpen || typeof document === 'undefined') return null

  return createPortal(
    <>
      <div className="modal-scrim" onClick={close} aria-hidden="true" />
      <div className="modal-container" role="dialog" aria-modal="true" aria-labelledby="message-modal-title">
        <div className="modal-handle" aria-hidden="true" />
        <div className="modal-header">
          <div className="modal-header-left">
            <div className="modal-icon-badge" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
            </div>
            <div className="modal-header-text">
              <h3 id="message-modal-title" className="modal-title">
                {subdomainNote ? messageSubdomainLabel() : messageOwnerLabel()}
              </h3>
              <p className="modal-subtitle">
                {toLabel()} <span className="modal-recipient-name">{name}</span>
                {recipient && <span className="modal-recipient-addr"> · {ellipsizeAddress(recipient)}</span>}
              </p>
            </div>
          </div>
          <button type="button" className="modal-close-btn" onClick={close} aria-label={closeLabel()} disabled={busy}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        {subdomainNote && (
          <div className="modal-notice-banner">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
            <span>{subdomainNote}</span>
          </div>
        )}

        <Composer name={name} recipient={recipient} wallet={wallet} sender={sender} heading={null} onBusy={setBusy} />

        {/* No address to sign with — `wallet === null` is detection in flight,
            and on that test this block never reached the user who needed it
            (states.ts, `connectInstead`). */}
        {connectInstead(wallet, true) && (
          <div className="modal-wallet-warning">
            <div className="modal-wallet-warning-text">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
                <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
                <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
              </svg>
              <span>{GATE_REASON_TEXT['no-viewer']}</span>
            </div>
            {onConnect && (
              <button type="button" className="modal-wallet-connect-btn" onClick={onConnect}>
                {connectWalletLabel()}
              </button>
            )}
          </div>
        )}
      </div>
    </>,
    document.body,
  )
}
