import { CONSTANTS } from '@nimiqnames/core'
import { useMemo, useState } from 'react'
import { prepareAction, ActionInputError, type ActionInputs } from '../lib/actions'
import { getNameInfo, getParams, type NameInfo } from '../lib/api'
import { clearReferral, isSelfReferral, storedReferral } from '../lib/referral'
import { defaultTransport, fetchNimBalance } from '../lib/history'
import { apiBase } from '../lib/nns'
import { approxDate, blocksApprox, ellipsizeAddress, formatApproxWhen, lunaToNim, splitAroundName } from '../lib/format'
import { discoverEvmProvider, probeHostEvmAddress, requestHostEvmAddress } from '../lib/sdk'
import { performSend, type SendResult } from '../lib/send'
import { useAsync } from '../lib/useAsync'
import { cancellableNow, registrationFee, shortfallFor, type AppAction } from '../lib/states'
import type { Wallet } from '../lib/wallet'
import { AddressInput } from './AddressInput'
import { Hint } from './Hint'
import { ButtonSpinner, SendProgress } from './SendProgress'
import { NameText, Spinner } from './ui'
import {
  clearHostCheckLabel,
  clearHostLabel,
  hostPlaceholder,
  sheetActionLabel,
  sheetDismissLabel,
  bidCustodialHint,
  bidCustodialWarning,
  buyAcknowledgeLabel,
  connectEvmFailedLine,
  connectEvmLabel,
  currentEvmLine,
  currentExpiryLine,
  currentHostLine,
  currentTargetLine,
  custodialHint,
  custodialWarning,
  minimumBidLine,
  noBidsLine,
  noEvmLine,
  referredBySelfLine,
  noHostLine,
  standingBidLine,
  suggestedEvmLabel,
  sendConfirmedLine,
  sendDeclinedLine,
  sendNoRpcLine,
  sendRejectedLine,
  sendSettlingLine,
  closeLabel,
  confirmingLabel,
  signsWithLabel,
  submittingLabel,
  sendUncheckedLine,
  sendUnconfirmedLine,
  bidAmountPlaceholder,
  insufficientBalanceLine,
  choicePriceLine,
  lifetimeChoiceLabel,
  priceHint,
  termChoiceGroupLabel,
  termChoiceLabel,
  pricePlaceholder,
  startingPricePlaceholder,
  durationPlaceholder
} from '../lib/wording'

/**
 * A sheet sentence with the name it is about set in the name face and in
 * bold. Two reasons, and either alone would be enough: §4.3 wants a name
 * rendered confusable-safe *wherever it is shown*, and a sentence in the body
 * font quietly exempted itself from that; and a review whose subject is a
 * name should point at it (Kike, 2026-09-15, on a clear whose review named
 * `ricomaverick` in running text: *"it needs something"*).
 */
