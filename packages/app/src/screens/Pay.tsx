/**
 * **Pay** — send NIM to a name. Type a name, it resolves, enter an amount, the
 * wallet signs (docs/app-ux.md §4).
 *
 * The address comes from `search()`, so `resolver().resolve()` is still the only
 * thing in this app that produces one, and every non-resolved outcome already
 * has wording written for it in the shared card.
 *
 * **This is the one send that does not pass through `core`.** A payment carries
 * no NNS message, so `codec.ts`'s `build()` — which refuses a zero value and a
 * self-transaction for all eight actions — never runs. Both refusals are
 * therefore this screen's to make, and both failures are silent on-chain: the
 * RPC accepts a self-transaction and the network drops it (rpc-reference), and a
 * zero value is rejected outright.
 */

import { useMemo, useState } from 'react'
import { ActionInputError, parseNimAmount } from '../lib/actions'
import { lunaToNim } from '../lib/format'
import { defaultTransport } from '../lib/history'
import { primaryAddress } from '../lib/identity'
import { search } from '../lib/search'
import { performSend, type SendPhase, type SendResult } from '../lib/send'
import { sameAddress } from '../lib/states'
import { useAsync } from '../lib/useAsync'
import { useDebounced } from '../lib/useDebounced'
import type { Wallet } from '../lib/wallet'
import {
  payAmountLabel,
  payButtonLabel,
  payFromLabel,
  paySelfLine,
  payToLabel,
  payZeroLine,
  sendConfirmedLine,
  sendConfirmingLine,
  sendDeclinedLine,
  sendNoRpcLine,
  sendSubmittingLine,
  sendUncheckedLine,
  sendUnconfirmedLine,
  unreachableLine,
} from '../lib/wording'
import { NameCard } from '../components/NameCard'
import { PinCheck } from '../components/PinCheck'
import { AddressRow } from '../components/result'
import { EmptyState, NameText, Spinner } from '../components/ui'

/** The same settle as Buy — one query per typed word, not one per character. */
const SETTLE_MS = 1_000

