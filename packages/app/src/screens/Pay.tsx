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
import { EvmAmountError, fetchUsdtBalance, formatUsdt, parseUsdtAmount, sendUsdtOnPolygon, type EvmSendOutcome } from '../lib/evm'
import { lunaToNim } from '../lib/format'
import { defaultTransport, fetchNimBalance } from '../lib/history'
import { primaryAddress } from '../lib/identity'
import { search } from '../lib/search'
import { performSend, type SendPhase, type SendResult } from '../lib/send'
import { sameAddress } from '../lib/states'
import { useAsync } from '../lib/useAsync'
import { useDebounced } from '../lib/useDebounced'
import type { Wallet } from '../lib/wallet'
import {
  balanceLine,
  payAmountLabel,
  payButtonLabel,
  payFromLabel,
  payModeNimLabel,
  payModeUsdtLabel,
  paySelfLine,
  payToLabel,
  payUsdtEmptyBody,
  payZeroLine,
  usdtAcceptedLine,
  usdtAmountLabel,
  usdtButtonLabel,
  usdtNoGasLine,
  usdtNoLinkLine,
  usdtNoProviderLine,
  usdtWrongChainLine,
  sendConfirmedLine,
  sendConfirmingLine,
  sendDeclinedLine,
  sendNoRpcLine,
  sendSubmittingLine,
  sendRejectedLine,
  sendSettlingLine,
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
  /**
   * Which asset this screen pays. `nim` is the native flow below; `usdt`
   * pays the §6 `E` record — the EVM address the owner declared — over
   * Polygon, through whatever EIP-1193 wallet the environment offers. The
   * resolution leg is identical and verified identically; only the address
   * field consumed and the send plane differ.
   */
  const [mode, setMode] = useState<'nim' | 'usdt'>('nim')
  const [usdtSending, setUsdtSending] = useState(false)
  const [usdtResult, setUsdtResult] = useState<EvmSendOutcome | null>(null)
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
    if (mode !== 'nim' || amount.trim() === '') return null
    try {
      const luna = parseNimAmount(amount, 'Amount')
      // The network rejects a zero value outright (§5.4, and why DUST_VALUE
      // exists) — and "0" is what an empty-ish amount parses to.
      return luna === 0n ? { error: payZeroLine() } : { luna }
    } catch (error) {
      return { error: error instanceof ActionInputError ? error.message : String(error) }
    }
  }, [mode, amount])

  const parsedUsdt = useMemo((): { readonly units: bigint } | { readonly error: string } | null => {
    if (mode !== 'usdt' || amount.trim() === '') return null
    try {
      const units = parseUsdtAmount(amount)
      return units === 0n ? { error: payZeroLine() } : { units }
    } catch (error) {
      return { error: error instanceof EvmAmountError ? error.message : String(error) }
    }
  }, [mode, amount])

  // The record the owner declared, from the same verified resolve as the NIM
  // target — `''` when the name never linked one, and deliberately never any
  // other source: resolve() is still the only thing that produces an address.
  const evm = resolved?.evm ?? ''

  // Balances are display-only and every miss is a hidden line, never a zero:
  // an endpoint that cannot answer must not read as "broke". NIM asks the
  // relay for the acting sender; USDT asks the connected EVM wallet silently
  // (eth_accounts, one eth_call — no prompt, and only on Polygon). Refreshed
  // per sender/mode change and after a send that changed one of them.
  const balanceSeed = `${mode}:${sender ?? ''}:${result?.status ?? ''}:${usdtResult?.ok === true ? usdtResult.hash : ''}`
  const nimBalance = useAsync(async () => {
    if (mode !== 'nim' || sender === null) return null
    const transport = defaultTransport()
    return transport === null ? null : fetchNimBalance(transport, sender)
  }, [balanceSeed])
  const usdtBalance = useAsync(() => (mode === 'usdt' ? fetchUsdtBalance() : Promise.resolve(null)), [balanceSeed])

  // Nimiq drops a self-transaction silently: the RPC accepts it and returns a
  // hash, so nothing downstream would ever report this.
  const self = resolved !== null && sender !== null && sameAddress(sender, resolved.address)

  const luna = parsed !== null && 'luna' in parsed ? parsed.luna : null
  const canPay =
    resolved !== null && sender !== null && luna !== null && !self && !pinBlocking && wallet !== null && progress === 'idle'

  const usdtUnits = parsedUsdt !== null && 'units' in parsedUsdt ? parsedUsdt.units : null
  const canPayUsdt = resolved !== null && evm !== '' && usdtUnits !== null && !usdtSending

  const payUsdt = async () => {
    if (evm === '' || usdtUnits === null) return
    setUsdtResult(null)
    setUsdtSending(true)
    setUsdtResult(await sendUsdtOnPolygon({ to: evm, units: usdtUnits }))
    setUsdtSending(false)
  }

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
      <div className="pay-mode" role="tablist" aria-label="Asset">
        {(['nim', 'usdt'] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={mode === entry}
            className={mode === entry ? 'pay-mode-tab pay-mode-active' : 'pay-mode-tab'}
            onClick={() => {
              setMode(entry)
              setUsdtResult(null)
              setResult(null)
            }}
          >
            {entry === 'nim' ? payModeNimLabel() : payModeUsdtLabel()}
          </button>
        ))}
      </div>

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
        <EmptyState
          title="Pay a name"
          body={mode === 'nim' ? 'Type a name to see where it pays, then send NIM to it.' : payUsdtEmptyBody()}
        />
      )}
      {outcome.status === 'loading' && <Spinner />}
      {outcome.status === 'error' && <p className="field-error">{unreachableLine()}</p>}

      {/* Not resolved: the shared card says why — reserved, available, in grace,
          a delegate that did not answer, an alarm. None of them is payable. */}
      {outcome.status === 'done' && resolved === null && (
        <NameCard outcome={outcome.value} wallet={wallet} nowMs={Date.now()} actions={[]} onChanged={() => {}} onManage={null} />
      )}

      {resolved !== null && mode === 'usdt' && evm === '' && (
        <p className="note note-info">{usdtNoLinkLine(resolved.query)}</p>
      )}

      {resolved !== null && mode === 'usdt' && evm !== '' && (
        <div className="pay-form">
          <p className="pay-to">
            {payToLabel()} <NameText>{resolved.query}</NameText>
          </p>
          {/* The declared EVM record, from the verified resolve — the same
              proof discipline as the NIM target, §8.3 leaf and all. */}
          <p className="pay-evm nns-name">{evm}</p>

          <label className="pay-amount">
            {usdtAmountLabel()}
            <input
              className="pay-input"
              type="text"
              inputMode="decimal"
              placeholder="10.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              aria-label="Amount in USDT"
            />
          </label>
          {usdtBalance.status === 'done' && usdtBalance.value !== null && (
            <p className="pay-balance">{balanceLine(formatUsdt(usdtBalance.value), 'USDT')}</p>
          )}

          {parsedUsdt !== null && 'error' in parsedUsdt && <p className="field-error">{parsedUsdt.error}</p>}

          <button className="pay-go" type="button" disabled={!canPayUsdt} onClick={() => void payUsdt()}>
            {usdtButtonLabel(usdtUnits === null ? null : formatUsdt(usdtUnits))}
          </button>

          {usdtSending && <p className="note note-info">{sendSubmittingLine()}</p>}
          {usdtResult !== null && !usdtResult.ok && (
            <p className="field-error">
              {usdtResult.reason === 'no-provider' && usdtNoProviderLine()}
              {usdtResult.reason === 'declined' && sendDeclinedLine()}
              {usdtResult.reason === 'wrong-chain' && usdtWrongChainLine()}
              {usdtResult.reason === 'failed' &&
                (/insufficient funds/i.test(usdtResult.detail ?? '')
                  ? usdtNoGasLine()
                  : `Couldn’t send: ${usdtResult.detail ?? 'unknown'}`)}
            </p>
          )}
          {usdtResult !== null && usdtResult.ok && (
            <p className="note note-info">
              {usdtAcceptedLine()}{' '}
              <a href={`https://polygonscan.com/tx/${usdtResult.hash}`} target="_blank" rel="noreferrer">
                {usdtResult.hash.slice(0, 10)}…{usdtResult.hash.slice(-6)}
              </a>
            </p>
          )}
        </div>
      )}

      {resolved !== null && mode === 'nim' && (
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
          {nimBalance.status === 'done' && nimBalance.value !== null && (
            <p className="pay-balance">{balanceLine(lunaToNim(nimBalance.value), 'NIM')}</p>
          )}

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
        </div>
      )}
    </div>
  )
}
