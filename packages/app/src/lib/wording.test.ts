/**
 * The wording rules of docs/app-states.md §5 are decided, not stylistic —
 * these tests pin the ones a later edit would most plausibly break.
 */
import { CONSTANTS } from '@nimiqnames/core'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { blocksApprox } from './format'
import {
  ACTION_LABEL,
  cancelHint,
  cancelLabel,
  cancelTitle,
  offerStaysLine,
  sheetActionLabel,
  sheetDismissLabel,
  buyerRebateLine,
  referredByLine,
  bidCustodialHint,
  bidCustodialWarning,
  buyAcknowledgeLabel,
  custodialHint,
  insufficientBalanceLine,
  custodialWarning,
  marketCustodialHint,
  marketCustodialLine,
  ownerShareLine,
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
  isCompressedEra,
  eraNoticeLine,
  eraNoticeHint,
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
    expect(resolverIdentityLine(LABS)).toBe('Example Labs · https://api.example.com')
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
  // The review is the **buyer's** screen. What the referrer earns changes
  // nothing they decide, so it is not on it (Kike, 2026-09-12: "no point into
  // showing an user that is going to pay the same how much is going to
  // receive the referrer"). Naming the referrer stays — a field travelling
  // with their registration that they cannot see is one they cannot correct.
  it('the review names the referrer and never what the referrer earns', () => {
    const line = referredByLine('ricomav', '5%', true)
    expect(line).toContain('ricomav')
    expect(line).toContain('5%')
    expect(line).toMatch(/comes back to you/)
    expect(line).not.toMatch(/its owner earns/i)
    expect(line).not.toMatch(/discount|cheaper|less/i)
    // One rate on the line, so one percentage on the line.
    expect(line.match(/%/g)).toHaveLength(1)
  })

  it('with no rebate the review is the line it was before the rebate existed', () => {
    const line = referredByLine('ricomav')
    expect(line).toContain('ricomav')
    expect(line).toContain('You pay the same')
    expect(line).not.toMatch(/%/)
  })

  it('the strip’s rebate line says back, not off', () => {
    const line = buyerRebateLine('5%')
    expect(line).toContain('5%')
    expect(line).toMatch(/back/)
    expect(line).not.toMatch(/discount|off the price/i)
  })

  it('the owner’s hint mentions the rebate only when there is one', () => {
    expect(shareHint('4%', '4%')).toMatch(/gets 4% of it back/)
    expect(shareHint('10%')).not.toMatch(/back/)
    expect(shareHint('10%')).toContain('pays the same price')
  })

  // Kike publishes 5% and the payer sends 4%. The screens say 5% and name the
  // burn once, beside the number (Kike, 2026-09-12: "5% (minus burn fee) or
  // something like that").
  describe('the burn beside the rate', () => {
    it('the review and the strip each name it once', () => {
      const review = referredByLine('ricomav', '5%', true)
      expect(review).toMatch(/5% \(minus the registry’s burn\)/)
      expect(review.match(/burn/g)).toHaveLength(1)
      const strip = buyerRebateLine('5%', true)
      expect(strip).toMatch(/5% \(minus the registry’s burn\)/)
      expect(strip.match(/burn/g)).toHaveLength(1)
    })

    it('ends in a full stop with the aside and without it', () => {
      expect(shareHint('5%', '5%', true).endsWith('.')).toBe(true)
      expect(shareHint('5%', '5%').endsWith('.')).toBe(true)
      expect(shareHint('5%').endsWith('.')).toBe(true)
    })

    it('a row the burn is not out of gets no aside at all', () => {
      expect(referredByLine('ricomav', '10%')).not.toMatch(/burn/)
      expect(buyerRebateLine('10%')).not.toMatch(/burn/)
      expect(shareHint('10%', '10%')).not.toMatch(/burn/)
    })

    it('the owner’s hint says what the burn takes', () => {
      expect(shareHint('5%', '5%', true)).toMatch(/Both rates are before the registry’s burn, which takes a fifth of each/)
      expect(shareHint('5%', null, true)).toMatch(/That rate is before/)
    })
  })

  it('the owner sees the rate configured for their own name', () => {
    expect(ownerShareLine('5%')).toBe('You get 5%')
    expect(ownerShareLine('20%')).toBe('You get 20%')
  })

  it('the tile never spends alarm vocabulary on a name in grace', () => {
    for (const text of [shareInGraceLine(), shareHint('10%'), referralsCountLine(0, '0')]) {
      expect(text).not.toMatch(/\b(stop|do not pay|divergence|red)\b/i)
    }
  })
})

