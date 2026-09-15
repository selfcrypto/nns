# Market

Every name for sale and every running auction, in one list. Filter by name, or by *Buy Now* and *Auctions*. Each listing shows the name, the price or the standing bid, the seller, and when it ends. Tapping one opens the name's proof above the form: its address, verification line and pin check, so nobody pays for a name they have not seen verified.

## Buying at a fixed price

You pay exactly the price to the marketplace address, and the name is yours the moment that payment is final. Ownership never waits for anyone. The seller is paid by the settlement service, minus commission, in a separate transaction.

## Bidding

The first bid must meet the starting price. Each later bid must beat the standing bid by at least {{pct:AUCTION_MIN_INCREMENT_BP}}, and the app shows the minimum next bid and refuses less. When a higher bid lands, the outbid bidder is refunded at once, so the marketplace holds one bid per auction, never a pile. A bid in the last {{dur:AUCTION_EXTENSION}} extends the end by that much. At the end, the standing bid wins and the name transfers.

## What the operator holds

Between your payment and its settlement, the marketplace operator holds the money. A purchase that loses a race or hits a cancelled sale is refunded by the operator. A bid is held by the operator for the whole window and refunded if outbid. What is owed and what has been paid are both computable from the public log, so a shortfall cannot be hidden. It is still a promise, not a protocol rule.

The app asks you to acknowledge this before every purchase and every bid: "I understand a refund would come from the marketplace operator."

## The fee burn

The Market also carries the **fee burn** figures: burned so far, owed so far, and whether the operator is behind, ahead or even, computed from the public log ([Prices](prices)).

## Selling

Putting a name up for sale, or up for auction, is done from the name's card in My Names ([My Names](my-names)).
