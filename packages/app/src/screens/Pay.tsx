/**
 * **Pay** — send NIM or USDT to a name. Type a name, it resolves, enter an amount,
 * the wallet signs (docs/app-ux.md §4).
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
 *
 * A payment may carry a **reference** — the payer's own note, or the one a
 * `#/pay/<name>?amount=…&message=…` link arrived with (`lib/payRequest.ts`).
 * It goes in the transaction's data field, so the two rules that field has are
 * this screen's to enforce before the button lights: §5.1's 64 bytes, and
 * §7.5's `NNS1` prefix. Both fail silently on-chain, which is why neither is
 * discovered afterwards.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionInputError, parseNimAmount } from '../lib/actions'
import {
  EvmAmountError,
  fetchUsdtBalanceFor,
  formatUsdt,
  formatUsdtInput,
  parseUsdtAmount,
  sendUsdtOnPolygon,
  silentEvmAccount,
  type EvmSendOutcome,
} from '../lib/evm'
import { requestHostEvmAddress } from '../lib/sdk'
import { CONSTANTS } from '@nimiqnames/core'
import { bytesToHex } from '../lib/hex'
import { payMessageBytes, payMessageFault, payRequestFromHash, payRequestFromLink } from '../lib/payRequest'
import { lunaToNim, lunaToNimInput } from '../lib/format'
import { defaultTransport, fetchNimBalance } from '../lib/history'
import { primaryAddress } from '../lib/identity'
import { search } from '../lib/search'
import { performSend, type SendPhase, type SendResult } from '../lib/send'
import { sameAddress, type AppAction } from '../lib/states'
import { useAsync } from '../lib/useAsync'
import { useRetryWhilePropagating } from '../lib/useRetryWhilePropagating'
import { useDebounced } from '../lib/useDebounced'
import type { Wallet } from '../lib/wallet'
import {
  SCREEN_SUB,
  SCREEN_TITLE,
  balanceLabel,
  clearLabel,
  maxLabel,
  payAmountLabel,
  payButtonLabel,
  payFromLabel,
  payMessageBudgetLine,
  payMessageEditLabel,
  payMessageFromLinkLine,
  payMessageHint,
  payMessageLabel,
  payMessagePlaceholder,
  payUsdtNoMessageLine,
  PAY_MESSAGE_FAULT_TEXT,
  payModeNimLabel,
  payIdleTitle,
  payModeUsdtAria,
  payModeUsdtLabel,
  payNameAria,
  payNamePlaceholder,
  payNimEmptyBody,
  paySelfLine,
  payToLabel,
  payUsdtEmptyBody,
  resolveLabel,
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
import { Hint } from '../components/Hint'
import { NameCard } from '../components/NameCard'
import { PasteButton } from '../components/PasteButton'
import { PinCheck } from '../components/PinCheck'
import { AddressRow } from '../components/result'
import { TrustBar } from '../components/TrustBar'
import { NameText, Spinner } from '../components/ui'
import styles from './pay.module.css'

/** The same settle as Buy — one query per typed word, not one per character. */
const SETTLE_MS = 1_000

/**
 * The one action an unresolved card offers here. A name that is available is
 * not payable, and "Available" with nothing to do about it is a dead end — the
 * same card on Buy offers Register, so this screen offers the same button, the
 * same flow. Not the rest of `ACQUIRE_ACTIONS`: a listing or a gifted renewal
 * is Buy's job, and a resolved name is a payment here.
 */
const REGISTER_ONLY: readonly AppAction[] = ['register']

