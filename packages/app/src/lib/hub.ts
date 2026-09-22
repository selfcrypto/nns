/**
 * The Nimiq Hub adapter's wallet half — the only file that imports
 * `@nimiq/hub-api`. Popup-driven: `chooseAddress` grows the identity set,
 * `signTransaction` signs exactly what the app built (the Hub API exists so
 * apps control `value` and `extraData` — no §10.5 probe question on this
 * path) and broadcasts nothing; the caller broadcasts through the operator
 * RPC endpoint.
 */

import { APP_NAME, hubEndpoint } from '../config'
import { canonicalAddress } from './identity'
import { hexToBytes } from './hex'

export interface HubSigned {
  readonly serializedTxHex: string
  readonly hash: string
}

export type HubSignOutcome = HubSigned | 'declined'

type HubApiInstance = {
  chooseAddress(request: { appName: string }): Promise<{ address: string }>
  signMessage(request: { appName: string; signer: string; message: string }): Promise<{
    signer: string
    signerPublicKey: Uint8Array
    signature: Uint8Array
  }>
  signTransaction(request: {
    appName: string
    sender: string
    recipient: string
    value: number
    fee?: number
    extraData?: Uint8Array | string
    validityStartHeight: number
  }): Promise<{ serializedTx: string; hash: string }>
}

let instance: Promise<HubApiInstance> | null = null

const hub = (): Promise<HubApiInstance> =>
  (instance ??= import('@nimiq/hub-api').then(
    ({ default: HubApi }) => new HubApi(hubEndpoint()) as unknown as HubApiInstance,
  ))

/** One popup, one chosen address — canonical, or null when the user closes it. */
export async function hubChooseAddress(): Promise<string | null> {
  try {
    const result = await (await hub()).chooseAddress({ appName: APP_NAME })
    return canonicalAddress(result.address)
  } catch {
    return null
  }
}

export type HubSignMessageOutcome = { readonly publicKey: string; readonly signature: string } | 'declined'

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * `signMessage`: the Hub signs `\x16Nimiq Signed Message:\n` + length + text,
 * hashed, with the chosen address's key (`core.verifySignedMessage`'s `nimiq`
 * convention). One popup; a close is `declined`.
 */
export async function hubSignMessage(signer: string, message: string): Promise<HubSignMessageOutcome> {
  try {
    const signed = await (await hub()).signMessage({ appName: APP_NAME, signer, message })
    return { publicKey: toHex(signed.signerPublicKey), signature: toHex(signed.signature) }
  } catch {
    return 'declined'
  }
}

export async function hubSignTransaction(request: {
  sender: string
  recipient: string
  valueLuna: bigint
  dataHex: string
  validityStartHeight: number
}): Promise<HubSignOutcome> {
  // The one place bigint narrows to the wallet's number (rpc-reference §8).
  if (request.valueLuna > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`value ${request.valueLuna} luna exceeds the SDK's number boundary`)
  }
  const extraData = hexToBytes(request.dataHex)
  if (extraData === null) throw new RangeError('dataHex is not hex')
  try {
    const signed = await (await hub()).signTransaction({
      appName: APP_NAME,
      sender: request.sender,
      recipient: request.recipient,
      value: Number(request.valueLuna),
      fee: 0,
      // Always bytes, never a string: the Hub reads a string as UTF-8 text,
      // which would double-encode an already-hex payload.
      extraData,
      validityStartHeight: request.validityStartHeight,
    })
    return { serializedTxHex: signed.serializedTx, hash: signed.hash }
  } catch {
    // The Hub rejects on user cancel; the distinction from a transport
    // failure is not observable, and both mean "nothing was signed".
    return 'declined'
  }
}
