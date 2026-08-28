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

import { useMemo, useRef, useState } from 'react'
import { ActionInputError, parseNimAmount } from '../lib/actions'
import {
  EvmAmountError,
  fetchUsdtBalanceFor,
  formatUsdt,
  parseUsdtAmount,
  sendUsdtOnPolygon,
  silentEvmAccount,
  type EvmSendOutcome,
} from '../lib/evm'
import { requestHostEvmAddress } from '../lib/sdk'
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
  usdtShortBalanceLine,
  usdtBalanceUnknownLine,
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

export function PayScreen({ wallet, seed }: { wallet: Wallet | null; seed: string }) {
  // Seeded by Buy's "Pay this address" handoff, with the query as typed — a
  // dotted one included, since this screen resolves through the same `search()`.
  const [text, setText] = useState(seed)
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
  // an endpoint that cannot answer must not read as "broke".
  //
  // NIM sums over `wallet.balanceAddresses`, not the identity: inside Pay
  // the spendable NIM sits on the Remote wallet's HTLC contract, which the
  // identity deliberately drops (§7.2) — summing the identity read ~0 on a
  // funded wallet. The SDK exposes no balance method, so the node is asked
  // about every account Pay reported, contract included.
  //
  // USDT needs an account before it can read anything: the silent
  // `eth_accounts` (empty until this site is authorized — often per
  // session), a send attempt's own `from` — refusals included — or, once
  // per visit, the wallet's own connect prompt. There is no balance button:
  // a balance is not something to ask for (tester, 2026-08-27), so the row
  // acquires its account itself, and a declined prompt stays declined.
  const [evmAccount, setEvmAccount] = useState<string | null>(null)
  const [usdtTries, setUsdtTries] = useState(0)
  const evmPrompted = useRef(false)
  const balanceSeed = `${mode}:${sender ?? ''}:${evmAccount ?? ''}:${result?.status ?? ''}:${usdtTries}`
  const nimBalance = useAsync(async () => {
    if (mode !== 'nim' || wallet === null) return null
    const transport = defaultTransport()
    if (transport === null) return null
    const targets = wallet.balanceAddresses.length > 0 ? wallet.balanceAddresses : sender !== null ? [sender] : []
    if (targets.length === 0) return null
    const balances = await Promise.all(targets.map((address) => fetchNimBalance(transport, address)))
    const known = balances.filter((balance): balance is bigint => balance !== null)
    return known.length === 0 ? null : known.reduce((sum, balance) => sum + balance, 0n)
  }, [balanceSeed])
  const usdtBalance = useAsync(async () => {
    if (mode !== 'usdt') return null
    let account = evmAccount ?? (await silentEvmAccount())
    if (account === null && !evmPrompted.current) {
      // The one prompt, on the tab tap that chose this mode — inside Pay it
      // is the host's own wallet answering; elsewhere it is the standard
      // connect sheet, and a decline is final until the next visit.
      evmPrompted.current = true
      account = await requestHostEvmAddress()
    }
    if (account === null) return null
    if (account !== evmAccount) setEvmAccount(account)
    return fetchUsdtBalanceFor(account)
  }, [balanceSeed])

  // Nimiq drops a self-transaction silently: the RPC accepts it and returns a
  // hash, so nothing downstream would ever report this.
  const self = resolved !== null && sender !== null && sameAddress(sender, resolved.address)

  const luna = parsed !== null && 'luna' in parsed ? parsed.luna : null
  const canPay =
    resolved !== null && sender !== null && luna !== null && !self && !pinBlocking && wallet !== null && progress === 'idle'

  const usdtUnits = parsedUsdt !== null && 'units' in parsedUsdt ? parsedUsdt.units : null
  // Refuse a send the displayed balance already rules out — with the real
  // reason, before the wallet's ambiguous "insufficient funds" can stand in
  // for it. Only a *known* balance blocks: an unreadable one hides a line,
  // never a button (the display-miss discipline in evm.ts).
  const usdtHeld = usdtBalance.status === 'done' ? usdtBalance.value : null
  const usdtShort = usdtHeld !== null && usdtUnits !== null && usdtUnits > usdtHeld
  const canPayUsdt = resolved !== null && evm !== '' && usdtUnits !== null && !usdtSending && !usdtShort

  const payUsdt = async () => {
    if (evm === '' || usdtUnits === null) return
    setUsdtResult(null)
    setUsdtSending(true)
    const outcome = await sendUsdtOnPolygon({ to: evm, units: usdtUnits })
    setUsdtResult(outcome)
    setUsdtSending(false)
    // Every attempt teaches: the account it acted for (refusals included)
    // and a fresh balance read — the refusal above, the figure below it.
    if (outcome.from !== null) setEvmAccount(outcome.from)
    setUsdtTries((tries) => tries + 1)
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

      {/* The payer's own balance, always — under the tabs, not behind a
          button, not gated on a resolved name (tester, 2026-08-27: the row
          hiding on a miss read as a broken control). A known account whose
          read missed says so; no account at all claims nothing. */}
      {mode === 'nim' && nimBalance.status === 'done' && nimBalance.value !== null && (
        <p className="pay-balance">{balanceLine(lunaToNim(nimBalance.value), 'NIM')}</p>
      )}
      {mode === 'usdt' &&
        usdtBalance.status === 'done' &&
        (usdtBalance.value !== null ? (
          <p className="pay-balance">{balanceLine(formatUsdt(usdtBalance.value), 'USDT')}</p>
        ) : evmAccount !== null ? (
          <p className="pay-balance">{usdtBalanceUnknownLine()}</p>
        ) : null)}

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
        <NameCard outcome={outcome.value} wallet={wallet} nowMs={Date.now()} actions={[]} onChanged={() => {}} onManage={null} onPay={null} />
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
          {parsedUsdt !== null && 'error' in parsedUsdt && <p className="field-error">{parsedUsdt.error}</p>}
          {usdtShort && usdtHeld !== null && usdtUnits !== null && (
            <p className="field-error">{usdtShortBalanceLine(formatUsdt(usdtHeld), formatUsdt(usdtUnits))}</p>
          )}

          <button className="pay-go" type="button" disabled={!canPayUsdt} onClick={() => void payUsdt()}>
            {usdtButtonLabel(usdtUnits === null ? null : formatUsdt(usdtUnits))}
          </button>

          {usdtSending && <p className="note note-info">{sendSubmittingLine()}</p>}
          {usdtResult !== null && !usdtResult.ok && (
            <p className="field-error">
              {usdtResult.reason === 'no-provider' && usdtNoProviderLine()}
              {usdtResult.reason === 'declined' && sendDeclinedLine()}
              {usdtResult.reason === 'wrong-chain' && usdtWrongChainLine()}
              {/* Refusal wording follows the *measured* cause, never the
                  wallet's error text — "insufficient funds" is what Polygon
                  says for missing gas and what wallets say for missing
                  tokens, and guessing between them blamed POL on a
                  zero-USDT account. */}
              {usdtResult.reason === 'failed' &&
                (usdtResult.cause?.kind === 'no-usdt'
                  ? usdtShortBalanceLine(
                      formatUsdt(usdtResult.cause.held),
                      usdtUnits !== null ? formatUsdt(usdtUnits) : amount,
                    )
                  : usdtResult.cause?.kind === 'no-pol'
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