export function PayScreen({
  wallet,
  seed,
  onQuery,
  onConnect,
}: {
  wallet: Wallet | null
  seed: string
  /** The settled query, for the URL — a reload comes back to the same name (`App.tsx`). */
  onQuery?: ((query: string) => void) | undefined
  /** What the Register button does with no wallet attached — the same connect Buy's card uses. */
  onConnect?: (() => void) | null | undefined
}) {
  // Seeded by Buy's "Pay this address" handoff, with the query as typed — a
  // dotted one included, since this screen resolves through the same `search()`.
  const [text, setText] = useState(seed)
  /**
   * What the link asked for. Read **in a render-phase initializer**, never in
   * an effect: `useDebounced` seeds with its initial value, so the `onQuery`
   * effect below fires on the first commit, and `App.tsx`'s `replaceState`
   * rewrites the hash through `formatRoute`, which cannot carry a query. Any
   * effect of this screen's would already be looking at a stripped hash.
   */
  const [request] = useState(() => payRequestFromHash(window.location.hash))
  const [amount, setAmount] = useState(request.amount ?? '')
  const [message, setMessage] = useState(request.message ?? '')
  /** A reference that arrived with the link is the payee's wording until Edit. */
  const [messageLocked, setMessageLocked] = useState(request.message !== null)
  const [nonce, setNonce] = useState(0)

  /**
   * Which asset this screen pays. `nim` is the native flow below; `usdt`
   * pays the §6 `E` record — the EVM address the owner declared — over
   * Polygon, through whatever EIP-1193 wallet the environment offers. The
   * resolution leg is identical and verified identically; only the address
   * field consumed and the send plane differ.
   */
  const [mode, setMode] = useState<'nim' | 'usdt'>(request.asset ?? 'nim')
  const [usdtSending, setUsdtSending] = useState(false)
  const [usdtResult, setUsdtResult] = useState<EvmSendOutcome | null>(null)
  const [chosenSender, setChosenSender] = useState<string | null>(null)
  const [pinBlocking, setPinBlocking] = useState(false)
  /** Why a paste did nothing, on the one screen with no other note line. */
  const [pasteNote, setPasteNote] = useState<string | null>(null)
  const [progress, setProgress] = useState<SendPhase | 'idle'>('idle')
  const [result, setResult] = useState<SendResult | null>(null)

  /**
   * What goes into the recipient field. A **pasted payment link** fills the
   * screen instead of being searched as a name: the field keeps the name, and
   * the amount, the reference and the asset come with it. Anything else is the
   * text, unchanged — `payRequestFromLink` answers `null` for every keystroke
   * of a typed name.
   *
   * A link applies **whole**, exactly as one opened from the address bar does:
   * the payer just named a different payee, so an amount or a note left over
   * from the last one describes a payment nobody is making. One rule, whichever
   * way the link arrived.
   */
  const acceptQuery = (value: string) => {
    setPasteNote(null)
    const link = payRequestFromLink(value)
    if (link === null) {
      setText(value)
      return
    }
    setText(link.name)
    setAmount(link.request.amount ?? '')
    setMessage(link.request.message ?? '')
    setMessageLocked(link.request.message !== null)
    setMode(link.request.asset ?? 'nim')
  }

  const trimmed = text.trim().toLowerCase()
  const [query, flushQuery] = useDebounced(trimmed, SETTLE_MS)
  const outcome = useAsync(query === '' ? null : () => search(query), [query, nonce])
  const retrying = useRetryWhilePropagating(outcome, () => setNonce((v) => v + 1))

  useEffect(() => {
    onQuery?.(query)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the URL follows the query, not the callback identity
  }, [query])

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
  const [evmAccount, setEvmAccount] = useState<string | null>(null)
  const [usdtTries, setUsdtTries] = useState(0)
  const evmPrompted = useRef(false)
  const balanceSeed = `${mode}:${sender ?? ''}:${evmAccount ?? ''}:${result?.status ?? ''}:${usdtTries}`

  // Two numbers: the set's total, which the badge shows, and the chosen
  // sender's own, which is all MAX may offer — a transaction spends one
  // account, and the redesign's MAX filled in the sum across the set.
  const nimBalance = useAsync(async (): Promise<{ readonly total: bigint; readonly mine: bigint | null } | null> => {
    if (mode !== 'nim' || wallet === null || sender === null) return null
    const transport = defaultTransport()
    if (transport === null) return null
    const targets = wallet.balanceAddresses.length > 0 ? wallet.balanceAddresses : [sender]
    const pool = targets.some((address) => sameAddress(address, sender)) ? targets : [...targets, sender]
    const balances = await Promise.all(pool.map((address) => fetchNimBalance(transport, address)))
    const known = balances.slice(0, targets.length).filter((balance): balance is bigint => balance !== null)
    if (known.length === 0) return null
    const mine = balances[pool.findIndex((address) => sameAddress(address, sender))] ?? null
    return { total: known.reduce((sum, balance) => sum + balance, 0n), mine }
  }, [balanceSeed])

  const usdtBalance = useAsync(async () => {
    if (mode !== 'usdt') return null
    let account = evmAccount ?? (await silentEvmAccount())
    if (account === null && !evmPrompted.current) {
      // The one prompt, on the tab tap that chose this mode
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

  // The reference's two rules, judged once (`lib/payRequest.ts`). Both are
  // silent on-chain, so the button is what refuses — never the network.
  const messageFault = payMessageFault(message)

  const luna = parsed !== null && 'luna' in parsed ? parsed.luna : null
  const nimHeld = nimBalance.status === 'done' && nimBalance.value !== null ? nimBalance.value.total : null
  const nimMine = nimBalance.status === 'done' && nimBalance.value !== null ? nimBalance.value.mine : null
  const canPay =
    resolved !== null &&
    sender !== null &&
    luna !== null &&
    !self &&
    !pinBlocking &&
    wallet !== null &&
    messageFault === null &&
    progress === 'idle'

  const usdtUnits = parsedUsdt !== null && 'units' in parsedUsdt ? parsedUsdt.units : null
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
    if (outcome.from !== null) setEvmAccount(outcome.from)
    setUsdtTries((tries) => tries + 1)
  }

  const pay = async () => {
    if (resolved === null || sender === null || luna === null || wallet === null) return
    // Never send without the reference the payer meant to attach: a payment
    // that arrives unlabelled is the silent drop this check exists to prevent.
    if (messageFault !== null) return
    setResult(null)
    const transport = defaultTransport()
    const outcomeOfSend = await performSend({
      wallet,
      transport,
      // No NNS message — the data field carries the payer's reference, if any,
      // as plain UTF-8. Both adapters take it from here: the Hub path passes the
      // bytes through, the Pay path decodes them back to text (`lib/hex.ts`).
      request: {
        sender,
        recipient: resolved.address,
        value: luna,
        dataHex: message === '' ? '' : bytesToHex(new TextEncoder().encode(message)),
      },
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
    setResult(outcomeOfSend)
    if (outcomeOfSend.status === 'confirmed') {
      setAmount('')
      setMessage('')
      setMessageLocked(false)
    }
  }

  return (
    <div className={`screen pay-screen ${styles.lightThemeWrapper}`}>
      <div className={styles.heroSection}>
        <div className={styles.heroContent}>
          {/* Header */}
          <div className={styles.payHeader}>
            <h1 className={styles.payTitle}>{SCREEN_TITLE.pay}</h1>
            <p className={styles.paySubtitle}>{SCREEN_SUB.pay}</p>
          </div>

          {/* Main Glassmorphism Panel */}
          <div className={styles.payPanel}>
            {/* Top Toolbar: Asset Switch & Available Balance */}
            <div className={styles.topToolbar}>
              <div className={`pay-mode ${styles.assetSwitchTrack}`} role="tablist" aria-label="Asset">
                {(['nim', 'usdt'] as const).map((entry) => {
                  const isActive = mode === entry
                  return (
                    <button
                      key={entry}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      aria-label={entry === 'nim' ? payModeNimLabel() : payModeUsdtAria()}
                      className={`pay-mode-tab ${styles.assetTab} ${
                        isActive ? `pay-mode-active ${styles.assetTabActive}` : ''
                      }`}
                      onClick={() => {
                        setMode(entry)
                        setUsdtResult(null)
                        setResult(null)
                      }}
                    >
                      {entry === 'nim' ? (
                        <>
                          <img
                            src="/assets/images/nim-icon.svg"
                            alt=""
                            className={styles.assetTabIcon}
                            aria-hidden="true"
                          />
                          <span>{payModeNimLabel()}</span>
                        </>
                      ) : (
                        <>
                          <img
                            src="/assets/images/polygon-icon.svg"
                            alt=""
                            className={styles.assetTabIcon}
                            aria-hidden="true"
                          />
                          <span>{payModeUsdtLabel()}</span>
                        </>
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Balance Display (Aligned on the right of the top toolbar) */}
              {mode === 'nim' && nimHeld !== null && (
                <div className={`pay-balance ${styles.balanceBadge}`}>
                  <span className={styles.balanceIcon}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="4" width="20" height="16" rx="2" />
                      <path d="M7 15h0M2 10h20" />
                    </svg>
                  </span>
                  <span className={styles.balanceLabel}>{balanceLabel()}</span>
                  <span className={styles.balanceAmount}>{lunaToNim(nimHeld)}</span>
                  <span className={styles.balanceTicker}>NIM</span>
                </div>
              )}
              {mode === 'usdt' && (
                usdtBalance.status === 'done' ? (
                  usdtHeld !== null ? (
                    <div className={`pay-balance ${styles.balanceBadge}`}>
                      <span className={styles.balanceIcon}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="4" width="20" height="16" rx="2" />
                          <path d="M7 15h0M2 10h20" />
                        </svg>
                      </span>
                      <span className={styles.balanceLabel}>{balanceLabel()}</span>
                      <span className={styles.balanceAmount}>{formatUsdt(usdtHeld)}</span>
                      <span className={styles.balanceTicker}>USDT</span>
                    </div>
                  ) : evmAccount !== null ? (
                    <div className={`pay-balance ${styles.balanceBadge}`}>
                      <span className={styles.balanceMuted}>{usdtBalanceUnknownLine()}</span>
                    </div>
                  ) : null
                ) : null
              )}
            </div>

            {/* Recipient Search Input */}
            <form
              className={styles.searchForm}
              onSubmit={(event) => {
                event.preventDefault()
                if (trimmed !== '') {
                  flushQuery()
                  setNonce((v) => v + 1)
                }
              }}
            >
              <div className={styles.searchWrapper}>
                <div className={styles.searchIcon}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </div>
                <input
                  className={`search-input nns-name ${styles.searchInput}`}
                  type="text"
                  inputMode="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={payNamePlaceholder()}
                  value={text}
                  onChange={(event) => acceptQuery(event.target.value)}
                  aria-label={payNameAria()}
                />
                {text !== '' && (
                  <button
                    type="button"
                    className={styles.searchClearBtn}
                    onClick={() => {
                      setText('')
                      setAmount('')
                      setResult(null)
                      setUsdtResult(null)
                    }}
                    aria-label={clearLabel()}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
                {text === '' && <PasteButton onPaste={acceptQuery} onNote={setPasteNote} />}
                <button className={styles.searchSubmitBtn} type="submit" disabled={trimmed === ''}>
                  {resolveLabel()}
                </button>
              </div>
            </form>

            {pasteNote !== null && <p className="note" style={{ textAlign: 'center', margin: '8px 0 0' }}>{pasteNote}</p>}

            {/* Idle State with Description Card */}
            {outcome.status === 'idle' && (
              <div className={styles.idleContent}>
                <div className={styles.idleCard}>
                  <div className={styles.idleIconWrap}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                  </div>
                  <h3 className={styles.idleTitle}>{payIdleTitle()}</h3>
                  <p className={styles.idleBody}>
                    {mode === 'nim' ? payNimEmptyBody() : payUsdtEmptyBody()}
                  </p>
                </div>
              </div>
            )}

            {/* Loading Spinner */}
            {outcome.status === 'loading' && (
              <div className={styles.loadingWrap}>
                <Spinner />
              </div>
            )}

            {/* Error Message */}
            {outcome.status === 'error' && (
              <p className="field-error" style={{ textAlign: 'center' }}>
                {unreachableLine()}
              </p>
            )}

            {/* Unresolved NameCard */}
            {outcome.status === 'done' && resolved === null && (
              <div style={{ width: '100%' }}>
                <NameCard
                  outcome={outcome.value}
                  wallet={wallet}
                  nowMs={Date.now()}
                  actions={REGISTER_ONLY}
                  onChanged={() => setNonce((v) => v + 1)}
                  onManage={null}
                  onPay={null}
                  onConnect={onConnect}
                  retrying={retrying}
                />
              </div>
            )}

            {/* USDT: No EVM record linked */}
            {resolved !== null && mode === 'usdt' && evm === '' && (
              <div className={`${styles.statusBanner} ${styles.statusInfo}`}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>{usdtNoLinkLine(resolved.query)}</span>
              </div>
            )}

            {/* USDT Payment Form */}
            {resolved !== null && mode === 'usdt' && evm !== '' && (
              <div className={`pay-form ${styles.payForm}`}>
                <div className={styles.recipientCard}>
                  <div className={styles.recipientHeader}>
                    <span className={styles.recipientTitle}>{payToLabel()}</span>
                    <span className={styles.recipientNameBadge}>
                      <NameText>{resolved.query}</NameText>
                    </span>
                  </div>
                  <div className={styles.evmAddressBox}>
                    <p className={`pay-evm nns-name`} style={{ margin: 0 }}>{evm}</p>
                  </div>
                </div>

                <div className={styles.fieldLabel}>
                  <div className={styles.amountHeader}>
                    <span className={styles.amountLabel}>{usdtAmountLabel()}</span>
                    {usdtHeld !== null && (
                      <button
                        type="button"
                        className={styles.maxBtn}
                        onClick={() => setAmount(formatUsdtInput(usdtHeld))}
                      >
                        MAX ({formatUsdt(usdtHeld)})
                      </button>
                    )}
                  </div>
                  <div className={styles.amountInputContainer}>
                    <input
                      className={`pay-input ${styles.amountInput}`}
                      type="text"
                      inputMode="decimal"
                      placeholder="10.00"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      aria-label="Amount in USDT"
                    />
                    <span className={styles.currencyPill}>USDT</span>
                  </div>
                </div>

                {/* An ERC-20 transfer is a selector and two arguments (`lib/evm.ts`):
                    there is nowhere to put a note. Saying so is the point — a
                    reference dropped in silence is the failure the byte rule
                    exists to prevent. */}
                {message !== '' && (
                  <p className={styles.messageNote} style={{ margin: 0 }}>{payUsdtNoMessageLine()}</p>
                )}
                {parsedUsdt !== null && 'error' in parsedUsdt && (
                  <p className="field-error" style={{ margin: 0 }}>{parsedUsdt.error}</p>
                )}
                {usdtShort && usdtHeld !== null && usdtUnits !== null && (
                  <p className="field-error" style={{ margin: 0 }}>
                    {usdtShortBalanceLine(formatUsdt(usdtHeld), formatUsdt(usdtUnits))}
                  </p>
                )}

                {!usdtSending && (
                  <button
                    className={`pay-go ${styles.payBtn}`}
                    type="button"
                    disabled={!canPayUsdt}
                    onClick={() => void payUsdt()}
                  >
                    {usdtButtonLabel(usdtUnits === null ? null : formatUsdt(usdtUnits))}
                  </button>
                )}

                {usdtSending && (
                  <div className={`${styles.statusBanner} ${styles.statusInfo}`}>
                    <Spinner />
                    <span>{sendSubmittingLine()}</span>
                  </div>
                )}

                {usdtResult !== null && !usdtResult.ok && (
                  <div className={`${styles.statusBanner} ${styles.statusError}`}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="15" y1="9" x2="9" y2="15" />
                      <line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                    <span>
                      {usdtResult.reason === 'no-provider' && usdtNoProviderLine()}
                      {usdtResult.reason === 'declined' && sendDeclinedLine()}
                      {usdtResult.reason === 'wrong-chain' && usdtWrongChainLine()}
                      {usdtResult.reason === 'failed' &&
                        (usdtResult.cause?.kind === 'no-usdt'
                          ? usdtShortBalanceLine(
                              formatUsdt(usdtResult.cause.held),
                              usdtUnits !== null ? formatUsdt(usdtUnits) : amount,
                            )
                          : usdtResult.cause?.kind === 'no-pol'
                            ? usdtNoGasLine()
                            : `Couldn’t send: ${usdtResult.detail ?? 'unknown'}`)}
                    </span>
                  </div>
                )}

                {usdtResult !== null && usdtResult.ok && (
                  <div className={`${styles.statusBanner} ${styles.statusSuccess}`}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span>
                      {usdtAcceptedLine()}{' '}
                      <a
                        className={styles.txLink}
                        href={`https://polygonscan.com/tx/${usdtResult.hash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {usdtResult.hash.slice(0, 10)}…{usdtResult.hash.slice(-6)} ↗
                      </a>
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* NIM Payment Form */}
            {resolved !== null && mode === 'nim' && (
              <div className={`pay-form ${styles.payForm}`}>
                <div className={styles.recipientCard}>
                  <div className={styles.recipientHeader}>
                    <span className={styles.recipientTitle}>{payToLabel()}</span>
                    <span className={styles.recipientNameBadge}>
                      <NameText>{resolved.query}</NameText>
                    </span>
                  </div>
                  <PinCheck query={resolved.query} address={resolved.address} onBlocking={setPinBlocking} />
                  <AddressRow address={resolved.address} full />
                </div>

                {addresses.length > 1 && (
                  <label className={styles.fieldLabel}>
                    <span>{payFromLabel()}</span>
                    <div className={styles.selectWrap}>
                      <select
                        className={`pay-select nns-name ${styles.paySelect}`}
                        value={sender ?? ''}
                        onChange={(event) => setChosenSender(event.target.value)}
                      >
                        {addresses.map((address) => (
                          <option key={address} value={address}>
                            {address}
                          </option>
                        ))}
                      </select>
                      <div className={styles.selectChevron}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </div>
                    </div>
                  </label>
                )}

                <div className={styles.fieldLabel}>
                  <div className={styles.amountHeader}>
                    <span className={styles.amountLabel}>{payAmountLabel()}</span>
                    {nimMine !== null && (
                      <button
                        type="button"
                        className={styles.maxBtn}
                        onClick={() => setAmount(lunaToNimInput(nimMine))}
                      >
                        {maxLabel(lunaToNim(nimMine))}
                      </button>
                    )}
                  </div>
                  <div className={styles.amountInputContainer}>
                    <input
                      className={`pay-input ${styles.amountInput}`}
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00001"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      aria-label="Amount in NIM"
                    />
                    <span className={styles.currencyPill}>NIM</span>
                  </div>
                </div>

                <div className={styles.fieldLabel}>
                  <div className={styles.amountHeader}>
                    <span className={styles.amountLabel}>
                      {payMessageLabel()} <Hint>{payMessageHint()}</Hint>
                    </span>
                    {messageLocked && (
                      <button type="button" className={styles.maxBtn} onClick={() => setMessageLocked(false)}>
                        {payMessageEditLabel()}
                      </button>
                    )}
                  </div>
                  <div className={styles.amountInputContainer}>
                    <input
                      className={`pay-input ${styles.amountInput} ${styles.messageInput}`}
                      type="text"
                      placeholder={payMessagePlaceholder()}
                      value={message}
                      // `readOnly`, not `disabled`: the text stays selectable and
                      // announced, and Edit is the one way to take it over.
                      readOnly={messageLocked}
                      onChange={(event) => setMessage(event.target.value)}
                      aria-label={payMessageLabel()}
                    />
                  </div>
                  <div className={styles.messageFooter}>
                    <span className={styles.messageNote}>{messageLocked ? payMessageFromLinkLine() : ''}</span>
                    {message !== '' && (
                      <span className={`composer-count ${messageFault === 'OVER_BUDGET' ? 'composer-over' : ''}`}>
                        {payMessageBudgetLine(payMessageBytes(message), CONSTANTS.MAX_DATA_BYTES)}
                      </span>
                    )}
                  </div>
                </div>

                {messageFault !== null && (
                  <p className="field-error" style={{ margin: 0 }}>{PAY_MESSAGE_FAULT_TEXT[messageFault]}</p>
                )}
                {parsed !== null && 'error' in parsed && (
                  <p className="field-error" style={{ margin: 0 }}>{parsed.error}</p>
                )}
                {self && (
                  <p className="field-error" style={{ margin: 0 }}>{paySelfLine()}</p>
                )}

                {progress === 'idle' && (
                  <button
                    className={`pay-go ${styles.payBtn}`}
                    type="button"
                    disabled={!canPay}
                    onClick={() => void pay()}
                  >
                    {luna === null ? payButtonLabel(null) : payButtonLabel(lunaToNim(luna))}
                  </button>
                )}

                {progress === 'submitting' && (
                  <div className={`${styles.statusBanner} ${styles.statusInfo}`}>
                    <Spinner />
                    <span>{sendSubmittingLine()}</span>
                  </div>
                )}
                {progress === 'confirming' && (
                  <div className={`${styles.statusBanner} ${styles.statusInfo}`}>
                    <Spinner />
                    <span>{sendConfirmingLine()}</span>
                  </div>
                )}

                {result !== null && (
                  <div
                    className={`${styles.statusBanner} ${
                      result.status === 'confirmed'
                        ? styles.statusSuccess
                        : result.status === 'unchecked' || result.status === 'settling'
                          ? styles.statusInfo
                          : styles.statusError
                    }`}
                  >
                    {result.status === 'confirmed' && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                    {(result.status === 'declined' || result.status === 'rejected' || result.status === 'blocked' || result.status === 'failed') && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="15" y1="9" x2="9" y2="15" />
                        <line x1="9" y1="9" x2="15" y2="15" />
                      </svg>
                    )}
                    <span>
                      {result.status === 'confirmed' && sendConfirmedLine()}
                      {result.status === 'declined' && sendDeclinedLine()}
                      {result.status === 'settling' && sendSettlingLine()}
                      {result.status === 'rejected' && sendRejectedLine()}
                      {result.status === 'unconfirmed' && sendUnconfirmedLine()}
                      {result.status === 'unchecked' && sendUncheckedLine()}
                      {result.status === 'blocked' && sendNoRpcLine()}
                      {result.status === 'failed' && `Couldn’t send: ${result.detail}`}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          <TrustBar screen="pay" />
        </div>
      </div>
    </div>
  )
}
