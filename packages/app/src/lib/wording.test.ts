/**
 * The wording rules of docs/app-states.md §5 are decided, not stylistic —
 * these tests pin the ones a later edit would most plausibly break.
 */
import { CONSTANTS } from '@nns/core'
import { describe, expect, it } from 'vitest'

import { blocksApprox } from './format'
import {
  referredByLine,
  referralsCountLine,
  shareHint,
  shareInGraceLine,
  WARNING_TEXT,
  WARNING_TONE,
  alarmBody,
  delegateFailedLine,
  graceLine,
  connectWalletLabel,
  parentNotDelegatingLine,
  paySelfLine,
  proofPendingLine,
  queryFaultLine,
  propagatingLine,
  propagatingRetryLine,
  resolverIdentityLine,
  resolverUrlShown,
  shortNameNoteLine,
  STATUS_TAG,
  termPerk,
  verifiedByLine,
} from './wording'

const LABS = { name: 'Example Labs', url: 'https://api.example.com' }
const OURS = { name: 'Ours', url: 'https://nns.ours.example' }

describe('"Verified by N resolvers" (resolver README decision, 2026-08-14)', () => {
  it('is the count, singular at 1', () => {
    expect(verifiedByLine({ required: 1, queried: 1, agreed: 1, resolvers: [LABS] })).toBe('Verified by 1 resolver')
  })

  it('never says "unverified" about a healthy answer', () => {
    const line = verifiedByLine({ required: 1, queried: 1, agreed: 1, resolvers: [LABS] })
    expect(line.toLowerCase()).not.toContain('unverified')
  })

  it('is plural above 1', () => {
    expect(verifiedByLine({ required: 2, queried: 2, agreed: 2, resolvers: [LABS, OURS] })).toBe('Verified by 2 resolvers')
  })

  // The count names nobody, which is the whole complaint at N = 2 (Kike,
  // 2026-08-28). The party is the name; the URL is the half a user can check.
  it('names every agreeing resolver by name and API URL', () => {
    expect(resolverIdentityLine(LABS)).toBe('Example Labs — https://api.example.com')
    expect(resolverIdentityLine(OURS)).toContain('https://nns.ours.example')
  })

  // A same-origin `/api` is right for fetch and wrong on the card: shown
  // bare it reads as a path that is not the API (Kike, 2026-09-10).
  it('shows a same-origin path as the absolute URL it fetches', () => {
    expect(resolverUrlShown('/api', 'https://nimiqnames.com/#/buy')).toBe('https://nimiqnames.com/api')
    expect(resolverUrlShown('https://nns.sonartech.pro', 'https://nimiqnames.com/')).toBe('https://nns.sonartech.pro')
    expect(resolverUrlShown('https://nns.sonartech.pro/', 'https://nimiqnames.com/')).toBe('https://nns.sonartech.pro')
  })

  it('shows a value that is not a URL as configured', () => {
    expect(resolverUrlShown('/api', '')).toBe('/api')
  })
})

describe('propagation is depth, not alarm (Kike, 2026-09-10)', () => {
  it('never uses the alarm vocabulary', () => {
    for (const line of [propagatingLine(), propagatingRetryLine(true), propagatingRetryLine(false), STATUS_TAG.propagating]) {
      expect(line.toLowerCase()).not.toMatch(/disagree|stop|do not pay|alarm|wrong/)
    }
  })
})

describe('delegate failures are attributed to the host, never the subdomain', () => {
  it('never claims the subdomain does not exist', () => {
    for (const line of [delegateFailedLine('exchange'), parentNotDelegatingLine('exchange')]) {
      expect(line.toLowerCase()).not.toContain('does not exist')
      expect(line.toLowerCase()).not.toContain('doesn’t exist')
      expect(line.toLowerCase()).not.toContain('not found')
    }
  })

  it('names the parent, whose half of the answer is proven', () => {
    expect(delegateFailedLine('exchange')).toContain('exchange')
  })
})

