import { useEffect, useState } from 'react'

import { clearReferral, onReferralChange, storedReferral } from '../lib/referral'
import { percentOf, rateIsNetOfBurn, rebateHeadlineBp } from '../lib/referralRates'
import { buyerRebateLine, REFERRER_STRIP } from '../lib/wording'

/**
 * The referrer the app is holding (§10.7), shown where the registration is
 * about to start: the landing page and Buy.
 *
 * A `ref` travels with the next `G` and pays a stranger a share of the fee.
 * Until this strip existed the only sight of it was one line on the review
 * sheet, three screens later — so a user who followed someone's link had no
 * way to know the link had been read, and a user who did not want to credit
 * anybody had no way to say so. The **remove** control is the second half and
 * the reason the strip is not a toast: a notice that disappears cannot be
 * acted on.
 *
 * It is a strip and not a card because it is not an answer — nothing here was
 * looked up. It draws nothing when the slot is empty.
 */

/** The stored ref, kept in step with the slot — a paste, a page load and the remove control all write it. */
export function useStoredReferral(): string | null {
  const [ref, setRef] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const read = () => {
      void storedReferral().then((value) => {
        if (alive) setRef(value)
      })
    }
    read()
    const stop = onReferralChange(read)
    return () => {
      alive = false
      stop()
    }
  }, [])
  return ref
}

export function ReferrerStrip({ className }: { className?: string | undefined }) {
  const ref = useStoredReferral()
  if (ref === null) return null

  // The rebate that will be in effect when the `G` lands, which is the last
  // row for this referrer — the same reading the docs page takes. Nothing
  // here knows a height, and a payout is priced at the registration, not now.
  // The **headline** of that row, not its `bp`: the programme published 5%,
  // and the row holds it net of the burn (`referralRates.ts`).
  //
  // Only the rebate. What the referrer earns is not shown to the person
  // registering — it changes nothing they decide (`wording.ts`).
  const rebateBp = rebateHeadlineBp(ref, Number.MAX_SAFE_INTEGER) ?? 0
  const net = rateIsNetOfBurn(ref, Number.MAX_SAFE_INTEGER)
  const note = rebateBp > 0 ? buyerRebateLine(percentOf(rebateBp), net) : `${REFERRER_STRIP.note}.`

  return (
    <div className={className === undefined ? 'referrer-strip' : `referrer-strip ${className}`}>
      <svg className="referrer-strip-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
      <span className="referrer-strip-text">
        <span className="referrer-strip-label">{REFERRER_STRIP.label}</span>{' '}
        <span className="nns-name referrer-strip-name">{ref}</span>
        <span className="referrer-strip-note">
          {note}
        </span>
      </span>
      <button type="button" className="referrer-strip-remove" onClick={() => void clearReferral()} aria-label={REFERRER_STRIP.removeLabel}>
        {REFERRER_STRIP.remove}
      </button>
    </div>
  )
}
