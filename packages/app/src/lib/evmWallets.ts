/**
 * The EVM wallets the environment offers, and the one question the `E` sheet
 * asks them: which address is yours (§6 `E` pre-fill).
 *
 * EIP-1193 is a third party's surface, not the mini-app SDK's: Pay's WebView
 * injects `window.ethereum`, a desktop browser's extensions announce
 * themselves over EIP-6963, and this module is the only place that knows
 * either. It moved out of `sdk.ts` on 2026-09-28, when the sheet started
 * listing every wallet instead of asking the first one it found.
 *
 * `eth_accounts` answers `[]` until the site is *connected*, and
 * `eth_requestAccounts` is what raises the wallet's connect UI. So there are
 * two calls: a silent one for the already-connected case, and a
 * gesture-driven request that walks the flow every EVM dApp uses.
 *
 * A positive answer is a pre-fill, never an authority: the user still
 * reviews the address, and the record is whatever they confirm.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>
}

export interface EvmWallet {
  /** The EIP-6963 `uuid`, or `'injected'` for `window.ethereum`. */
  readonly id: string
  /** What the wallet calls itself; `null` for `window.ethereum`, which has no name. */
  readonly name: string | null
  readonly source: 'announced' | 'injected'
  readonly provider: Eip1193Provider
}

function asEip1193(candidate: unknown): Eip1193Provider | null {
  if (typeof candidate !== 'object' || candidate === null) return null
  return typeof (candidate as { request?: unknown }).request === 'function' ? (candidate as Eip1193Provider) : null
}

const WALLET_NAME_MAX = 24

/**
 * A wallet's name is the wallet's own text, and it lands inside a button
 * label: control characters out, whitespace collapsed, capped. Any extension
 * can announce as any name, so this is a label and never an identity.
 */
export function cleanWalletName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean === '' ? null : clean.slice(0, WALLET_NAME_MAX).trim()
}

/**
 * Every EIP-6963 announcer, in the order they answered, then
 * `window.ethereum` when none of them is that same object. Announcements are
 * dispatched synchronously from the request per the EIP, so no waiting is
 * involved; absence is an empty list.
 */
export function listEvmWallets(win: Window | undefined = globalThis.window): readonly EvmWallet[] {
  if (win === undefined) return []
  const wallets: EvmWallet[] = []
  const listen = (event: Event) => {
    // An announcement this page cannot read costs that entry, not the list.
    try {
      const detail = (event as CustomEvent<{ info?: { uuid?: unknown; name?: unknown }; provider?: unknown }>).detail
      const provider = asEip1193(detail?.provider)
      const uuid = detail?.info?.uuid
      if (provider === null || typeof uuid !== 'string' || uuid === '') return
      if (wallets.some((wallet) => wallet.id === uuid || wallet.provider === provider)) return
      wallets.push({ id: uuid, name: cleanWalletName(detail?.info?.name), source: 'announced', provider })
    } catch {
      /* skipped */
    }
  }
  win.addEventListener('eip6963:announceProvider', listen)
  try {
    win.dispatchEvent(new Event('eip6963:requestProvider'))
  } finally {
    win.removeEventListener('eip6963:announceProvider', listen)
  }
  const injected = asEip1193((win as { ethereum?: unknown }).ethereum)
  if (injected !== null && !wallets.some((wallet) => wallet.provider === injected)) {
    wallets.push({ id: 'injected', name: null, source: 'injected', provider: injected })
  }
  return wallets
}

/**
 * One provider, for the callers that have no list to draw (the USDT send):
 * `window.ethereum`, or the first EIP-6963 announcer.
 */
export function discoverEvmProvider(win: Window | undefined = globalThis.window): Eip1193Provider | null {
  if (win === undefined) return null
  return asEip1193((win as { ethereum?: unknown }).ethereum) ?? listEvmWallets(win)[0]?.provider ?? null
}

const firstEvmAddress = (answer: unknown): string | null => {
  if (!Array.isArray(answer)) return null
  const first = answer.find((entry) => typeof entry === 'string' && /^0x[0-9a-fA-F]{40}$/.test(entry))
  return typeof first === 'string' ? first.toLowerCase() : null
}

/** Silent: the already-connected case only. `eth_accounts` never prompts. */
export async function silentEvmAddress(provider: Eip1193Provider): Promise<string | null> {
  try {
    return firstEvmAddress(await provider.request({ method: 'eth_accounts' }))
  } catch {
    return null
  }
}

/**
 * A provider rejection is usually a plain `{code, message}` object, not an
 * `Error` — `String()` on one is the literal `[object Object]` that reached
 * a screen on 2026-08-23. Dig the human text out, wherever this wallet put
 * it, and cap the JSON fallback so a screen never renders a novel.
 */
export function evmErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'object' && error !== null) {
    const { message, data } = error as { message?: unknown; data?: unknown }
    if (typeof message === 'string' && message !== '') return message
    const nested = (data as { message?: unknown } | null)?.message
    if (typeof nested === 'string' && nested !== '') return nested
    try {
      return JSON.stringify(error).slice(0, 200)
    } catch {
      return 'the wallet refused without a message'
    }
  }
  return String(error)
}

const errorCode = (error: unknown): unknown => (error as { code?: unknown } | null)?.code

export const looksDeclined = (error: unknown): boolean => {
  if (errorCode(error) === 4001) return true // EIP-1193 userRejectedRequest
  return /reject|declin|cancel|denied/i.test(evmErrorMessage(error))
}

/** `-32002`: the wallet already has a request of this kind open, and leaves it open. */
const looksBusy = (error: unknown): boolean =>
  errorCode(error) === -32002 || /already pending|already processing/i.test(evmErrorMessage(error))

const DETAIL_MAX = 120

export type EvmAddressOutcome =
  | { readonly ok: true; readonly address: string }
  | { readonly ok: false; readonly reason: 'declined' | 'busy' | 'empty' }
  | { readonly ok: false; readonly reason: 'failed'; readonly detail: string }

/**
 * Prompting: raises the wallet's own connect sheet, so call it from a user
 * gesture and nowhere else. Every refusal is a value, and there is no
 * timeout: a wallet waiting on its owner has not failed, and the promise
 * settles whenever they answer.
 */
export async function requestEvmAddress(provider: Eip1193Provider): Promise<EvmAddressOutcome> {
  try {
    const address = firstEvmAddress(await provider.request({ method: 'eth_requestAccounts' }))
    return address === null ? { ok: false, reason: 'empty' } : { ok: true, address }
  } catch (error) {
    if (looksBusy(error)) return { ok: false, reason: 'busy' }
    if (looksDeclined(error)) return { ok: false, reason: 'declined' }
    return { ok: false, reason: 'failed', detail: evmErrorMessage(error).slice(0, DETAIL_MAX) }
  }
}

/** The same request for a caller that only wants an address or nothing (Pay's USDT tab). */
export async function requestHostEvmAddress(): Promise<string | null> {
  const provider = discoverEvmProvider()
  if (provider === null) return null
  const outcome = await requestEvmAddress(provider)
  return outcome.ok ? outcome.address : null
}
