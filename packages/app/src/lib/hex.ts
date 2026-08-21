export function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/**
 * The payload as **text**, or null if those bytes are not valid UTF-8.
 *
 * The Pay boundary needs this and the Hub boundary must never use it: the
 * mini-app SDK types `data` as a `string` with no bytes alternative and
 * utf-8 encodes whatever it is given (probed 2026-08-21 — a hex payload
 * landed on chain as the ASCII of its own hex digits, 28 bytes for a
 * 14-byte message). The Hub takes `Uint8Array | string` and `hub.ts` passes
 * bytes precisely to avoid the same double-encoding.
 *
 * Nothing this app sends can fail the decode: every NNS payload is ASCII by
 * construction (`core`'s `asciiToHex` refuses a code point above 0x7F) and
 * every NC message was built by `TextEncoder`. The check is here so that a
 * payload which somehow is not valid UTF-8 is refused before it is spent on,
 * rather than silently mangled into one that is.
 */
export function hexToText(hex: string): string | null {
  const bytes = hexToBytes(hex)
  if (bytes === null) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
