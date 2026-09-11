# Prices, terms and expiry

A price that follows length, a one-year term or a lifetime, a grace period, and a public record of where the money goes.

## Price follows length

One base price, {{nim:FEE_BASE}} a year, buys a name of {{n:LONG_BAND_FROM}} characters or more. Shorter names cost a fixed multiple of it — the multiples never change; the base can, by governance, with notice.

| Name length | A year | A lifetime | Why |
|---|---|---|---|
| 1–4 characters | Reserved — released by award or auction; then {{fee:4}} to {{fee:1}} a year | — | Too valuable to sell first come, first served |
| 5 characters | {{fee:5}} | {{lifetime:5}} | Scarce |
| 6 characters | {{fee:6}} | {{lifetime:6}} | |
| 7–11 characters | {{fee:7}} | {{lifetime:7}} | The desirable range |
| 12 characters and up | {{fee:12}} | {{lifetime:12}} | Nearly free to a person, still a floor against spam |

**Why nothing is free.** Nimiq transactions cost almost nothing, so free registration would let an attacker inflate the public record until nobody can replay it. Being able to replay that record on a laptop in seconds is what makes NNS checkable ([How you know the answer is right](trust)). A price on every length keeps it small. Price, not length, is the lever: an attacker who found long names free would simply use longer names.

Renewal costs the same as registration for that length, at the price in effect when the renewal lands.

## A year or a lifetime

Every registration and renewal offers two terms. **A year** is one term. **A lifetime** is {{n:LIFETIME_TERMS}} terms bought at once for the price of {{n:LIFETIME_MULTIPLIER}}, and it is exactly that: an expiry {{n:LIFETIME_TERMS}} years out, which the app shows as the date it is. Nothing else about the name changes — it can be renewed again, transferred, sold. The word "lifetime" is the label on the choice, not a promise the registry makes about you.

## Pay exactly the price

The app always sends the exact fee, so this only matters if you build a transaction yourself:

- **Pay less** and the registration does not happen and the money is **refunded** in full. The treasury keeps nothing it did not earn — and a price change can take effect while your transaction is still on its way, which is not your mistake.
- **Pay more** and the registration succeeds and the surplus is **refunded**, for the same reason: the treasury keeps nothing it did not earn, and a price cut can land while your transaction is on its way.
- **Someone else registered the name a moment before you** and your payment is **refunded** in full. That loss was caused by the race, not by you.

One floor applies to every refund: an amount below {{nim:REFUND_FLOOR}} is kept, which stops anyone turning thousands of tiny failed messages into thousands of refund transactions. Nothing an honest client sends is that small.

The full list of what is refunded and what is not: [When a transaction is refused](fails).

## The term

A registration lasts **{{dur:TERM_LENGTH}}** from the block it lands in — or {{n:LIFETIME_TERMS}} of them, for a lifetime. Renewing extends it by another term, or a lifetime, **from the current expiry**, not from today, so renewing early never costs you time.

**Anyone can renew any name.** A renewal is a payment to the treasury naming the name; it needs no signature from the owner. Ownership does not change.

The app reminds you from **60 days** before expiry (twice the grace period), prominently, on every screen that shows the name. Silent expiry is the most common failure in naming systems, and a year is long enough to forget.

Why one year rather than five or forever: expiry, grace and re-registration are rules that only real traffic tests, and a five-year term would leave them untested until long after the design is frozen. A renewable term can always be made effectively permanent later by pricing renewal near zero; a permanent name can never be given an expiry.

## Expiry and grace

```
registered ──── {{dur:TERM_LENGTH}} ────▶ expiry ──── {{dur:GRACE_PERIOD}} ────▶ available again
             resolves, fully yours         GRACE: renewable,
                                           not resolving,
                                           not registrable
```

- **Until expiry** the name resolves and every owner action works. The last block it resolves is the one before the expiry block.
- **From expiry, for {{dur:GRACE_PERIOD}}, the name is in grace.** It does not resolve, so payments to it will not find an address and its subdomains stop answering. It is **not free**: nobody can register it, and a renewal — by anyone — brings it back with its address and records intact. The app says "Expired — in grace until ≈ date. Still its owner's to renew; not available."
- **After grace** the name is available to anyone, and the old record is gone entirely.

**Entering grace cancels what was pending.** An open offer, a pending transfer and a running auction are all cancelled, a standing bid is refunded, and the subdomain host is cleared. The target address and the linked EVM address stay with the record, so a renewal restores the name exactly as it was, minus the subdomain host, which the owner sets again.

## Where the money goes

All fees go to the registry's treasury address. Three rules govern what happens next:

- **{{pct:BURN_SHARE_BP}} of registry revenue is committed to be burned** — sent to Nimiq's burn address, {{addr:BURN_ADDRESS}}, whose key nobody has. What counts as revenue is defined over the public log, not the treasury's balance: accepted registrations, renewals and marketplace commission. Anyone can compute what is owed from the log alone, and the app shows *burned so far*, *owed so far* and the gap between them. The commitment is a policy, not a contract, but a policy whose breach is permanently visible.
- **Marketplace sales pay a commission** of {{pct:COMMISSION_RATE}}, deducted from the seller's proceeds at settlement. Listing a name costs nothing beyond the network fee.
- **Auctions of reserved names** pay their proceeds to the treasury.

The burn share is fixed by the protocol; no governance message can change it.

## Governance

A fee fixed in NIM drifts with the NIM price, so the two registration prices and the commission rate can be changed by the administrator. The change is itself a transaction on chain, and every independent indexer enforces the same limits:

| What | Limit |
|---|---|
| The base price | Between {{nim:PRICE_FLOOR}} and {{nim:PRICE_CEILING}}; the multiples are fixed |
| Ordering | The long-name price can never exceed the standard price |
| Commission | At most {{pct:COMMISSION_CEILING}}, moving by at most {{pct:COMMISSION_MAX_STEP}} per change |
| Notice | Takes effect no sooner than {{dur:GOVERNANCE_DELAY}} after it lands |

The notice period is the protection. A change is a public fact on chain for a day before it does anything, and the app shows a scheduled change on every price it displays ("Fees change ≈ date"). Registrations are judged against the price in effect at their own block, so a change never invalidates anything already sent. There is deliberately no rate limit: one loose enough to allow honest repricing is one an attacker walks through a step at a time, so the honest defence is the notice and, in the worst case, a coordinated revision that ignores a stolen key.
