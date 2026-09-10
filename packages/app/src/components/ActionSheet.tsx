import { useMemo, useState } from 'react'
import { prepareAction, ActionInputError, type ActionInputs } from '../lib/actions'
import { getParams, type NameInfo } from '../lib/api'
import { clearReferral, storedReferral } from '../lib/referral'
import { defaultTransport } from '../lib/history'
import { apiBase } from '../lib/nns'
import { approxDate, ellipsizeAddress, formatApproxDate, lunaToNim } from '../lib/format'
import { discoverEvmProvider, probeHostEvmAddress, requestHostEvmAddress } from '../lib/sdk'
import { performSend, type SendResult } from '../lib/send'
import { useAsync } from '../lib/useAsync'
import type { AppAction } from '../lib/states'
import type { Wallet } from '../lib/wallet'
import { Spinner } from './ui'
import {
  ACTION_LABEL,
  bidCustodialWarning,
  buyAcknowledgeLabel,
  connectEvmFailedLine,
  connectEvmLabel,
  currentEvmLine,
  currentExpiryLine,
  currentHostLine,
  currentTargetLine,
  custodialWarning,
  minimumBidLine,
  noBidsLine,
  noEvmLine,
  noHostLine,
  standingBidLine,
  suggestedEvmLabel,
  sendConfirmedLine,
  sendConfirmingLine,
  sendDeclinedLine,
  sendNoRpcLine,
  sendRejectedLine,
  sendSettlingLine,
  sendSubmittingLine,
  cancelLabel,
  closeLabel,
  confirmingLabel,
  signsWithLabel,
  submittingLabel,
  sendUncheckedLine,
  sendUnconfirmedLine,
} from '../lib/wording'

/**
 * One sheet for all ten flows (docs/app-ux.md §4–§5): inputs → in-app
 * review (everything the wallet screen will not say) → the wallet → the
 * confirm-by-effect loop, honest at every exit.
 */