describe('the two lines a tempo era would otherwise turn into lies', () => {
  it('render the term from TERM_LENGTH, never a typed period', () => {
    expect(termPerk(31_536_000)).toBe('One-year terms')
    expect(termPerk(604_800)).toBe('7-day terms')
    expect(termPerk(3_600)).toBe('60-minute terms')
    expect(termPerk(7_200)).toBe('2-hour terms')
    expect(termPerk()).toBe(termPerk(CONSTANTS.TERM_LENGTH))
  })

  it('render the checkpoint interval from CHECKPOINT_INTERVAL', () => {
    expect(proofPendingLine()).toBe(
      `Proof pending. The name works now. Checkpoints are cut every ${blocksApprox(CONSTANTS.CHECKPOINT_INTERVAL)}.`,
    )
  })
})

describe('the era notice is derived from the term, never a deploy flag', () => {
  it('is absent on mainnet and present on every compressed era', () => {
    expect(isCompressedEra(31_536_000)).toBe(false)
    expect(isCompressedEra(604_800)).toBe(true)
    expect(isCompressedEra(3_600)).toBe(true)
    expect(isCompressedEra()).toBe(isCompressedEra(CONSTANTS.TERM_LENGTH))
  })

  it('says what the names are for, and quotes both clocks in the hint', () => {
    expect(eraNoticeLine()).toBe('Names and prices here are for testing.')
    expect(eraNoticeHint(604_800)).toContain('a term is 7 days instead of a year')
    expect(eraNoticeHint(604_800)).toContain('a lifetime about 2 years')
    expect(eraNoticeHint(3_600)).toContain('a term is 60 minutes instead of a year')
    expect(eraNoticeHint(604_800)).toContain(`instead of ${CONSTANTS.LIFETIME_TERMS} years`)
    expect(eraNoticeHint(604_800)).toContain('starts again at launch')
  })

  it('is neutral tone — a test era is not an alarm', () => {
    for (const text of [eraNoticeLine(), eraNoticeHint(604_800)]) {
      expect(text).not.toMatch(/\b(stop|do not pay|divergence|warning)\b/i)
    }
  })
})

describe('a `K` is named by what it will clear (§6 `K`)', () => {
  const sets = [
    { transfer: true, offer: true },
    { transfer: true, offer: false },
    { transfer: false, offer: true },
    { transfer: false, offer: false },
  ] as const

  it('never says "auction" — the one thing a `K` can never cancel', () => {
    // The bug: a pending transfer's tile read "Cancel Listing / Cancel active
    // auction", and the auction hint could only ever render there, because a
    // real open auction disables the tile and shows its gate reason instead.
    for (const set of sets) {
      expect(cancelTitle(set)).not.toMatch(/auction/i)
      expect(cancelHint(set, { to: 'NQ12 … 9YRA', priceNim: '450' })).not.toMatch(/auction/i)
    }
  })

  it('calls a transfer a transfer, and a listing a listing', () => {
    expect(cancelTitle({ transfer: true, offer: false })).toBe('Cancel Transfer')
    expect(cancelHint({ transfer: true, offer: false }, { to: 'NQ12 … 9YRA', priceNim: null })).toBe('To NQ12 … 9YRA')
    expect(cancelTitle({ transfer: false, offer: true })).toBe('Cancel Listing')
    expect(cancelHint({ transfer: false, offer: true }, { to: null, priceNim: '450' })).toBe('Withdraw the 450 NIM offer')
    // Both, and the empty set an open auction leaves behind: neither is a listing alone.
    expect(cancelTitle({ transfer: true, offer: true })).toBe('Cancel Pending')
    expect(cancelTitle({ transfer: false, offer: false })).toBe('Cancel Pending')
  })

  it('names the sheet with the same words as the tile, and its dismiss with different ones', () => {
    expect(sheetActionLabel('cancel', { transfer: true, offer: false })).toBe(cancelTitle({ transfer: true, offer: false }))
    expect(sheetActionLabel('renew', { transfer: false, offer: false })).toBe(ACTION_LABEL.renew)
    // Two buttons reading "Cancel" and meaning opposite things is what shipped.
    expect(sheetDismissLabel('cancel')).not.toBe(cancelLabel())
    expect(sheetDismissLabel('renew')).toBe(cancelLabel())
  })

  it('says how long an offer the `K` will not touch stays standing', () => {
    expect(offerStaysLine('450', CONSTANTS.OFFER_IRREVOCABLE)).toBe(
      `The 450 NIM listing stays. It can’t be withdrawn for another ${blocksApprox(CONSTANTS.OFFER_IRREVOCABLE)}.`,
    )
  })
})

