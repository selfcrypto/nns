/**
 * One sentence per log line: what the message does, for a person reading
 * `/log/decoded`. A reading aid on top of `core.parse`, never a rule — the
 * verdict beside it is the only thing that says whether the message took
 * effect. Fields that live outside the payload (the target of an `S`, the
 * new owner of an `X`, the awardee of a `U`, the price of a `B`) come from the
 * transaction's recipient and value, which the log carries beside the data.
 */

import { CONSTANTS, formatAddress, tryParseAddress, type Message, type ParseResult } from '@nimiqnames/core'

/**
 * Free text from a payload — a name, a ref, a host — rendered the way
 * `renderPayload` renders the whole payload: bytes outside printable ASCII
 * become `%xx` and `%` becomes `%25`. `core.parse` checks the shape, not the
 * alphabet (the reducer does that), so a `G` whose name carries a newline
 * parses, and written raw here it would inject a line into the text view —
 * the forgery the decoded log's design exists to make impossible.
 */
const escape = (text: string): string =>
  [...text]
    .map((char) => {
      const code = char.charCodeAt(0)
      return code < 0x20 || code > 0x7e || code === 0x25 ? `%${code.toString(16).padStart(2, '0')}` : char
    })
    .join('')

const nim = (luna: bigint): string => {
  const whole = luna / 100_000n
  const fraction = (luna % 100_000n).toString().padStart(5, '0').replace(/0+$/, '')
  return `${whole.toLocaleString('en-US')}${fraction === '' ? '' : `.${fraction}`} NIM`
}

const block = (height: number): string => `block ${height.toLocaleString('en-US')}`

const term = (lifetime: boolean): string => (lifetime ? `${CONSTANTS.LIFETIME_TERMS} years` : '1 year')

/** Spaced where it parses, so a reader can copy it into a wallet. */
const address = (compact: string): string => {
  const parsed = tryParseAddress(compact)
  return parsed === null ? escape(compact) : formatAddress(parsed)
}

const isProtocol = (compact: string): boolean => tryParseAddress(compact) === CONSTANTS.PROTOCOL_ADDRESS

function sentence(message: Message, recipient: string, value: bigint): string {
  const name = 'name' in message ? escape(message.name) : ''
  switch (message.type) {
    case 'G':
      return `registers ${name} for ${term(message.lifetime)}${message.ref === null ? '' : `, referred by ${escape(message.ref)}`}`
    case 'N':
      return `renews ${name} for ${term(message.lifetime)}`
    case 'S':
      return isProtocol(recipient) ? `points ${name} back at its owner` : `points ${name} at ${address(recipient)}`
    case 'E':
      return message.evm === '' ? `clears the EVM address of ${name}` : `binds ${name} to ${message.evm}`
    case 'X':
      return `transfers ${name} to ${address(recipient)}`
    case 'D':
      return message.host === ''
        ? `clears the subdomain host of ${name}`
        : `serves subdomains of ${name} from ${escape(message.host)}`
    case 'K':
      return `cancels what is pending on ${name}`
    case 'O':
      return `offers ${name} for ${nim(message.price)}`
    case 'B':
      return `buys ${name} for ${nim(value)}`
    case 'M':
      return `settles ${nim(value)} owed at ${block(message.height)} #${message.txIndex} to ${address(recipient)}`
    case 'A':
      return `auctions ${name} from ${nim(message.startingPrice)} until ${block(message.endHeight)}`
    case 'P':
      return `sets the base fee to ${nim(message.feeBase)} and the commission to ${Number(message.commissionBp) / 100}% from ${block(message.effectiveHeight)}`
    case 'U':
      return isProtocol(recipient)
        ? `releases ${name} from the reserved list`
        : `awards ${name} to ${address(recipient)}${message.lifetime ? ` for ${term(true)}` : ''}`
    case 'F':
      return `burns ${nim(value)}`
  }
}

/** What a log line does, in words; for a payload that does not parse, why not. */
export function describeMessage(parsed: ParseResult, recipient: string, value: bigint): string {
  return parsed.ok ? sentence(parsed.message, recipient, value) : `undecodable: ${parsed.reason}`
}
