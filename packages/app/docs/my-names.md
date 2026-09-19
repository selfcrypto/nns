# My Names

The names of the address in the top corner, soonest expiry first. Switch address there to see another's. The status tag says until when, and from {{dur:RENEW_WINDOW}} before expiry it reads "Renew before ≈ date". Tap a name to open it.

The card shows where the name points, its expiry, anything pending, and the owner's actions as tiles. A tile that is not possible right now stays visible and says why ("Locked while the auction runs.", "In grace. Only renewal works until it ends."). Every tile opens a sheet that shows the current value, takes your input, and says what will change before the wallet opens.

## Routing & Records

- **Target Address.** Where the name pays. Changing it does not change ownership, so this is the action for moving to a new wallet. The field takes an address or a name, and **Point back at my address** is a checkbox.
- **EVM Resolution.** Link one `0x…` address. One address covers every EVM chain. The app can fill it from a connected EVM wallet, or you paste it. **Remove the linked address** is a checkbox.
- **Subdomain Host.** The hostname of a server you run that answers for `anything.yourname`. Name and host together are limited to 52 characters, and the host must already answer over HTTPS. **Remove the current host** switches subdomains off ([Subdomains](subdomains)).

## Ownership & Renewal

- **Renew Registration.** Extends the expiry by {{dur:TERM_LENGTH}}, or by a lifetime, from the current expiry, at the current price. The review shows the new expiry as a date.
- **Transfer Ownership.** Type the new owner's address or name. The transfer completes after **{{dur:XFER_TIMELOCK}}**. Until then you keep full control and **Cancel Transfer** undoes it, with the time left on the tile. While it is pending the tile reads **Change Recipient**: a new transfer replaces the old one and the clock restarts. Check the recipient in the wallet's sheet: the delay guards a mistyped address, not a stolen key. On completion the name points at the new owner, and the linked EVM address and the host are cleared.
- **Cancel Transfer / Cancel Sale.** Undoes the one thing pending on the name, a transfer or a sale, at any time. The tile is named after what it would clear. An auction cannot be cancelled.

## Marketplace

- **Sell (Fixed Price).** Puts the name up for sale at a price you set, no lower than the base registration price (today {{nim:FEE_BASE}}). Listing is free. While it is listed the tile reads **Change Price**. You can change the price or take it off sale at any time, and it expires by itself after {{dur:OFFER_MAX_LIFETIME}}. You receive the price minus {{pct:COMMISSION_RATE}} commission.
- **Start Auction.** Sets a starting price (same floor) and a duration of at least {{dur:AUCTION_MIN_DURATION}}. The auction must end before the name expires, so renew first if it would not. It cannot start while a transfer or a sale is pending: cancel that first. While it runs, nothing on the name can be changed and no bid can be withdrawn. A bid in the last {{dur:AUCTION_EXTENSION}} extends the end by that much. At the end, the highest bid wins and you receive it minus commission. With no bid, the name stays yours.

A name has at most one pending thing: a transfer, a sale or an auction. Starting a different one means cancelling the first. Entering grace cancels both and refunds any bid ([Prices](prices)).

## Payment Links

- **Request Payment.** Builds a link that opens Pay on your name with the amount and a reference filled in, and copies it ([Pay](pay)). Nothing is sent or signed. The USDT tab needs a linked EVM address. Disabled in grace, because a name in grace does not resolve.

## Referrals

- **Share Link.** Copies `nimiqnames.com/?ref=<your name>`, and shows how many registrations it has brought in and roughly what they earned. Disabled in grace ([Referrals](referrals)).
