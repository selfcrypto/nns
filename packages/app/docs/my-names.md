# My Names

Your names, soonest expiry first. The status tag says until when, and from 60 days before expiry it reads "Renew before ≈ date" in the grace colour. Tap a name to open it in place.

The card shows the current target, the expiry, any pending item, and the owner's actions as tiles in five groups. A tile that is not possible right now stays visible and says why ("Locked while the auction runs.", "In grace. Only renewal works until it ends."). Every tile opens a sheet that shows the current value, takes your input, and says what will change before the wallet opens. The rules behind the review sit behind its blue **(i)**.

## Routing & Records

- **Target Address.** Where the name pays. Changing it does not change ownership. This is the right action when you have moved to a new wallet: point the name at the new address and keep the owner key that controls it. The field takes an address or a name, and **Point back at my address** is a checkbox.
- **EVM Resolution.** Link one EVM address (`0x…`, checksum-verified when mixed-case). One address covers every EVM chain, because wallets derive the same address on all of them. The app can fill it from a connected EVM wallet, or you paste it. The registry records what you declare. Control of that address is shown on the EVM side by using it. **Remove the linked address** is a checkbox, and a wrong address is fixed by sending another.
- **Subdomain Host.** The hostname of a server you run that answers for `anything.yourname`. Name and host together are limited to 52 characters, and the host must already answer over HTTPS before you set it. **Remove the current host** switches subdomains off ([Subdomains](subdomains)).

## Ownership & Renewal

- **Renew Registration.** Extends the expiry by {{dur:TERM_LENGTH}}, or by a lifetime of {{n:LIFETIME_TERMS}} terms for the price of {{n:LIFETIME_MULTIPLIER}}, from the current expiry, at the current price. The sheet offers the two terms side by side with their prices, and the review shows the new expiry as a date. Renewing early never costs you time.
- **Transfer Ownership.** Names the new owner, **by address or by name**: type a name and the field resolves it and fills itself with the address that came back, which is the address the registry will record. The transfer takes effect after **{{dur:XFER_TIMELOCK}}**. Until then you keep full control, the name resolves as before, and **Cancel Transfer** undoes it, with the time left shown on the tile. A second transfer replaces the first and restarts the clock. The wallet's sheet shows the recipient's address and identicon, so check it there. When the transfer completes, the new owner gets the name pointing at themselves, the linked EVM address and the subdomain host are cleared, and any open sale is cancelled. **The waiting period is for a mistyped address, not a stolen key.** Someone holding your key does not need a transfer at all.
- **Cancel Transfer / Cancel Sale / Cancel Pending.** One cancel undoes what is currently cancellable on the name: a pending transfer, and a sale that is past its irrevocable window. The tile is named after what it would clear and sits beside it. The sheet lists what will go, and says when a sale is still inside its irrevocable window, because that sale stays. An auction cannot be cancelled: bidders have committed money against a window they were told in advance.

## Marketplace

- **Sell (Fixed Price).** Puts the name up for sale at a price you set, no lower than the base registration price in effect (today {{nim:FEE_BASE}}). Listing is free. The sale is **irrevocable for {{dur:OFFER_IRREVOCABLE}}**, cancellable after that, and expires by itself after {{dur:OFFER_MAX_LIFETIME}}. On sale you receive the price minus {{pct:COMMISSION_RATE}} commission. The sheet says all of this before you sign.
- **Start Auction.** Sets a starting price (the same floor as a sale) and a duration of at least {{dur:AUCTION_MIN_DURATION}}. The end must fall before the name's expiry, because an auction sells the current term. The sheet says so and suggests renewing first. Opening an auction voids your own pending transfer and open sale. While it runs, the name cannot be sold, transferred or auctioned again, and neither the auction nor a bid can be withdrawn. A bid in the last {{dur:AUCTION_EXTENSION}} extends the end by that much, so a last-second bid never wins by surprise. At the end, the highest bid wins the name and you receive it minus commission. With no bid, the name stays yours.

What cannot coexist: a sale and an auction never both stand on one name. A pending transfer survives a new sale but not a new auction. Entering grace cancels everything and refunds any bid ([Prices](prices)).

## Payment Links

- **Request Payment.** Builds a link that opens your name's Pay screen with the amount and the reference already in it, and copies it. Pick NIM or USDT, type what you are asking for and what it is for, and paste the link into a chat or an invoice. Nothing is sent and nothing is signed. The USDT tab is greyed until the name has an EVM address linked, and says which tile links one. The tile is disabled while a name is in grace, because a name in grace does not resolve ([Pay](pay)).

## Referrals

- **Share Link.** Copies `nimiqnames.com/?ref=<your name>`, and shows how many registrations it has brought in and roughly what they earned at today's prices. Whoever registers through it pays the usual price, and the registry pays your name's address a share of the fee. Disabled in grace, because the registry reads the referrer's status at the moment of each registration ([Referrals](referrals)).
