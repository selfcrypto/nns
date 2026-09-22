/**
 * The wording rules of docs/app-states.md §5 are decided, not stylistic —
 * these tests pin the ones a later edit would most plausibly break.
 */
import { CONSTANTS } from '@nimiqnames/core'
import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { blocksApprox } from './format'
import {
  PRICE_UNCHANGED,
  ACTION_LABEL,
  cancelHint,
  cancelLabel,
  buyNowLabel,
  cancelTitle,
  OWNER_TILE_REPLACING,
  forSaleLabel,
  liveAuctionLabel,
  MARKET_FILTER,
  placeBidLabel,
  GATE_REASON_TEXT,
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
  resolverLatency,
  resolverParty,
  resolverUrlShown,
  shortNameNoteLine,
  STATUS_TAG,
  termPerk,
  isCompressedEra,
  blocksToLaunch,
  launchNoticeHint,
  launchNoticeLine,
  eraNoticeLine,
  eraNoticeHint,
  verifiedByLine,
  CHAT_ENCODE_TEXT,
  PAY_MESSAGE_FAULT_TEXT,
  offerHint,
  overBudgetLine,
  sendConfirmingLine,
  sendSettlingLine,
} from './wording'

const LABS = { name: 'Example Labs', url: 'https://api.example.com', ms: 120 }
const OURS = { name: 'Ours', url: 'https://nns.ours.example', ms: 88 }

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
  // 2026-08-28). The party is the name; the URL is the half a user can check,
  // and since 2026-09-15 the row is one line rather than both said twice.
  it('names a party whose URL does not already name it', () => {
    expect(resolverParty(LABS)).toEqual({ primary: 'Example Labs', secondary: 'https://api.example.com' })
  })

  it('drops the name when the URL carries it, rather than saying it twice', () => {
    expect(resolverParty({ name: 'nimiqnames.com', url: 'https://api.nimiqnames.com' })).toEqual({
      primary: 'https://api.nimiqnames.com',
      secondary: null,
    })
    expect(resolverParty({ name: 'nns.sonartech.pro', url: 'https://nns.sonartech.pro' })).toEqual({
      primary: 'https://nns.sonartech.pro',
      secondary: null,
    })
  })

  it('resolves a same-origin endpoint before deciding, so /api is never the whole line', () => {
    const party = resolverParty({ name: 'nimiqnames.com', url: '/api' }, 'https://nimiqnames.com/')
    expect(party).toEqual({ primary: 'https://nimiqnames.com/api', secondary: null })
  })

  it('states the round trip as whole milliseconds and nothing else', () => {
    expect(resolverLatency(123.4)).toBe('123 ms')
    expect(resolverLatency(0)).toBe('0 ms')
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
    expect(line).toContain('on chain')
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
    expect(line).toContain(PRICE_UNCHANGED)
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
  const sets = ['transfer', 'sale', null] as const

  it('never says "auction" — the one thing a `K` can never cancel', () => {
    // The bug: a pending transfer's tile read "Cancel Listing / Cancel active
    // auction", and the auction hint could only ever render there, because a
    // real open auction disables the tile and shows its gate reason instead.
    for (const set of sets) {
      expect(cancelTitle(set)).not.toMatch(/auction/i)
      expect(cancelHint(set, { to: 'NQ12 … 9YRA', priceNim: '450' })).not.toMatch(/auction/i)
    }
  })

  it('calls a transfer a transfer, and a sale a sale', () => {
    expect(cancelTitle('transfer')).toBe('Cancel Transfer')
    expect(cancelHint('transfer', { to: 'NQ12 … 9YRA', priceNim: null })).toBe('To NQ12 … 9YRA')
    expect(cancelTitle('sale')).toBe('Cancel Sale')
    expect(cancelHint('sale', { to: null, priceNim: '450' })).toBe('Take it off sale (450 NIM)')
    // Nothing pending — an open auction leaves the tile disabled with its gate reason — is not a listing.
    expect(cancelTitle(null)).toBe('Cancel Pending')
    expect(cancelHint(null, { to: null, priceNim: null })).toBe('Nothing to cancel')
  })

  it('a listing names its kind and its action with different words', () => {
    // One card carries both. They were both "Buy Now", so an offer card said
    // it twice while the auction card beside it read Live Auction / Place Bid.
    expect(forSaleLabel()).not.toBe(buyNowLabel())
    expect(liveAuctionLabel()).not.toBe(placeBidLabel())
    // The filter tab names the kind it filters to, not the action it leads to.
    expect(MARKET_FILTER.offers).toBe(forSaleLabel())
  })

  it('names the sheet with the same words as the tile, and its dismiss with different ones', () => {
    expect(sheetActionLabel('cancel', 'transfer')).toBe(cancelTitle('transfer'))
    expect(sheetActionLabel('cancel', 'sale')).toBe('Cancel Sale')
    expect(sheetActionLabel('renew', null)).toBe(ACTION_LABEL.renew)
    // The same kind replaces (§7.3): the sheet says so, and only for its own kind.
    expect(sheetActionLabel('transfer', 'transfer')).toBe(OWNER_TILE_REPLACING.transfer)
    expect(sheetActionLabel('offer', 'sale')).toBe(OWNER_TILE_REPLACING.offer)
    expect(sheetActionLabel('transfer', 'sale')).toBe(ACTION_LABEL.transfer)
    expect(sheetActionLabel('offer', null)).toBe(ACTION_LABEL.offer)
    // Two buttons reading "Cancel" and meaning opposite things is what shipped.
    expect(sheetDismissLabel('cancel')).not.toBe(cancelLabel())
    expect(sheetDismissLabel('renew')).toBe(cancelLabel())
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

  // Every source file in the app, not a list of three. The list was the bug:
  // `lib/evm.ts` shipped *"Amount is typed without thousands separators —
  // 12345, not 12,345"* to users for as long as the sweep has existed, because
  // it was never one of the three files named here (2026-09-15). A string a
  // user reads is a string anywhere, so the sweep walks the tree.
  const SOURCES = globSync('**/*.{ts,tsx}', { cwd: new URL('..', import.meta.url) })
    .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
    .sort()

  it('covers the whole app, not a hand-kept list', () => {
    expect(SOURCES.length).toBeGreaterThan(20)
    expect(SOURCES).toContain('lib/evm.ts')
  })

  // The rule is that no em dash **splits a sentence**, not that the character
  // is banned: `lib/chrome.ts` uses a bare "—" as the "no value" cell in a
  // diagnostics readout, which is what an em dash is actually for. So the
  // interpolations come out first, and what is left has to read as prose
  // before it is judged.
  const prose = (text: string): boolean => (text.match(/\$\{[^}]*\}/g) === null ? text : text.replace(/\$\{[^}]*\}/g, ' ')).match(/\p{L}/gu) !== null
    && (text.replace(/\$\{[^}]*\}/g, ' ').match(/\p{L}/gu) ?? []).length >= 3

  it.each(SOURCES)('holds for every string in %s', (file) => {
    const strings = stringsIn(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
    expect(strings.filter((text) => text.includes('—') && prose(text))).toEqual([])
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
    expect(custodialHint()).toMatch(/loses a race or hits a cancelled sale/)
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

/**
 * Two defect classes Kike found on the live site rather than a test finding
 * them (2026-09-15), pinned so they cannot come back a third time.
 */
describe('a duration in a string is read from its constant', () => {
  // `offerHint` promised "~15 days" — `OFFER_MAX_LIFETIME` at its mainnet
  // value — on a site where it is 86,400 blocks. The assertion is the
  // constant's rendering, never a spelling, or it is the same bug written twice.
  it('the offer lifetime comes from OFFER_MAX_LIFETIME', () => {
    const line = offerHint()
    expect(line).toContain(blocksApprox(CONSTANTS.OFFER_MAX_LIFETIME))
  })

  it('a message budget comes from MAX_DATA_BYTES, and one sentence serves both surfaces', () => {
    expect(overBudgetLine()).toContain(String(CONSTANTS.MAX_DATA_BYTES))
    expect(PAY_MESSAGE_FAULT_TEXT.OVER_BUDGET).toBe(overBudgetLine())
    expect(CHAT_ENCODE_TEXT.OVER_BUDGET).toBe(overBudgetLine())
  })
})

/**
 * Every wait in the app ends in the same place, because the indexer scans by
 * batch. Quoting a different estimate on one card is the app disagreeing with
 * itself: there were three — "(~1 min)", "within a minute or two" and "a few
 * seconds" — and fixing the first two left the propagation card behind.
 */
describe('one clock', () => {
  it('every waiting line names the next macro block and the same estimate', () => {
    for (const line of [sendConfirmingLine(), sendSettlingLine(), propagatingLine()]) {
      expect(line).toContain('the next macro block')
      expect(line).toContain('(<1 min)')
    }
  })
})

/** Hyphenated before a noun, open after a verb. Four strings had it backwards. */
describe('on chain / on-chain', () => {
  it('never hyphenates after a verb or a comma', () => {
    const source = readFileSync(new URL('./wording.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(source.match(/(?:are|is|be|them|it|they|,)\s+on-chain/g) ?? []).toEqual([])
  })
})

describe('the pre-launch strip', () => {
  it('counts blocks down to LAUNCH_HEIGHT and stops at zero, so the strip removes itself', () => {
    expect(blocksToLaunch(100, 160)).toBe(60)
    expect(blocksToLaunch(160, 160)).toBe(0)
    expect(blocksToLaunch(500, 160)).toBe(0)
  })

  it('derives the moment from the height at a block a second, never from a typed time', () => {
    const now = Date.UTC(2026, 8, 22, 10, 0, 0)
    const twoHours = launchNoticeLine(7_200, now)
    const at = new Date(now + 7_200_000)
    expect(twoHours).toContain(at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }))
    expect(twoHours).toContain(at.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))
  })

  it('says why an early registration is lost, with the height it waits for', () => {
    expect(launchNoticeHint(62_275_680)).toContain('62,275,680')
    expect(launchNoticeHint()).toMatch(/registers nothing/)
  })
})