/**
 * Kike, 2026-09-14, forwarding a Nimiq team member on the balance block:
 * *"This text is so obviously Claude speak"* — *"please stop using the '-' to
 * split sentences. I prefer a dot or brackets (only when needed)."*
 *
 * Read off the source rather than by calling every export, because the rule is
 * about the strings themselves and a function's arguments are not the point.
 * Comments keep their dashes: they are read by whoever edits this file, not by
 * anyone using the app.
 */
describe('no em dash splits a sentence a user reads', () => {
  // Every string literal in the source, comments excluded, found by walking
  // the characters rather than the lines: the first version read `wording.ts`
  // line by line and so covered neither a trailing `// comment` nor the
  // review lines in `actions.ts`, which is where Kike found three of them on
  // one sheet (2026-09-15). What a user reads is a string, so strings are what
  // this reads.
  const stringsIn = (source: string): readonly string[] => {
    const out: string[] = []
    let i = 0
    let current: { quote: string; text: string } | null = null
    while (i < source.length) {
      const char = source[i]!
      if (current !== null) {
        if (char === '\\') {
          current.text += source.slice(i, i + 2)
          i += 2
          continue
        }
        if (char === current.quote) {
          out.push(current.text)
          current = null
        } else current.text += char
        i += 1
        continue
      }
      if (char === '/' && source[i + 1] === '/') {
        i = source.indexOf('\n', i)
        if (i === -1) break
        continue
      }
      if (char === '/' && source[i + 1] === '*') {
        const close = source.indexOf('*/', i + 2)
        i = close === -1 ? source.length : close + 2
        continue
      }
      if (char === "'" || char === '"' || char === '`') {
        current = { quote: char, text: '' }
      }
      i += 1
    }
    return out
  }

  const FILES = ['./wording.ts', './actions.ts', './states.ts']

  it.each(FILES)('holds for every string in %s', (file) => {
    const strings = stringsIn(readFileSync(new URL(file, import.meta.url), 'utf8'))
    expect(strings.filter((text) => text.includes('—'))).toEqual([])
  })

  it('reads strings and not comments', () => {
    expect(stringsIn(`const a = 'kept' // a — comment\nconst b = \`also — kept\``)).toEqual(['kept', 'also — kept'])
  })
})

describe('the balance block (the line a Nimiq reviewer quoted)', () => {
  it('is the two numbers and nothing else', () => {
    expect(insufficientBalanceLine('400', '0')).toBe('Needs 400 NIM. Your wallet holds 0 NIM.')
  })

  it('never describes sending, because the sheet has already disabled it', () => {
    const line = insufficientBalanceLine('400', '0').toLowerCase()
    expect(line).not.toMatch(/send|top it up|would/)
  })
})

describe('the custodial disclosure keeps §8.5 #10 on the card', () => {
  // The spec wants two things before a `B`: *show* that settlement is
  // custodial, and require explicit confirmation. The visible line and the
  // checkbox label are those two; the hint carries only when a refund arises.
  it('the visible line names custody and the operator, in one short sentence', () => {
    for (const line of [custodialWarning(), bidCustodialWarning(), marketCustodialLine()]) {
      expect(line).toMatch(/marketplace operator holds/)
      expect(line.split(' ').length).toBeLessThan(14)
    }
  })

  it('the checkbox still says whose money would come back', () => {
    expect(buyAcknowledgeLabel()).toMatch(/refund would come from the marketplace operator/)
  })

  it('the hint carries the circumstances the line no longer states', () => {
    expect(custodialHint()).toMatch(/loses a race or hits a cancelled offer/)
    expect(bidCustodialHint()).toMatch(/higher bid lands/)
    for (const hint of [custodialHint(), bidCustodialHint(), marketCustodialHint()]) {
      expect(hint).toMatch(/a promise, not a protocol rule/)
    }
  })

  // The Market list holds auctions as well as offers, so its one disclosure
  // cannot be the buy variant — which is what it had been showing.
  it('the Market line covers bids as well as payments', () => {
    expect(marketCustodialLine()).toMatch(/payments and bids/)
  })
})
