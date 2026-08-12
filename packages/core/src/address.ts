/**
 * Nimiq address codec — user-friendly `NQ…` string ↔ raw 20 bytes.
 *
 * Not one of the seven deliverables in `tasks/00-core.md`, but required by
 * them: §8.1 says a Merkle leaf carries "the raw 20-byte form, never the `NQ`
 * string", while the RPC hands the indexer `NQ…`. Somebody has to convert, and
 * it must be byte-exact or every root forks.
 *
 * Implemented here rather than pulled from `@nimiq/core` because that package
 * drags WASM into a component whose entire contract is purity and determinism.
 * The format is 36 characters: `NQ`, two IBAN mod-97-10 check digits, and 32
 * characters of Nimiq base32 encoding 160 bits.
 */

declare const AddressBrand: unique symbol

/**
 * A validated Nimiq address in **compact** form: 36 characters, no spaces,
 * uppercase. Use {@link formatAddress} for display.
 *
 * The brand means an `Address` can only be produced by {@link parseAddress} or
 * {@link addressFromBytes}, so nothing downstream can hand the Merkle tree an
 * unchecked string.
 */
export type Address = string & { readonly [AddressBrand]: true }

/** Nimiq's base32 alphabet. Omits `I`, `O`, `W` and `Z`. */
const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVXY'

const ADDRESS_LENGTH = 36
export const ADDRESS_BYTES = 20

export class AddressError extends Error {
  override readonly name = 'AddressError'
}

const fail = (message: string): never => {
  throw new AddressError(message)
}

function base32Encode(bytes: Uint8Array): string {
  let value = 0
  let bits = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(chars: string): Uint8Array {
  const out = new Uint8Array(ADDRESS_BYTES)
  let value = 0
  let bits = 0
  let i = 0
  for (const ch of chars) {
    const index = ALPHABET.indexOf(ch)
    if (index < 0) fail(`address contains a character outside the Nimiq base32 alphabet: ${ch}`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out[i++] = (value >>> (bits - 8)) & 0xff
      bits -= 8
    }
  }
  return out
}

/**
 * IBAN mod-97-10 check digits for a 32-character body, per ISO 13616: append
 * the country code and `00`, map letters to `A`=10…`Z`=35, and take the
 * remainder mod 97. Folded digit by digit so no intermediate exceeds 2^53.
 */
function checkDigits(body: string): string {
  let mod = 0
  for (const ch of `${body}NQ00`) {
    const code = ch.charCodeAt(0)
    const n = code >= 65 ? code - 55 : code - 48
    mod = n >= 10 ? (mod * 100 + n) % 97 : (mod * 10 + n) % 97
  }
  return String(98 - mod).padStart(2, '0')
}

/** Strip spaces and uppercase, without validating. */
const compact = (input: string): string => input.replace(/\s+/g, '').toUpperCase()

/**
 * Parse a user-friendly address, with or without the conventional spacing.
 * Throws {@link AddressError} on anything malformed — length, alphabet, or a
 * failed checksum.
 */
export function parseAddress(input: string): Address {
  const s = compact(input)
  if (s.length !== ADDRESS_LENGTH) {
    fail(`address must be ${ADDRESS_LENGTH} characters once spaces are removed, got ${s.length}`)
  }
  if (!s.startsWith('NQ')) fail('address must begin with NQ')

  const given = s.slice(2, 4)
  if (!/^\d{2}$/.test(given)) fail('address check digits must be two digits')

  const body = s.slice(4)
  for (const ch of body) {
    if (!ALPHABET.includes(ch)) {
      fail(`address contains a character outside the Nimiq base32 alphabet: ${ch}`)
    }
  }

  const expected = checkDigits(body)
  if (given !== expected) fail(`address checksum is ${given}, expected ${expected}`)

  return s as Address
}

/** Parse, or return `null` instead of throwing. */
export function tryParseAddress(input: string): Address | null {
  try {
    return parseAddress(input)
  } catch {
    return null
  }
}

/** The raw 20-byte form used in Merkle leaves (§8.1). */
export function addressToBytes(address: Address): Uint8Array {
  return base32Decode(address.slice(4))
}

/** Build an address from its raw 20-byte form, computing the check digits. */
export function addressFromBytes(bytes: Uint8Array): Address {
  if (bytes.length !== ADDRESS_BYTES) {
    fail(`an address is ${ADDRESS_BYTES} bytes, got ${bytes.length}`)
  }
  const body = base32Encode(bytes)
  return `NQ${checkDigits(body)}${body}` as Address
}

/** Conventional display form: eight groups of four, space separated. */
export function formatAddress(address: Address): string {
  return (address.match(/.{1,4}/g) ?? []).join(' ')
}

/**
 * 20 zero bytes — `NQ07 0000 …`, which is both the canonical burn address (§3)
 * and the §8.1 encoding of an unset recovery address.
 */
export const ZERO_ADDRESS: Address = addressFromBytes(new Uint8Array(ADDRESS_BYTES))

export const isZeroAddress = (address: Address): boolean => address === ZERO_ADDRESS

/** Byte-exact equality. Addresses are already canonical, so this is `===`. */
export const addressEquals = (a: Address, b: Address): boolean => a === b