function ReviewLine({ line, name }: { line: string; name: string }) {
  return (
    <>
      {splitAroundName(line, name).map((part, index) =>
        part.isName ? (
          <strong className="line-name" key={index}>
            <NameText>{part.text}</NameText>
          </strong>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

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
  /**
   * The share link's ref (§10.7), read once: it rides the `G` and nothing else.
   *
   * A ref naming a name **this viewer already controls** is dropped here and
   * reported instead. Settlement prices that case at `selfBp` — zero in the
   * published table — so sending it would put a promise on the review sheet
   * that the treasury will not keep. The record is fetched to decide; a
   * fetch that fails leaves the ref alone, because refusing a real referral
   * on a network error is the worse of the two mistakes.
   */
  const referral = useAsync(async (): Promise<{ readonly ref: string; readonly self: boolean } | null> => {
    if (action !== 'register') return null
    const ref = await storedReferral()
    if (ref === null) return null
    const referrer = await getNameInfo(apiBase(), ref).catch(() => null)
    return { ref, self: isSelfReferral(referrer?.record ?? null, viewers) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the identity set is stable for the life of a sheet
  }, [action])
  const referredBy = referral.status === 'done' && referral.value !== null && !referral.value.self ? referral.value.ref : null
  const selfReferred = referral.status === 'done' && referral.value?.self === true ? referral.value.ref : null
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
  const [clearHost, setClearHost] = useState(false)
  const [priceNim, setPriceNim] = useState('')
  const [startingPriceNim, setStartingPriceNim] = useState('')
  const [durationDays, setDurationDays] = useState('')
  const [bidNim, setBidNim] = useState('')
  // The term choice (§10.4): a term by default, a lifetime on a tap.
  const [lifetime, setLifetime] = useState(false)
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
        return { action, host: clearHost ? 'clear' : host }
      case 'offer':
        return { action, priceNim }
      case 'auction':
        return { action, startingPriceNim, durationDays }
      case 'bid':
        return { action, bidNim }
      case 'register':
        return { action, ref: referredBy, lifetime }
      case 'renew':
        return { action, lifetime }
      case 'cancel':
      case 'buy':
        return { action }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- every input is listed
  }, [action, target, resetTarget, clearEvm, evmInput, newOwner, host, clearHost, priceNim, startingPriceNim, durationDays, bidNim, referredBy, lifetime])

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
      // A clear is the checkbox, never an empty field: the field being empty
      // is what a sheet looks like before it is used, and previewing a clear
      // there read as a contradiction of the line above it (Kike,
      // 2026-09-15). `S` and `E` already worked this way.
      case 'delegate':
        return clearHost || host.trim() !== ''
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

  // Can this wallet pay at all? `shortfallFor` owns the rule; the sheet only
  // fetches. A send re-reads, so a top-up in another tab clears the block.
  const payers = wallet.balanceAddresses.length > 0 ? wallet.balanceAddresses : [signer]
  const payerKey = `${payers.join(',')}:${result?.status ?? ''}`
  const balances = useAsync(async (): Promise<readonly (bigint | null)[]> => {
    const transport = defaultTransport()
    if (transport === null) return []
    return await Promise.all(payers.map((address) => fetchNimBalance(transport, address)))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- payerKey is the cache key
  }, [payerKey])
  const shortfall = shortfallFor(
    prepared?.ok === true ? prepared.value.request.value : null,
    balances.status === 'done' ? balances.value : [],
  )

  // Header and submit button carry the same label — for a `K`, the one the
  // cancellable set gives it, so the sheet cannot promise more than it clears.
  const actionLabel = sheetActionLabel(action, cancellableNow(info, info?.height ?? 0))
  // The title names the sheet you opened; the button names what pressing it
  // does. An empty host field on a name that has one is a `D` that clears,
  // and a button reading "Set subdomain resolver" there is simply wrong.
  const sendLabel = action === 'delegate' && clearHost ? clearHostLabel() : actionLabel

  // Both `B`s: a buy and a bid hand money to the marketplace (§8.5 #10).
  const needsAcknowledge = action === 'buy' || action === 'bid'
  const terminalSuccess = result?.status === 'confirmed' || result?.status === 'settling'
  const ready =
    prepared?.ok === true &&
    (!needsAcknowledge || acknowledged) &&
    progress === 'idle' &&
    !terminalSuccess &&
    shortfall === null

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
          : currentExpiryLine(formatApproxWhen(approxDate(record.expiry, info.height, Date.now()), Date.now()))
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
          <span className="sheet-title">{actionLabel} · {name}</span>
          <button type="button" className="sheet-close" onClick={onClose} aria-label={closeLabel()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      )}
      {currentLine !== null && (
        <p className="sheet-current">
          <ReviewLine line={currentLine} name={name} />
        </p>
      )}

      {(action === 'register' || action === 'renew') && params !== null && (
        // Two segments, each a label over its price — the price read straight
        // off `/params.fees`, never multiplied here. "Lifetime" is a label;
        // the review line under it says the date.
        <div className="term-choice">
          <div className="term-options" role="group" aria-label={termChoiceGroupLabel()}>
            {[false, true].map((choice) => (
              <button
                key={String(choice)}
                type="button"
                className={`term-option ${lifetime === choice ? 'term-option-active' : ''}`}
                aria-pressed={lifetime === choice}
                onClick={() => setLifetime(choice)}
              >
                <span className="term-option-name">{choice ? lifetimeChoiceLabel() : termChoiceLabel(CONSTANTS.TERM_LENGTH)}</span>
                <span className="term-option-price">{choicePriceLine(lunaToNim(registrationFee(name, params, choice)))}</span>
              </button>
            ))}
          </div>
          <Hint>{priceHint(params.fees)}</Hint>
        </div>
      )}

      {action === 'setTarget' && (
        <>
          <label className="sheet-check">
            <input type="checkbox" checked={resetTarget} onChange={(event) => setResetTarget(event.target.checked)} />
            Point back at my address
          </label>
          {!resetTarget && <AddressInput value={target} onChange={setTarget} />}
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
                // Never the current address: a placeholder that repeats it
                // reads as a filled field (Kike, 2026-09-15, on `D`).
                placeholder={info?.record?.evm ? '0x… new EVM address' : '0x… EVM address'}
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
      {/* An address **or a name**: NNS refusing a name in its own fields was
          the first thing a reader noticed (Kike, 2026-09-15). */}
      {action === 'transfer' && <AddressInput value={newOwner} onChange={setNewOwner} />}
      {action === 'delegate' && (
        <>
          {info?.record?.host ? (
            <label className="sheet-check">
              <input type="checkbox" checked={clearHost} onChange={(event) => setClearHost(event.target.checked)} />
              {clearHostCheckLabel()}
            </label>
          ) : null}
          {!clearHost && (
            <input
              className="sheet-input nns-name"
              placeholder={hostPlaceholder(Boolean(info?.record?.host))}
              value={host}
              onChange={(event) => setHost(event.target.value)}
            />
          )}
        </>
      )}
      {action === 'offer' && (
        <input
          className="sheet-input"
          inputMode="decimal"
          placeholder={pricePlaceholder()}
          value={priceNim}
          onChange={(event) => setPriceNim(event.target.value)}
        />
      )}
      {action === 'auction' && (
        <>
          <input
            className="sheet-input"
            inputMode="decimal"
            placeholder={startingPricePlaceholder()}
            value={startingPriceNim}
            onChange={(event) => setStartingPriceNim(event.target.value)}
          />
          <input
            className="sheet-input"
            inputMode="decimal"
            placeholder={durationPlaceholder(blocksApprox(CONSTANTS.AUCTION_MIN_DURATION))}
            value={durationDays}
            onChange={(event) => setDurationDays(event.target.value)}
          />
        </>
      )}
      {action === 'bid' && (
        <input
          className="sheet-input"
          inputMode="decimal"
          placeholder={bidAmountPlaceholder(
            info?.pending.auction ? lunaToNim(info.pending.auction.minimumBid) : null,
          )}
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

      {/* A ref that was dropped is still worth a line: the user followed a
          link, and silence would read as the link never having been read. */}
      {selfReferred !== null && <p className="note">{referredBySelfLine(selfReferred)}</p>}

      {prepared?.ok === true && (
        <ul className="review">
          {prepared.value.review.map((line, index) => (
            <li key={line}>
              <ReviewLine line={line} name={name} />
              {/* The why, one gesture away, on the line it belongs to: the
                  review says the fact in a sentence and stops. */}
              {prepared.value.reviewHint !== undefined && index === prepared.value.review.length - 1 && (
                <Hint glyph="i">{prepared.value.reviewHint}</Hint>
              )}
            </li>
          ))}
          <li className="review-signer">
            <span>{signsWithLabel()}</span>
            <span className="signer-address nns-name">{signer}</span>
          </li>
        </ul>
      )}

      {shortfall !== null && (
        <p className="field-error">{insufficientBalanceLine(lunaToNim(shortfall.owed), lunaToNim(shortfall.held))}</p>
      )}

      {needsAcknowledge && (
        <>
          {/* §8.5 #10's two halves are both here: the fact, and the checkbox
              below that gates the send button. The bubble carries when a
              refund arises — the why, which the hint decision lets go one
              gesture away. */}
          <p className="note note-info">
            {action === 'bid' ? bidCustodialWarning() : custodialWarning()}
            <Hint glyph="i">{action === 'bid' ? bidCustodialHint() : custodialHint()}</Hint>
          </p>
          <label className="sheet-check">
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
            {buyAcknowledgeLabel()}
          </label>
        </>
      )}

      <SendProgress progress={progress} />

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
          {progress === 'idle' ? (
            sendLabel
          ) : (
            <span className="btn-loading-content">
              <ButtonSpinner />
              {progress === 'submitting' ? submittingLabel() : confirmingLabel()}
            </span>
          )}
        </button>

        {onClose && (
          <button type="button" className="sheet-cancel" onClick={onClose}>
            {sheetDismissLabel(action)}
          </button>
        )}
      </div>
    </div>
  )
}