describe('tones (alarm vocabulary is reserved)', () => {
  it('no resolver warning maps to the alarm tone — warnings never halt', () => {
    for (const tone of Object.values(WARNING_TONE)) {
      expect(tone).not.toBe('alarm')
    }
  })

  it('depth states read as depth: no alarm words in their text', () => {
    for (const code of ['PROOF_PENDING', 'ANCHOR_QUORUM_NOT_MET', 'TARGET_CHANGED_SINCE_CHECKPOINT'] as const) {
      const text = WARNING_TEXT[code].toLowerCase()
      for (const forbidden of ['warning', 'danger', 'unverified', 'wrong', 'divergence', 'do not pay']) {
        expect(text).not.toContain(forbidden)
      }
    }
  })

  it('halting failures do use the reserved vocabulary', () => {
    expect(alarmBody('PROOF_INVALID').toLowerCase()).toContain('do not pay')
  })
})

describe('pinning (the one non-halting state allowed the alarm tier)', () => {
  it('the mismatch body spends the reserved vocabulary — that is what it is reserved for', async () => {
    const { pinMismatchBody, pinFirstUseLine } = await import('./wording')
    expect(pinMismatchBody('example', '8/16/2026').toLowerCase()).toContain('do not pay')
    // First use is quiet: no alarm words on the everyday state.
    for (const forbidden of ['warning', 'stop', 'do not pay', 'unverified']) {
      expect(pinFirstUseLine().toLowerCase()).not.toContain(forbidden)
    }
  })
})

describe('a broken checker never reads as a negative result (decisions.md)', () => {
  it('the inbox-down line blames the inbox service, not resolvers, and says nothing is lost', async () => {
    const { inboxDownLine } = await import('./wording')
    const line = inboxDownLine().toLowerCase()
    expect(line).toContain('inbox service')
    expect(line).toContain('on-chain')
    expect(line).not.toContain('resolver')
  })

  it('no ending claims the network refused a transaction — not even unconfirmed', async () => {
    const { sendUncheckedLine, sendUnconfirmedLine, sendSettlingLine } = await import('./wording')
    const unchecked = sendUncheckedLine().toLowerCase()
    const unconfirmed = sendUnconfirmedLine().toLowerCase()

    // This assertion used to require the opposite — that `unconfirmed` say
    // "the network did not include this transaction" — and so pinned the bug
    // in place: the app said exactly that about a registration that was
    // already registered and already listed in "My names" (Kike,
    // 2026-08-21). The app never observes the network refusing anything. It
    // observes an effect not yet visible, which is a claim about our own
    // indexer, and a transaction not found on chain, which can still be in
    // flight. Neither entitles it to speak for the network.
    for (const line of [unconfirmed, unchecked]) {
      expect(line).not.toContain('did not include')
      expect(line).not.toContain('refused')
      expect(line).not.toContain('rejected')
    }
    // And the on-chain-but-not-yet-indexed ending is not a failure at all.
    const settling = sendSettlingLine().toLowerCase()
    expect(settling).toContain('confirmed on chain')
    expect(settling).not.toContain('fail')
    expect(unchecked).not.toContain('fail')
    // And it must not prompt a retry: a retry re-signs a different
    // transaction and can pay a second fee.
    expect(unchecked).not.toContain('retry')
    expect(unchecked).not.toContain('try again')
  })
})

describe('state lines', () => {
  it('grace is neither gone nor free', () => {
    const line = graceLine('≈ Sep 15, 2026').toLowerCase()
    expect(line).toContain('not available')
    expect(line).toContain('renew')
  })

  it('the short-name note explains reservation, not invalidity (§4.1 r18)', () => {
    const line = shortNameNoteLine().toLowerCase()
    expect(line).toContain('reserved')
    expect(line).toContain('released')
    // The states doc §3 keeps the fired `U` out of user-facing language.
    expect(line).not.toContain('governance')
    expect(line).not.toMatch(/\bu\b/)
  })
})

/**
 * Every assertion here is a sentence that was wrong on the live deployment
 * (Kike, 2026-08-17) — "they're all really weird and mostly incorrect".
 */