export function PayScreen({ wallet }: { wallet: Wallet | null }) {
  const [text, setText] = useState('')
  const [amount, setAmount] = useState('')
  const [chosenSender, setChosenSender] = useState<string | null>(null)
  const [pinBlocking, setPinBlocking] = useState(false)
  const [progress, setProgress] = useState<SendPhase | 'idle'>('idle')
  const [result, setResult] = useState<SendResult | null>(null)

  const trimmed = text.trim().toLowerCase()
  const [query] = useDebounced(trimmed, SETTLE_MS)
  const outcome = useAsync(query === '' ? null : () => search(query), [query])

  const addresses = wallet?.identity.addresses ?? []
  const sender = chosenSender ?? (wallet === null ? null : primaryAddress(wallet.identity))

  // Only a resolved answer can be paid: everything else is a state, not an
  // address, and the shared card already says which.
  const resolved = outcome.status === 'done' && outcome.value.kind === 'resolved' ? outcome.value.result : null

  const parsed = useMemo((): { readonly luna: bigint } | { readonly error: string } | null => {
    if (amount.trim() === '') return null
    try {
      const luna = parseNimAmount(amount, 'Amount')
      // The network rejects a zero value outright (§5.4, and why DUST_VALUE
      // exists) — and "0" is what an empty-ish amount parses to.
      return luna === 0n ? { error: payZeroLine() } : { luna }
    } catch (error) {
      return { error: error instanceof ActionInputError ? error.message : String(error) }
    }
  }, [amount])

  // Nimiq drops a self-transaction silently: the RPC accepts it and returns a
  // hash, so nothing downstream would ever report this.
  const self = resolved !== null && sender !== null && sameAddress(sender, resolved.address)

  const luna = parsed !== null && 'luna' in parsed ? parsed.luna : null
  const canPay =
    resolved !== null && sender !== null && luna !== null && !self && !pinBlocking && wallet !== null && progress === 'idle'

  const pay = async () => {
    if (resolved === null || sender === null || luna === null || wallet === null) return
    setResult(null)
    const transport = defaultTransport()
    const outcomeOfSend = await performSend({
      wallet,
      transport,
      // No NNS message: a plain transfer carries no data at all.
      request: { sender, recipient: resolved.address, value: luna, dataHex: '' },
      confirm: {
        // A payment has no registry effect to watch, so the transaction itself
        // is the effect — the same poll the chat composer uses.
        poll: async (hash) => {
          if (hash === null || transport === null) return false
          const tx = await transport('getTransactionByHash', [hash])
          return typeof tx === 'object' && tx !== null && (tx as Record<string, unknown>)['executionResult'] === true
        },
      },
      onPhase: setProgress,
    })
    setProgress('idle')
    setResult(outcomeOfSend)
    if (outcomeOfSend.status === 'confirmed') setAmount('')
  }

  return (
    <div className="screen">
      <input
        className="search-input nns-name"
        type="text"
        inputMode="text"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder="name, or label.name"
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label="Name to pay"
      />

      {outcome.status === 'idle' && (
        <EmptyState title="Pay a name" body="Type a name to see where it pays, then send NIM to it." />
      )}
      {outcome.status === 'loading' && <Spinner />}
      {outcome.status === 'error' && <p className="field-error">{unreachableLine()}</p>}

      {/* Not resolved: the shared card says why — reserved, available, in grace,
          a delegate that did not answer, an alarm. None of them is payable. */}
      {outcome.status === 'done' && resolved === null && (
        <NameCard outcome={outcome.value} wallet={wallet} nowMs={Date.now()} actions={[]} onChanged={() => {}} onManage={null} />
      )}

      {resolved !== null && (
        <div className="pay-form">
          <p className="pay-to">
            {payToLabel()} <NameText>{resolved.query}</NameText>
          </p>
          {/* §8.5, app-ux §6: the pin check runs on every screen that pays a
              resolved address, and here a mismatch stops the button. */}
          <PinCheck query={resolved.query} address={resolved.address} onBlocking={setPinBlocking} />
          <AddressRow address={resolved.address} full />

          {addresses.length > 1 && (
            <label className="pay-from">
              {payFromLabel()}
              <select
                className="pay-select nns-name"
                value={sender ?? ''}
                onChange={(event) => setChosenSender(event.target.value)}
              >
                {addresses.map((address) => (
                  <option key={address} value={address}>
                    {address}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="pay-amount">
            {payAmountLabel()}
            <input
              className="pay-input"
              type="text"
              inputMode="decimal"
              placeholder="0.00001"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              aria-label="Amount in NIM"
            />
          </label>

          {parsed !== null && 'error' in parsed && <p className="field-error">{parsed.error}</p>}
          {self && <p className="field-error">{paySelfLine()}</p>}

          <button className="pay-go" type="button" disabled={!canPay} onClick={() => void pay()}>
            {luna === null ? payButtonLabel(null) : payButtonLabel(lunaToNim(luna))}
          </button>

          {progress === 'submitting' && <p className="note note-info">{sendSubmittingLine()}</p>}
          {progress === 'confirming' && <p className="note note-info">{sendConfirmingLine()}</p>}
          {result !== null && (
            <p
              className={
                result.status === 'confirmed'
                  ? 'verify verify-proven'
                  : result.status === 'unchecked'
                    ? 'note note-info'
                    : 'field-error'
              }
            >
              {result.status === 'confirmed' && sendConfirmedLine()}
              {result.status === 'declined' && sendDeclinedLine()}
              {result.status === 'unconfirmed' && sendUnconfirmedLine()}
              {result.status === 'unchecked' && sendUncheckedLine()}
              {result.status === 'blocked' && sendNoRpcLine()}
              {result.status === 'failed' && `Couldn’t send: ${result.detail}`}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
