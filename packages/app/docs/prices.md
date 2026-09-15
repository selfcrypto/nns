# Prices, terms and expiry

## Price follows length

One base price, {{nim:FEE_BASE}} a year, buys a name of {{n:LONG_BAND_FROM}} characters or more. Shorter names cost a fixed multiple of it.

| Name length | A year | A lifetime |
|---|---|---|
| 1–4 characters | Reserved. Released by award or auction, then {{fee:4}} to {{fee:1}} a year | none |
| 5 characters | {{fee:5}} | {{lifetime:5}} |
| 6 characters | {{fee:6}} | {{lifetime:6}} |
| 7–11 characters | {{fee:7}} | {{lifetime:7}} |
| 12 characters and up | {{fee:12}} | {{lifetime:12}} |

Nothing is free, because a free name would let anyone inflate the public record until nobody can replay it. Renewal costs the same as registration for that length, at the price in effect when the renewal lands.

## A year or a lifetime

Every registration and renewal offers two terms. **A year** is one term. **A lifetime** is {{n:LIFETIME_TERMS}} years for the price of {{n:LIFETIME_MULTIPLIER}}, and the app shows it as the date it reaches. A lifetime name can still be renewed, transferred and sold.

## Pay exactly the price

The app always sends the exact fee. If you build a transaction yourself:

- **Pay less** and the registration does not happen. The money is refunded in full.
- **Pay more** and the registration succeeds. The surplus is refunded.
- **Someone else registered the name a moment before you** and your payment is refunded in full.

An amount below {{nim:REFUND_FLOOR}} is kept rather than refunded. The full list of what is refunded and what is not: [Refused transactions](fails).

## The term

A registration lasts **{{dur:TERM_LENGTH}}** from the block it lands in. Renewing extends it **from the current expiry**, so renewing early never costs you time.

**Anyone can renew any name.** A renewal is a payment naming the name. Ownership does not change.

The app reminds you from **60 days** before expiry, on every screen that shows the name.

## Expiry and grace

```
registered ──── {{dur:TERM_LENGTH}} ────▶ expiry ──── {{dur:GRACE_PERIOD}} ────▶ available again
             resolves, fully yours         GRACE: renewable,
                                           not resolving,
                                           not registrable
```

- **Until expiry** the name resolves and every owner action works.
- **From expiry, for {{dur:GRACE_PERIOD}}, the name is in grace.** It does not resolve, so payments to it find no address and its subdomains stop answering. Nobody can register it, and a renewal by anyone brings it back with its records intact. The app says "Expired and not available. The owner can renew until ≈ date."
- **After grace** the name is available to anyone, and the old record is gone.

Entering grace cancels an open sale, a pending transfer and a running auction, refunds a standing bid, and clears the subdomain host. The target address and the linked EVM address stay, so a renewal restores the name as it was, minus the host.

## Where the money goes

All fees go to the registry's treasury address.

- **{{pct:BURN_SHARE_BP}} of registry revenue is burned**, sent to Nimiq's burn address, {{addr:BURN_ADDRESS}}, whose key nobody has. Revenue is counted from the public log, so anyone can compute what is owed. The app shows *burned so far*, *owed so far* and the gap between them. This share is fixed by the protocol.
- **Marketplace sales pay a commission** of {{pct:COMMISSION_RATE}}, deducted from the seller's proceeds. Putting a name up for sale is free.
- **Auctions of reserved names** pay their proceeds to the treasury.

## Governance

A fee fixed in NIM drifts with the NIM price, so the administrator can change the base price and the commission rate. Every length moves with the base. The change is itself a transaction on chain, with limits every indexer enforces.

| What | Limit |
|---|---|
| The base price | Between {{nim:PRICE_FLOOR}} and {{nim:PRICE_CEILING}} |
| Commission | At most {{pct:COMMISSION_CEILING}}, moving by at most {{pct:COMMISSION_MAX_STEP}} per change |
| Notice | Takes effect no sooner than {{dur:GOVERNANCE_DELAY}} after it lands |

The app shows a scheduled change on every price it displays ("Fees change ≈ date"). A registration is judged against the price in effect at its own block, so a change never invalidates anything already sent.
