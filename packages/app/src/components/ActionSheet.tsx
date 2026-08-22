import { useMemo, useState } from 'react'
import { prepareAction, ActionInputError, type ActionInputs } from '../lib/actions'
import { getParams, type NameInfo } from '../lib/api'
import { defaultTransport } from '../lib/history'
import { apiBase } from '../lib/nns'
import { performSend, type SendResult } from '../lib/send'
import { useAsync } from '../lib/useAsync'
import type { AppAction } from '../lib/states'
import type { Wallet } from '../lib/wallet'
import {
  ACTION_LABEL,
  buyAcknowledgeLabel,
  custodialWarning,
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

/**
 * One sheet for all eight flows (docs/app-ux.md §4–§5): inputs → in-app
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
  onClose,
  onChanged,
}: {
  action: AppAction
  name: string
  info: NameInfo | null
  signer: string
  /** The whole identity set: the wallet may sign with any member of it, and
   *  on the Pay path it is never the first. */
  viewers: readonly string[]
  wallet: Wallet
  onClose: () => void
  onChanged: () => void
}) {
  const paramsState = useAsync(() => getParams(apiBase()), [])
  const params = paramsState.status === 'done' ? paramsState.value : null
  const [target, setTarget] = useState('')
  const [resetTarget, setResetTarget] = useState(false)
  const [newOwner, setNewOwner] = useState('')
  const [host, setHost] = useState('')
  const [priceNim, setPriceNim] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [progress, setProgress] = useState<'idle' | 'submitting' | 'confirming'>('idle')
  const [result, setResult] = useState<SendResult | null>(null)

  const inputs: ActionInputs = useMemo(() => {
    switch (action) {
      case 'setTarget':
        return { action, target: resetTarget ? 'reset' : target }
      case 'transfer':
        return { action, newOwner }
      case 'delegate':
        return { action, host }
      case 'offer':
        return { action, priceNim }
      case 'register':
      case 'renew':
      case 'cancel':
      case 'buy':
        return { action }
    }
  }, [action, target, resetTarget, newOwner, host, priceNim])

  const inputsTouched = (() => {
    switch (action) {
      case 'setTarget':
        return resetTarget || target.trim() !== ''
      case 'transfer':
        return newOwner.trim() !== ''
      case 'offer':
        return priceNim.trim() !== ''
      default:
        return true
    }
  })()
  const prepared = useMemo(() => {
    if (!inputsTouched) return null
    try {
      return { ok: true as const, value: prepareAction({ inputs, name, info, signer, viewers, params, apiBase: apiBase() }) }
    } catch (error) {
      if (error instanceof ActionInputError) return { ok: false as const, message: error.message }
      return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
    }
  }, [inputs, inputsTouched, name, info, signer, viewers, params])

  const needsAcknowledge = action === 'buy'
  const ready = prepared?.ok === true && (!needsAcknowledge || acknowledged) && progress === 'idle' && result === null

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
    if (outcome.status === 'confirmed') onChanged()
  }

  return (
    <div className="sheet">
      <div className="sheet-head">
        <h3 className="sheet-title">{ACTION_LABEL[action]}</h3>
        <button type="button" className="back" onClick={onClose}>
          Close
        </button>
      </div>

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

      {prepared !== null && !prepared.ok && <p className="field-error">{prepared.message}</p>}

      {prepared?.ok === true && (
        <ul className="review">
          {prepared.value.review.map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>Signs with {signer}.</li>
        </ul>
      )}

      {action === 'buy' && (
        <>
          <p className="note note-info">{custodialWarning()}</p>
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

      <button type="button" className="sheet-send" disabled={!ready} onClick={() => void send()}>
        {ACTION_LABEL[action]}
      </button>
    </div>
  )
}
