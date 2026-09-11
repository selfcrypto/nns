/**
 * **Request payment** — the owner's half of the payment link.
 *
 * A seller fills in what they want asked for and copies
 * `<origin>/#/pay/<name>?amount=…&message=…`; the payer opens it and presses
 * Pay (`lib/payRequest.ts`, `screens/Pay.tsx`). Every field is optional, so an
 * empty form still yields the plain `#/pay/<name>` link that worked before this
 * screen existed.
 *
 * Not `ActionSheet`: that one is keyed on `AppAction` and builds transactions
 * through `core`'s encoders. Nothing here is sent — it is a string being
 * assembled — so this is `MessageModal`'s shell with no busy state.
 *
 * The asset choice is always on the sheet, and the USDT tab is **greyed** for a
 * name with no `E` record (§6) rather than hidden: a USDT link pays that
 * address and there is nothing to pay without one, but a hidden option says
 * nothing about why, and linking an address is one owner action away. Picking
 * USDT closes the message field and says why: an ERC-20 `transfer` has two
 * arguments and no room for a note, so the builder must never emit a link whose
 * own screen would have to contradict it.
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CONSTANTS } from '@nns/core'
import { payLinkFor, payMessageBytes, payMessageFault, type PayAsset } from '../lib/payRequest'
import {
  closeLabel,
  copyLinkLabel,
  payAmountLabel,
  payMessageBudgetLine,
  payMessageLabel,
  payMessagePlaceholder,
  payModeNimLabel,
  payModeUsdtAria,
  payModeUsdtLabel,
  payUsdtNoMessageLine,
  requestAmountLabel,
  requestAssetLabel,
  requestLinkLabel,
  requestNoEvmLine,
  requestSheetIntro,
  requestSheetTitle,
  shareCopiedLine,
  shareCopyFailedLine,
  usdtAmountLabel,
  PAY_MESSAGE_FAULT_TEXT,
} from '../lib/wording'

export function PaymentRequestSheet({
  name,
  hasEvm,
  isOpen,
  onClose,
}: {
  name: string
  /** The name carries an `E` record. Without one the USDT tab is greyed, not gone. */
  hasEvm: boolean
  isOpen: boolean
  onClose: () => void
}) {
  const [amount, setAmount] = useState('')
  const [message, setMessage] = useState('')
  const [asset, setAsset] = useState<PayAsset>('nim')
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)

  useEffect(() => {
    if (!isOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  useEffect(() => {
    if (copied === null) return
    const timer = setTimeout(() => setCopied(null), 2_500)
    return () => clearTimeout(timer)
  }, [copied])

  if (!isOpen || typeof document === 'undefined') return null

  // A USDT link carries no reference, so the message is left out of the link
  // rather than written into one that cannot deliver it.
  const carried = asset === 'usdt' ? '' : message
  const fault = payMessageFault(carried)
  const link = payLinkFor(name, { amount: amount.trim() || null, message: carried || null, asset })

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
      await navigator.clipboard.writeText(link)
      setCopied('ok')
    } catch {
      setCopied('failed')
    }
  }

  return createPortal(
    <>
      <div className="modal-scrim" onClick={onClose} aria-hidden="true" />
      <div className="modal-container" role="dialog" aria-modal="true" aria-labelledby="request-modal-title">
        <div className="modal-handle" aria-hidden="true" />
        <div className="modal-header">
          <div className="modal-header-left">
            <div className="modal-icon-badge" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </div>
            <div className="modal-header-text">
              <h3 id="request-modal-title" className="modal-title">{requestSheetTitle()}</h3>
              <p className="modal-subtitle">{requestSheetIntro(name)}</p>
            </div>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label={closeLabel()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-input-wrap">
          <span className="request-field-label">{requestAssetLabel()}</span>
          <div className="pay-mode" role="tablist" aria-label={requestAssetLabel()}>
            {(['nim', 'usdt'] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={asset === entry}
                aria-label={entry === 'nim' ? payModeNimLabel() : payModeUsdtAria()}
                className={`pay-mode-tab ${asset === entry ? 'pay-mode-active' : ''}`}
                disabled={entry === 'usdt' && !hasEvm}
                onClick={() => setAsset(entry)}
              >
                {entry === 'nim' ? payModeNimLabel() : payModeUsdtLabel()}
              </button>
            ))}
          </div>
          {!hasEvm && <span className="request-note">{requestNoEvmLine()}</span>}
        </div>

        <label className="modal-input-wrap">
          <span className="request-field-label">{asset === 'usdt' ? usdtAmountLabel() : payAmountLabel()}</span>
          <input
            className="modal-input"
            type="text"
            inputMode="decimal"
            placeholder={requestAmountLabel(asset)}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>

        <label className="modal-input-wrap">
          <span className="request-field-label">{payMessageLabel()}</span>
          <input
            className="modal-input"
            type="text"
            placeholder={payMessagePlaceholder()}
            value={message}
            disabled={asset === 'usdt'}
            onChange={(event) => setMessage(event.target.value)}
          />
          <div className="modal-textarea-footer">
            {message !== '' && asset !== 'usdt' && (
              <span className={`modal-char-count ${fault === 'OVER_BUDGET' ? 'is-over' : ''}`}>
                {payMessageBudgetLine(payMessageBytes(message), CONSTANTS.MAX_DATA_BYTES)}
              </span>
            )}
          </div>
          {asset === 'usdt' && <span className="request-note">{payUsdtNoMessageLine()}</span>}
          {fault !== null && <span className="field-error">{PAY_MESSAGE_FAULT_TEXT[fault]}</span>}
        </label>

        <div className="modal-input-wrap">
          <span className="request-field-label">{requestLinkLabel()}</span>
          <p className="request-link">{link}</p>
        </div>

        <div className="modal-footer">
          <button type="button" className="modal-btn-send" onClick={() => void copy()} disabled={fault !== null}>
            {copied === 'ok' ? shareCopiedLine() : copyLinkLabel()}
          </button>
        </div>
        {copied === 'failed' && <p className="request-note">{shareCopyFailedLine(link)}</p>}
      </div>
    </>,
    document.body,
  )
}
