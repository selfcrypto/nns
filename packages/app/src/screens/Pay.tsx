/**
 * **Pay** — send NIM or USDT to a name. Type a name, it resolves, enter an amount,
 * the wallet signs (docs/app-ux.md §4). Redesigned to match the modern glassmorphism
 * discovery theme of Buy and Market.
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
import { NameText, Spinner } from '../components/ui'
import styles from './pay.module.css'

/** The same settle as Buy — one query per typed word, not one per character. */
const SETTLE_MS = 1_000

export function PayScreen({ wallet, seed }: { wallet: Wallet | null; seed: string }) {
  // Seeded by Buy's "Pay this address" handoff, with the query as typed — a
  // dotted one included, since this screen resolves through the same `search()`.
  const [text, setText] = useState(seed)
  const [amount, setAmount] = useState('')
  const [nonce, setNonce] = useState(0)

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
  const [query, flushQuery] = useDebounced(trimmed, SETTLE_MS)
  const outcome = useAsync(query === '' ? null : () => search(query), [query, nonce])

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

  const luna = parsed !== null && 'luna' in parsed ? parsed.luna : null
  const nimHeld = nimBalance.status === 'done' ? nimBalance.value : null
  const canPay =
    resolved !== null && sender !== null && luna !== null && !self && !pinBlocking && wallet !== null && progress === 'idle'

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
    setResult(null)
    const transport = defaultTransport()
    const outcomeOfSend = await performSend({
      wallet,
      transport,
      // No NNS message: a plain transfer carries no data at all.
      request: { sender, recipient: resolved.address, value: luna, dataHex: '' },
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
    if (outcomeOfSend.status === 'confirmed') setAmount('')
  }

  return (
    <div className={`screen pay-screen ${styles.lightThemeWrapper}`}>
      <div className={styles.heroSection}>
        <div className={styles.heroContent}>
          {/* Header */}
          <div className={styles.payHeader}>
            <h1 className={styles.payTitle}>Pay a Name</h1>
            <p className={styles.paySubtitle}>
              Send NIM or Polygon USDT directly to any verified NNS address.
            </p>
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
                      aria-label={entry === 'nim' ? payModeNimLabel() : payModeUsdtLabel()}
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
                          <span>NIM</span>
                        </>
                      ) : (
                        <>
                          <img
                            src="/assets/images/polygon-icon.svg"
                            alt=""
                            className={styles.assetTabIcon}
                            aria-hidden="true"
                          />
                          <span>USDT</span>
                        </>
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Balance Display (Aligned on the right of the top toolbar) */}
              {mode === 'nim' && nimBalance.status === 'done' && nimHeld !== null && (
                <div className={`pay-balance ${styles.balanceBadge}`}>
                  <span className={styles.balanceIcon}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="4" width="20" height="16" rx="2" />
                      <path d="M7 15h0M2 10h20" />
                    </svg>
                  </span>
                  <span className={styles.balanceLabel}>Balance:</span>
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
                      <span className={styles.balanceLabel}>Balance:</span>
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
                  placeholder="name, or label.name"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  aria-label="Name to pay"
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
                    aria-label="Clear recipient search"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
                <button className={styles.searchSubmitBtn} type="submit" disabled={trimmed === ''}>
                  Resolve
                </button>
              </div>
            </form>

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
                  <h3 className={styles.idleTitle}>Pay any NNS name</h3>
                  <p className={styles.idleBody}>
                    {mode === 'nim'
                      ? 'Type a registered name to resolve its on-chain Nimiq address and send NIM.'
                      : payUsdtEmptyBody()}
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
              <div style={{ width: '100%', animation: 'fadeIn 0.3s ease-in' }}>
                <NameCard
                  outcome={outcome.value}
                  wallet={wallet}
                  nowMs={Date.now()}
                  actions={[]}
                  onChanged={() => setNonce((v) => v + 1)}
                  onManage={null}
                  onPay={null}
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
                        onClick={() => setAmount(formatUsdt(usdtHeld))}
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

                {parsedUsdt !== null && 'error' in parsedUsdt && (
                  <p className="field-error" style={{ margin: 0 }}>{parsedUsdt.error}</p>
                )}
                {usdtShort && usdtHeld !== null && usdtUnits !== null && (
                  <p className="field-error" style={{ margin: 0 }}>
                    {usdtShortBalanceLine(formatUsdt(usdtHeld), formatUsdt(usdtUnits))}
                  </p>
                )}

                <button
                  className={`pay-go ${styles.payBtn}`}
                  type="button"
                  disabled={!canPayUsdt}
                  onClick={() => void payUsdt()}
                >
                  {usdtSending ? (
                    <>
                      <Spinner />
                      <span>Sending...</span>
                    </>
                  ) : (
                    usdtButtonLabel(usdtUnits === null ? null : formatUsdt(usdtUnits))
                  )}
                </button>

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
                    {nimHeld !== null && (
                      <button
                        type="button"
                        className={styles.maxBtn}
                        onClick={() => setAmount(lunaToNim(nimHeld))}
                      >
                        MAX ({lunaToNim(nimHeld)} NIM)
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

                {parsed !== null && 'error' in parsed && (
                  <p className="field-error" style={{ margin: 0 }}>{parsed.error}</p>
                )}
                {self && (
                  <p className="field-error" style={{ margin: 0 }}>{paySelfLine()}</p>
                )}

                <button
                  className={`pay-go ${styles.payBtn}`}
                  type="button"
                  disabled={!canPay}
                  onClick={() => void pay()}
                >
                  {progress === 'submitting' || progress === 'confirming' ? (
                    <>
                      <Spinner />
                      <span>{progress === 'submitting' ? 'Submitting...' : 'Confirming...'}</span>
                    </>
                  ) : (
                    luna === null ? payButtonLabel(null) : payButtonLabel(lunaToNim(luna))
                  )}
                </button>

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

          {/* Trust Bar */}
          <div className={styles.trustBar}>
            <div className={styles.trustItem}>
              <svg className={styles.trustIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
              <span>100% On-Chain</span>
            </div>
            <span className={styles.trustDot}>•</span>
            <div className={styles.trustItem}>
              <svg className={styles.trustIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
              <span>Merkle Verified</span>
            </div>
            <span className={styles.trustDot}>•</span>
            <div className={styles.trustItem}>
              <svg className={styles.trustIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                <line x1="12" y1="22.08" x2="12" y2="12" />
              </svg>
              <span>Self-Custody</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