describe('field wording says which rule broke, and says it truthfully', () => {
  it('states §4.2\'s boundary clause, not a rule that does not exist', () => {
    const line = queryFaultLine({ kind: 'name', reason: 'BOUNDARY_DIGIT' })
    // It used to read "Digits can only lead or trail, not both" — but 2nimiq2,
    // 9nimiq9 and 23nimiq45 are all valid. What is barred is 0 and 1 at an end.
    expect(line).toContain('0')
    expect(line).toContain('1')
    expect(line.toLowerCase()).not.toContain('not both')
  })

  it('never tells a user a malformed name is reserved', () => {
    // "Reserved" implies a `U` could open it. For a name failing rules 2–5
    // nothing ever can — the reducer forfeits INVALID_NAME at any length.
    for (const reason of ['BAD_CHARACTER', 'NO_LETTER', 'LEADING_HYPHEN', 'INTERIOR_DIGIT', 'BOUNDARY_DIGIT'] as const) {
      expect(queryFaultLine({ kind: 'name', reason }).toLowerCase(), reason).not.toContain('reserved')
    }
  })

  it('describes a dot with an empty side as a format, and shows one', () => {
    const line = queryFaultLine({ kind: 'dot-shape' })
    expect(line).toContain('label.name')
    expect(line.toLowerCase()).not.toContain('reserved')
  })

  it('never applies name rules to a label: no 5-character floor, no reservation, no letters', () => {
    for (const reason of ['TOO_SHORT', 'TOO_LONG', 'BAD_CHARACTER', 'LEADING_HYPHEN', 'TRAILING_HYPHEN', 'DOUBLE_HYPHEN'] as const) {
      const line = queryFaultLine({ kind: 'label', reason }).toLowerCase()
      expect(line, reason).not.toContain('reserved')
      expect(line, reason).not.toContain('5 characters')
      expect(line, reason).not.toContain('at least one letter')
      // Every label line says which half of the query it is about.
      expect(line, reason).toContain('dot')
    }
  })
})

describe('the wallet seam shows through in wording as little as in code', () => {
  it('the connect label names no single wallet', () => {
    const label = connectWalletLabel()
    expect(label).toBe('Connect Wallet')
    // The app runs against Hub and Pay behind one seam; naming one is wrong in
    // the other, and which answers is detectWallet's business.
    expect(label).not.toMatch(/hub|pay|nimiq/i)
  })

  it('the self-payment refusal says nothing would arrive, not that it is disallowed', () => {
    // Nimiq accepts a self-transaction at the RPC and drops it on the network,
    // so the honest claim is about the outcome, not about permission.
    const line = paySelfLine().toLowerCase()
    expect(line).toContain('your own address')
    expect(line).toMatch(/nothing would arrive|drops/)
  })
})

describe('the referral lines (§10.7)', () => {
  it('the review says who benefits and that the price is unchanged', () => {
    const line = referredByLine('ricomav', '10%')
    expect(line).toContain('ricomav')
    expect(line).toContain('10%')
    expect(line).toContain('you pay the same')
  })

  it('the tile never spends alarm vocabulary on a name in grace', () => {
    for (const text of [shareInGraceLine(), shareHint('10%'), referralsCountLine(0, '0')]) {
      expect(text).not.toMatch(/\b(stop|do not pay|divergence|red)\b/i)
    }
  })
})

describe('the two lines a tempo era would otherwise turn into lies (tasks/17)', () => {
  it('render the term from TERM_LENGTH, never a typed period', () => {
    expect(termPerk(31_536_000)).toBe('One-year terms')
    expect(termPerk(604_800)).toBe('7-day terms')
    expect(termPerk(3_600)).toBe('60-minute terms')
    expect(termPerk(7_200)).toBe('2-hour terms')
    expect(termPerk()).toBe(termPerk(CONSTANTS.TERM_LENGTH))
  })

  it('render the checkpoint interval from CHECKPOINT_INTERVAL', () => {
    expect(proofPendingLine()).toBe(`Proof pending — checkpoints are cut every ${blocksApprox(CONSTANTS.CHECKPOINT_INTERVAL)}. The name works now.`)
  })
})