export function ActionSheet({
  action,
  name,
  info,
  signer,
  viewers,
  wallet,
  onChanged,
  onClose,
}: {
  action: AppAction
  name: string
  info: NameInfo | null
  signer: string
  /** The whole identity set: the wallet may sign with any member of it, and
   *  on the Pay path it is never the first. */
  viewers: readonly string[]
  wallet: Wallet
  onChanged: () => void
  onClose?: () => void
}) {
  const paramsState = useAsync(() => getParams(apiBase()), [])
  // The share link's ref (§10.7), read once: it rides the `G` and nothing else.
  const referral = useAsync(() => (action === 'register' ? storedReferral() : Promise.resolve(null)), [action])
  const params = paramsState.status === 'done' ? paramsState.value : null
  const [target, setTarget] = useState('')
  const [resetTarget, setResetTarget] = useState(false)
  const [evmInput, setEvmInput] = useState('')
  const [clearEvm, setClearEvm] = useState(false)
  // Best-effort pre-fill from the host wallet (window.ethereum, if Pay's
  // WebView injects one) — a suggestion the user still reviews, never an
  // authority. Empty answer, no probe result yet, no injection: paste field.
  const hostEvm = useAsync(() => (action === 'setEvm' ? probeHostEvmAddress() : Promise.resolve(null)), [action])
  const suggestedEvm = hostEvm.status === 'done' ? hostEvm.value : null
  // Whether a "use my wallet's address" button can exist at all. The provider
  // is discovered per open — it is injected asynchronously in some hosts.
  const canRequestEvm = useMemo(() => action === 'setEvm' && discoverEvmProvider() !== null, [action])
  const [evmRequestFailed, setEvmRequestFailed] = useState(false)
  const [newOwner, setNewOwner] = useState('')
  const [host, setHost] = useState('')
  const [priceNim, setPriceNim] = useState('')
  const [startingPriceNim, setStartingPriceNim] = useState('')
  const [durationDays, setDurationDays] = useState('')
  const [bidNim, setBidNim] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [progress, setProgress] = useState<'idle' | 'submitting' | 'confirming'>('idle')
  const [result, setResult] = useState<SendResult | null>(null)

  const inputs: ActionInputs = useMemo(() => {
    switch (action) {
      case 'setTarget':
        return { action, target: resetTarget ? 'reset' : target }
      case 'setEvm':
        return { action, evm: clearEvm ? 'clear' : evmInput }
      case 'transfer':
        return { action, newOwner }
      case 'delegate':
        return { action, host }
      case 'offer':
        return { action, priceNim }
      case 'auction':
        return { action, startingPriceNim, durationDays }
      case 'bid':
        return { action, bidNim }
      case 'register':
        return { action, ref: referral.status === 'done' ? referral.value : null }
      case 'renew':
      case 'cancel':
      case 'buy':
        return { action }
    }
  }, [action, target, resetTarget, clearEvm, evmInput, newOwner, host, priceNim, startingPriceNim, durationDays, bidNim, referral])

  const inputsTouched = (() => {
    switch (action) {
      case 'setTarget':
        return resetTarget || target.trim() !== ''
      case 'setEvm':
        return clearEvm || evmInput.trim() !== ''
      case 'transfer':
        return newOwner.trim() !== ''
      case 'offer':
        return priceNim.trim() !== ''
      case 'auction':
        return startingPriceNim.trim() !== '' && durationDays.trim() !== ''
      case 'bid':
        return bidNim.trim() !== ''
      default:
        return true
    }
  })()
  const needsParams = action === 'register' || action === 'renew' || action === 'offer' || action === 'auction'
  const loadingParams = needsParams && paramsState.status !== 'done' && paramsState.status !== 'error'

  const prepared = useMemo(() => {
    if (!inputsTouched) return null
    if (loadingParams) return null
    try {
      return { ok: true as const, value: prepareAction({ inputs, name, info, signer, viewers, params, apiBase: apiBase() }) }
    } catch (error) {
      if (error instanceof ActionInputError) return { ok: false as const, message: error.message }
      return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
    }
  }, [inputs, inputsTouched, loadingParams, name, info, signer, viewers, params])

  // Both `B`s: a buy and a bid hand money to the marketplace (§8.5 #10).
  const needsAcknowledge = action === 'buy' || action === 'bid'
  const terminalSuccess = result?.status === 'confirmed' || result?.status === 'settling'
  const ready = prepared?.ok === true && (!needsAcknowledge || acknowledged) && progress === 'idle' && !terminalSuccess

  const send = async () => {
    if (prepared?.ok !== true) return
    setResult(null)
    const outcome = await performSend({
      wallet,
      transport: defaultTransport(),
      request: prepared.value.request,
      confirm: { poll: prepared.value.confirm },
      onPhase: setProgress,
    })
    setProgress('idle')
    setResult(outcome)
    if (outcome.status === 'confirmed') {
      // The ref did its work; a later registration is not the referrer's.
      if (action === 'register') void clearReferral()
      onChanged()
    }
  }

  // What the record says right now, before any input: the thing this action
  // is about to change, or for renew the clock it is about to extend. The
  // expiry date rides the block clock (~1 block/s) via approxDate.
  const record = info?.record ?? null
  const currentLine = ((): string | null => {
    if (record === null) return null
    switch (action) {
      case 'setTarget':
        return currentTargetLine(record.target)
      case 'setEvm':
        return record.evm === '' ? noEvmLine() : currentEvmLine(record.evm)
      case 'delegate':
        return record.host === '' ? noHostLine() : currentHostLine(record.host)
      case 'renew':
      // The expiry decides whether the auction's end is safe (§6 `A` has no
      // rule against an end past it — the grace reset cancels it instead).
      case 'auction':
        return info === null
          ? null
          : currentExpiryLine(formatApproxDate(approxDate(record.expiry, info.height, Date.now())))
      case 'bid': {
        const auction = info?.pending.auction ?? null
        if (auction === null) return null
        const standing =
          auction.bidder === null ? noBidsLine() : standingBidLine(lunaToNim(auction.bid), ellipsizeAddress(auction.bidder))
        return `${standing} ${minimumBidLine(lunaToNim(auction.minimumBid))}`
      }
      default:
        return null
    }
  })()

  return (
    // No heading of its own: the sheet opens under the row that names the
    // action, and that row's button is its Close.
    <div className="sheet">
      {onClose && (
        <div className="sheet-header">
          <span className="sheet-title">{ACTION_LABEL[action]} {name}</span>
          <button type="button" className="sheet-close" onClick={onClose} aria-label={closeLabel()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      )}
      {currentLine !== null && <p className="sheet-current">{currentLine}</p>}

      {action === 'setTarget' && (
        <>
          <label className="sheet-check">
            <input type="checkbox" checked={resetTarget} onChange={(event) => setResetTarget(event.target.checked)} />
            Point back at my address
          </label>
          {!resetTarget && (
            <input
              className="sheet-input nns-name"
              placeholder="NQ… new target address"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            />
          )}
        </>
      )}
      {action === 'setEvm' && (
        <>
          {info?.record?.evm ? (
            <label className="sheet-check">
              <input type="checkbox" checked={clearEvm} onChange={(event) => setClearEvm(event.target.checked)} />
              Remove the linked address
            </label>
          ) : null}
          {!clearEvm && (
            <>
              {/* The field is always the field — typing any address works.
                  The button only fills it: instantly when the silent probe
                  already knows the address, else through the wallet's own
                  connect sheet (eth_requestAccounts — the flow every EVM
                  dApp gets in Pay's browser), which needs the user gesture
                  this tap is. */}
              <input
                className="sheet-input nns-name"
                placeholder={info?.record?.evm ? `${info.record.evm} (current)` : '0x… EVM address'}
                value={evmInput}
                onChange={(event) => setEvmInput(event.target.value)}
              />
              {(suggestedEvm !== null || canRequestEvm) && (
                <button
                  type="button"
                  className="sheet-suggest"
                  onClick={async () => {
                    const address = suggestedEvm ?? (await requestHostEvmAddress())
                    if (address !== null) {
                      setEvmInput(address)
                      setEvmRequestFailed(false)
                    } else {
                      setEvmRequestFailed(true)
                    }
                  }}
                >
                  {suggestedEvm !== null ? suggestedEvmLabel(suggestedEvm) : connectEvmLabel()}
                </button>
              )}
              {evmRequestFailed && <p className="field-error">{connectEvmFailedLine()}</p>}
            </>
          )}
        </>
      )}
      {action === 'transfer' && (
        <input
          className="sheet-input nns-name"
          placeholder="NQ… new owner address"
          value={newOwner}
          onChange={(event) => setNewOwner(event.target.value)}
        />
      )}
      {action === 'delegate' && (
        <input
          className="sheet-input nns-name"
          placeholder={info?.record?.host ? `${info.record.host} (empty clears it)` : 'delegate host, e.g. nns.example.com'}
          value={host}
          onChange={(event) => setHost(event.target.value)}
        />
      )}
      {action === 'offer' && (
        <input
          className="sheet-input"
          inputMode="decimal"
          placeholder="Price in NIM"
          value={priceNim}
          onChange={(event) => setPriceNim(event.target.value)}
        />
      )}
      {action === 'auction' && (
        <>
          <input
            className="sheet-input"
            inputMode="decimal"
            placeholder="Starting price in NIM"
            value={startingPriceNim}
            onChange={(event) => setStartingPriceNim(event.target.value)}
          />
          <input
            className="sheet-input"
            inputMode="decimal"
            placeholder="Duration in days (at least 1)"
            value={durationDays}
            onChange={(event) => setDurationDays(event.target.value)}
          />
        </>
      )}
      {action === 'bid' && (
        <input
          className="sheet-input"
          inputMode="decimal"
          placeholder={
            info?.pending.auction ? `Bid in NIM — at least ${lunaToNim(info.pending.auction.minimumBid)}` : 'Bid in NIM'
          }
          value={bidNim}
          onChange={(event) => setBidNim(event.target.value)}
        />
      )}

      {loadingParams && (
        <div className="sheet-loading">
          <Spinner />
        </div>
      )}

      {prepared !== null && !prepared.ok && <p className="field-error">{prepared.message}</p>}

      {prepared?.ok === true && (
        <ul className="review">
          {prepared.value.review.map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li className="review-signer">
            <span>{signsWithLabel()}</span>
            <span className="signer-address nns-name">{signer}</span>
          </li>
        </ul>
      )}

      {needsAcknowledge && (
        <>
          <p className="note note-info">{action === 'bid' ? bidCustodialWarning() : custodialWarning()}</p>
          <label className="sheet-check">
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
            {buyAcknowledgeLabel()}
          </label>
        </>
      )}

      {progress === 'submitting' && <p className="note note-info">{sendSubmittingLine()}</p>}
      {progress === 'confirming' && <p className="note note-info">{sendConfirmingLine()}</p>}

      {result !== null && (
        <p
          className={
            result.status === 'confirmed'
              ? 'verify verify-proven'
              : result.status === 'unchecked' || result.status === 'settling'
                ? 'note note-info'
                : 'field-error'
          }
        >
          {result.status === 'confirmed' && sendConfirmedLine()}
          {result.status === 'declined' && sendDeclinedLine()}
          {result.status === 'settling' && sendSettlingLine()}
          {result.status === 'rejected' && sendRejectedLine()}
          {result.status === 'unconfirmed' && sendUnconfirmedLine()}
          {result.status === 'unchecked' && sendUncheckedLine()}
          {result.status === 'blocked' && sendNoRpcLine()}
          {result.status === 'failed' && `Couldn’t send: ${result.detail}`}
        </p>
      )}

      <div className={`sheet-actions-grid ${onClose ? 'has-cancel' : ''}`}>
        <button type="button" className="sheet-send" disabled={!ready} onClick={() => void send()}>
          {progress === 'submitting' ? submittingLabel() : progress === 'confirming' ? confirmingLabel() : ACTION_LABEL[action]}
        </button>

        {onClose && (
          <button type="button" className="sheet-cancel" onClick={onClose}>
            {cancelLabel()}
          </button>
        )}
      </div>
    </div>
  )
}
