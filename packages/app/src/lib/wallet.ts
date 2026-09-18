/**
 * The adapter seam of the two-adapter intent, now live on both halves. One
 * `Wallet` shape; Pay and Hub differ only in connect, signing and identity —
 * everything above this module is shared.
 *
 * Sends: the Hub path signs (`hub.ts`) and broadcasts through the operator
 * RPC endpoint (`sendRawTransaction`). The Pay path sends through the wallet
 * itself (`sdk.ts`), which both signs and broadcasts — so it needs no
 * transport and works with none configured.
 *
 * The §10.5 gate came off on 2026-08-21: the probe ran on a post-fork build
 * and the confirmation sheet honoured an app-supplied `value` and `fee`
 * exactly. What the same run found instead is the constraint this file now
 * carries — **Pay chooses which address signs, and there is no sender
 * parameter to overrule it.** So the Pay identity is the whole set
 * `listAccounts()` reports rather than its first entry, and an owner action
 * the wallet signs with the wrong set member is caught where every other
 * silent failure is: the effect never appears and `performSend` says
 * `unconfirmed`.
 */

import {
  NO_IDENTITY,
  clearHubAddresses,
  loadHubAddresses,
  loadPayDismissed,
  savePayDismissed,
  saveHubAddresses,
  withActive,
  withAddress,
  type Identity,
  type StorageLike,
} from './identity'
import { isHostedWebView } from './chrome'
import { hubChooseAddress, hubSignTransaction } from './hub'
import { connectWallet, devAddressOverride, paySendTransaction, type WalletSession } from './sdk'
import { defaultTransport, fetchAccountType, isDefiniteRejection, type HistoryTransport } from './history'

export interface SubmitRequest {
  readonly sender: string
  readonly recipient: string
  readonly value: bigint
  readonly dataHex: string
}

export type SubmitOutcome =
  | { readonly ok: true; readonly hash: string | null; readonly serializedTxHex: string | null }
  | { readonly ok: false; readonly reason: 'declined' | 'no-rpc' | 'failed'; readonly detail?: string }

export interface Wallet {
  readonly identity: Identity
  /** Hub: one popup, one more address. Pay: ask the host again. */
  readonly connect: (() => Promise<Identity>) | null
  /**
   * Hub: forget the set, so a different address can be chosen. Pay: stop this
   * app using the host's accounts on this device — it revokes nothing in the
   * wallet, which has no revocation to offer.
   *
   * **Both are non-null on both adapters now.** They were null on the Pay path
   * until 2026-08-22, on the reasoning that the host's set is unconditional;
   * what that produced was a user who had connected and could find no way back
   * out, and a declined prompt that fell through to the *Hub* connector inside
   * Pay's own WebView.
   */
  readonly disconnect: (() => Identity) | null
  /**
   * Hub: make one of the connected addresses the acting one, and keep it
   * picked across a reload. Null on Pay: the host hands over one address and
   * chooses the signer itself, so there is nothing to pick between.
   */
  readonly pick: ((address: string) => Identity) | null
  /**
   * The addresses whose balances add up to what this wallet can spend —
   * distinct from `identity` on the Pay path, on purpose. Identity drops
   * the Remote wallet's HTLC contract (§7.2: ownership follows the
   * authorizing key, and a contract is the wrong thing to call "your
   * address"), but the contract is exactly where Pay keeps the spendable
   * NIM — so a balance summed over the identity read ~0 on a funded wallet
   * (Kike, 2026-08-23). Pay exposes no balance method of its own; the sum
   * over the **raw** `listAccounts()` set, contract included, is the number
   * the wallet itself shows. Hub: same as the identity.
   */
  readonly balanceAddresses: readonly string[]
  readonly submit: (request: SubmitRequest, transport: HistoryTransport | null) => Promise<SubmitOutcome>
}

export async function detectWallet(storage: StorageLike, search: string): Promise<Wallet> {
  const paySession = loadPayDismissed(storage) ? null : await connectWallet()
  if (paySession !== null) return await payWallet(paySession, storage)
  // **Inside Pay, the fallback is Pay again — never the Hub.** `connectWallet`
  // returns null for a declined prompt exactly as it does for "no wallet here",
  // and falling through on the first case offered a *desktop web-wallet
  // connector inside Pay's own WebView* (Kike, 2026-08-22). The container is a
  // wallet; the answer to a declined connection is to ask it again.
  if (isHostedWebView()) return await payWallet(null, storage)
  return hubWallet(storage, search)
}

/**
 * Nimiq Pay's account set includes the **Remote wallet's HTLC contract** beside
 * the durable address, and the SDK says nothing about which is which — both are
 * just strings from `listAccounts()`. A contract is the wrong thing to show a
 * user as "your address": it expires, and since §7.2 attribution (r25)
 * ownership follows the authorizing key, so nothing the user owns is ever
 * recorded against it (Kike, 2026-08-22).
 *
 * `getAccountByAddress`'s `type` is the only signal that tells them apart, so
 * the filter is a node round trip and therefore best-effort in both directions:
 *
 *   - **Only a confirmed contract is dropped.** No endpoint, a refusal, an
 *     unexpected shape — every one of those keeps the address. Hiding an
 *     address a user really owns hides their names with it; showing a contract
 *     for a few days is a cosmetic wart.
 *   - **The set never empties.** If every lookup somehow said "contract", the
 *     original set stands: an empty identity is indistinguishable from a
 *     disconnected wallet, and this is not entitled to cause that.
 */
async function withoutContracts(addresses: readonly string[]): Promise<readonly string[]> {
  const transport = defaultTransport()
  if (transport === null || addresses.length < 2) return addresses
  const types = await Promise.all(addresses.map((address) => fetchAccountType(transport, address)))
  const kept = addresses.filter((_, index) => {
    const type = types[index]
    return type === null || type === 'basic'
  })
  return kept.length === 0 ? addresses : kept
}

/**
 * `session` is null when Pay is the host but has given us no accounts — the
 * user declined the prompt, or dismissed the app's use of them. That is still
 * a Pay wallet: it knows no address yet and `connect` asks again.
 */
async function payWallet(session: WalletSession | null, storage: StorageLike): Promise<Wallet> {
  // Canonical spaced form, like every other address entering the set: the
  // identicon bug of 2026-08-21 was one spelling meeting another.
  let addresses: readonly string[] = []
  // The unfiltered set, canonicalised but with the HTLC contract kept: what
  // Pay's spendable balance is summed over. See `Wallet.balanceAddresses`.
  let rawAddresses: readonly string[] = []
  let current = session
  const adopt = async (adopted: WalletSession | null) => {
    current = adopted
    addresses = []
    rawAddresses = []
    if (adopted === null) return
    for (const address of adopted.addresses) rawAddresses = withAddress(rawAddresses, address)
    addresses = await withoutContracts(rawAddresses)
  }
  await adopt(session)

  return {
    get identity() {
      return { kind: 'pay', addresses } satisfies Identity
    },

    get balanceAddresses() {
      return rawAddresses
    },

    /**
     * Ask Pay again. Nothing else in the app can recover from a declined
     * prompt — before this, the only way back was to kill the WebView.
     */
    connect: async () => {
      savePayDismissed(storage, false)
      await adopt(await connectWallet())
      return { kind: 'pay', addresses }
    },

    /**
     * Stop *this app* using Pay's accounts, on this device. It revokes nothing
     * in the wallet — Pay hands its set over unconditionally and offers no
     * revocation — and `wording.ts` says so rather than implying otherwise.
     */
    disconnect: () => {
      savePayDismissed(storage, true)
      current = null
      addresses = []
      rawAddresses = []
      return { kind: 'pay', addresses }
    },

    pick: null,

    // No transport: the wallet signs and broadcasts in one call, so a Pay
    // send works with no RPC endpoint configured. The confirm loop above
    // still needs one for the chat flows, and asks for it itself.
    submit: async (request) => {
      if (current === null) return { ok: false, reason: 'failed', detail: 'no Nimiq Pay account is connected' }
      const sent = await paySendTransaction(current.provider, {
        recipient: request.recipient,
        valueLuna: request.value,
        dataHex: request.dataHex,
      })
      if (!sent.ok) {
        return sent.declined
          ? { ok: false, reason: 'declined' }
          : { ok: false, reason: 'failed', detail: sent.detail }
      }
      // A 32-byte hash, despite the declarations calling it the serialized
      // transaction (probed). It is passed on for polls that can key on a
      // hash and is never treated as confirmation — §5.3.
      return { ok: true, hash: sent.hash, serializedTxHex: null }
    },
  }
}

function hubWallet(storage: StorageLike, search: string): Wallet {
  let addresses = loadHubAddresses(storage)
  const override = devAddressOverride(search)
  if (override !== null) addresses = withAddress(addresses, override)

  const identity = (): Identity =>
    addresses.length === 0 ? { ...NO_IDENTITY, kind: 'hub' } : { kind: 'hub', addresses }

  return {
    get identity() {
      return identity()
    },

    // Hub addresses are ordinary accounts: identity and balance agree.
    get balanceAddresses() {
      return addresses
    },

    connect: async () => {
      const chosen = await hubChooseAddress()
      if (chosen !== null) {
        // An address just added is the one the user means to use next.
        addresses = withActive(withAddress(addresses, chosen), chosen)
        saveHubAddresses(storage, addresses)
      }
      return identity()
    },

    // The saved list's order is the pick: first is acting.
    pick: (address) => {
      addresses = withActive(addresses, address)
      saveHubAddresses(storage, addresses)
      return identity()
    },

    disconnect: () => {
      addresses = []
      clearHubAddresses(storage)
      // Dev-only wrinkle: `devAddressOverride` reads an address out of the URL
      // and `detectWallet` re-adds it, so a disconnect does not survive a
      // reload while that query parameter is present. Dev path only.
      return identity()
    },

    submit: async (request, transport) => {
      if (transport === null) return { ok: false, reason: 'no-rpc' }
      let height: number
      try {
        const answer = await transport('getBlockNumber', [])
        if (typeof answer !== 'number') return { ok: false, reason: 'failed', detail: 'no block number' }
        height = answer
      } catch (error) {
        return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
      }
      const signed = await hubSignTransaction({
        sender: request.sender,
        recipient: request.recipient,
        valueLuna: request.value,
        dataHex: request.dataHex,
        validityStartHeight: height,
      })
      if (signed === 'declined') return { ok: false, reason: 'declined' }
      try {
        await transport('sendRawTransaction', [signed.serializedTxHex])
      } catch (error) {
        // Only a proven rejection is a failure. Anything ambiguous — a 5xx,
        // a timeout, a dead proxy — may have relayed the transaction, so it
        // falls through to the confirm loop: a "failed" here invites a
        // retry, a retry re-signs at a fresh validity height, and that is a
        // different transaction and a second fee.
        if (isDefiniteRejection(error)) {
          return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
        }
      }
      return { ok: true, hash: signed.hash, serializedTxHex: signed.serializedTxHex }
    },
  }
}
