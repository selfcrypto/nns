# Using the app

Five tabs, and each one is a job: **Buy** finds and registers, **Pay** sends money to a name, **My names** manages what you hold, **Inbox** carries messages, **Market** buys and sells. Nothing is more than two taps deep.

## Getting in

The app runs in two places:

- **Inside Nimiq Pay**, as a mini app. Pay hands over your addresses when you open it, signs every transaction in its own sheet, and opens straight on Buy.
- **In a browser**, with the Nimiq Hub as the wallet. A browser opens on the landing page; its search takes you into Buy. Every action works here too, signed by the Hub.

The screen you are on is the page's address (`#/buy/kike`, `#/names`, `#/market/indigo`), so a reload and a shared link land where you were.

Your acting address sits in the top corner with its identicon. Tap it to see your other addresses, add one, or disconnect. Inside Nimiq Pay, disconnecting is device-local: it stops this app using your addresses, and that is all it can do.

## Buy: find a name

Type a name, or `label.name`. The search runs by itself a second after you stop typing. One of these comes back:

| Outcome | What the card shows | What you can do |
|---|---|---|
| **Available** | The price for its length, a year or a lifetime | **Register** |
| **Registered** | The owner, the address it points to, the expiry, and the verification line | **Pay this address**, **Message the owner**, **Gift a renewal** |
| **You own this** | The same card, marked as yours | **Manage this name**, which opens it in My names |
| **In grace** | "Expired and not available. The owner can renew until ≈ date." | **Gift a renewal**: anyone can renew a name, and it stays the owner's |
| **Reserved** | "Reserved by the registry. Not open for registration." | Nothing. See [Names](names) |
| **For sale or under auction** | The listing, with **Check now** | Hands you to Market |
| **A subdomain** (`shop.kike`) | The parent's verified card, then the address the parent's host gave, marked *Subdomain* | **Pay this address**, **Message this address**. No registration: subdomains are not registered on NNS |
| **Not a valid name** | The rule it broke, in red, before any request leaves your device | Fix the name |
| **Just registered by someone** | "Just registered by someone else. Search again to see it." | Search again |

Every registered card carries the **verification line**: "Verified by N resolvers". Tap it to see each one, by the endpoint that answered and how long it took. Tap the "?" beside it for what that means, or read [How you know the answer is right](trust).

**A subdomain card is honest about its two halves.** The parent (`kike`) is proven. The address for `shop` is the parent owner's server's word, and the card says so. If that server does not answer, the card shows the parent still verified and says "`kike`'s resolver did not answer", never that the subdomain does not exist, because only its owner can know that.

### Registering

Register opens a sheet with the two terms side by side: **a year**, and **a lifetime** ({{n:LIFETIME_TERMS}} terms for the price of {{n:LIFETIME_MULTIPLIER}}), each with its own price for that name's length. Whichever you pick, the review says what it pays and shows the expiry as the **date it reaches**, because "lifetime" is the label on a choice and a date is the fact ([Prices](prices)). You confirm in the app, then in the wallet's own sheet, which shows the treasury address and the amount. The app then waits for the registration to appear in the registry:

| Line | Meaning |
|---|---|
| Waiting for the wallet… | The wallet's sheet is open |
| Sent. Waiting for the block that confirms it | Signed and broadcast; the app is watching for the effect |
| Done. | The name is yours and points at your address |
| Confirmed on chain. The registry catches up at the next macro block (<1 min). | The chain has it; the resolver reads in batches, so it is up to one macro block behind. Nothing to do |
| Included on chain but did not execute. | The transaction failed on chain. The network fee is spent, nothing else changed |
| Not confirmed. It hasn't appeared on chain yet. | It may still arrive. Check the name before retrying, because a retry signs a second transaction |
| Sent to the wallet, but the service didn't answer. | The checker was down, not your send. It may well have gone through |

Two people can register the same name in the same minute. The first one in block order wins, and the other's payment is refunded ([When a transaction is refused](fails)). The app checks availability with a proof of absence before it offers Register, so this only happens when two registrations genuinely race.

## Pay: send money to a name

Type a name; it resolves exactly as in Buy. Then an amount, and the wallet signs. Nothing is written to the registry; this is an ordinary payment whose recipient came from a verified lookup.

- **NIM** goes to the address the name points to.
- **USDT on Polygon** goes to the EVM address the name's owner linked. The switch is on the screen. A name whose owner has not linked one says so and is not payable this way. The send goes through the wallet's EVM provider as a plain token transfer, and **that path pays Polygon's fee in POL**: with no POL the wallet refuses and the app says "The wallet has no POL for Polygon's network fee. Nothing was sent." The wallet's own USDT flow is fee-free because it uses a relay the mini app cannot reach. Once the wallet accepts the transfer, the app hands you a Polygonscan link rather than calling it confirmed.

Under the address is the **verification line**, the same one the Buy card carries: how many resolvers proved this answer, and, on a tap, which ones. Beside the address is the **identicon** of what will be paid, and the wallet shows it again in its own sheet. Two refusals are made in the app because the network would otherwise fail silently: a payment to your own address (Nimiq drops it), and an amount of zero (Nimiq rejects it).

**The pin check.** The first time you use a name on a device, the app remembers where it pointed. If it later points somewhere else, Pay stops: "Stop. This name changed address", both addresses with both identicons, and the button disabled. The owner may have repointed the name legitimately, or someone may be redirecting payments. Do not pay until you know which. The override takes two deliberate taps, and it replaces what the device remembers.

### The message

A NIM payment can carry a short **message**, like an invoice or an order number, so whoever receives it can tell which payment is which. It travels in the transaction's data field, so it is **public and permanent**, readable by anyone against both addresses, and the field counts what is left of its 64 bytes as you type (an accent or an emoji costs more than one). Two messages are refused before the button lights, because both fail silently once sent: one over the budget, and one beginning `NNS1`, which is how a name message is written and would be read as one by every indexer. A **USDT payment carries no message**, because a token transfer has nowhere to put one, and the screen says so rather than dropping it quietly.

### Payment links

A link opens Pay with the fields already filled:

```
https://nimiqnames.com/pay/donald?amount=25&message=INV-42
```

The name is the recipient, `amount` and `message` fill the two fields, and `asset=usdt` asks for USDT instead of NIM. Pasted into a chat, the link draws a card that says who is being paid and how much: the site answers it with that card, then opens the app at `#/pay/donald?…`, the same screen either way. Nothing is committed by opening one: every field stays editable, and the message that came with the link is read-only until you tap **Edit**, so the payee's wording is not lost by accident. Nothing is sent until you press Pay.

**A link you were sent can be pasted into the recipient field.** Tapping a link in a chat app opens your browser, not Nimiq Pay (no association exists between the wallet and this site, and half of that is Nimiq's to publish), so a payer already inside the mini app would otherwise have no way to use one. Paste it where a name goes and it applies whole, exactly as it would from the address bar. The field tells a link from a name by the `/pay/` or the `#` in it, neither of which a name can contain, so typing an ordinary name is untouched.

**Owners build one from their name's card**, under *Payment Links* in My names (see below).

## My names: manage what you hold

Your names, soonest expiry first, with a badge from 60 days before expiry ("Renew before ≈ date") and a grace badge when one has expired. Tap a name to open it in place. The card shows the current target, expiry, any pending item, and the owner's actions as tiles. A tile that is not possible right now stays visible and says why ("Locked while the auction runs.", "In grace. Only renewal works until it ends."). Every tile opens a sheet that first shows the current value, then takes your input, then says what will change before the wallet opens.

**Routing & records**

- **Target address.** Where the name pays. Changing it does not change ownership. This is the right action when you have moved to a new wallet: point the name at the new address and keep the owner key that controls it. "Point back at my address" is offered as a one-tap option.
- **EVM resolution.** Link one EVM address (`0x…`, checksum-verified when mixed-case). One address covers every EVM chain, because wallets derive the same address on all of them. The app can fill it from a connected EVM wallet, or you paste it. The registry records what you declare; control of that address is shown on the EVM side by using it. Clear it with the Clear button. A wrong address is fixed by sending another. There is no waiting period on this record.
- **Subdomain host.** The hostname of a server you run that answers for `anything.yourname`. Name and host together are limited to 52 characters, and the host must already answer over HTTPS before you set it. An empty host switches subdomains off. See [Subdomains](subdomains).

**Ownership & renewal**

- **Renew registration.** Extends the expiry by {{dur:TERM_LENGTH}} (or by a lifetime, {{n:LIFETIME_TERMS}} terms for the price of {{n:LIFETIME_MULTIPLIER}}) from the current expiry, at the current price. The sheet offers the two terms side by side with their prices, and the review shows the new expiry as the date it is. Renewing early never costs you time. Anyone can renew any name: on someone else's card in Buy the same action is called **Gift a renewal**, and the review says plainly that the name stays theirs.
- **Transfer ownership.** Names the new owner, **by address or by name**: type a name and the field resolves it and fills itself with the address that came back, which is the address the registry will record. The transfer takes effect after **{{dur:XFER_TIMELOCK}}**; until then you keep full control, the name resolves as before, and **Cancel** undoes it. A second transfer replaces the first and restarts the clock. The wallet's sheet shows the recipient's address and identicon, so check it there. When the transfer completes, the new owner gets the name pointing at themselves, the linked EVM address and subdomain host are cleared, and any open offer is cancelled. **The waiting period is for a mistyped address, not a stolen key**: someone holding your key does not need a transfer at all.
- **Cancel transfer / Cancel listing.** One cancel undoes everything currently cancellable on the name: a pending transfer, and an offer that is past its irrevocable window. The tile is named after whichever of those it would actually clear, and sits beside it: with only a transfer pending it is here, with a listing involved it is under Marketplace. The sheet lists what will go, and says plainly when an offer is still inside its irrevocable window, because that listing stays. An auction cannot be cancelled, because bidders have committed money against a window they were told in advance.

**Marketplace**

- **Sell (fixed price).** Lists the name at a price you set, no lower than the base registration price in effect (today {{nim:FEE_BASE}}). Listing is free. The offer is **irrevocable for {{dur:OFFER_IRREVOCABLE}}**, cancellable after that, and expires by itself after {{dur:OFFER_MAX_LIFETIME}}. On sale you receive the price minus {{pct:COMMISSION_RATE}} commission. The sheet says all of this before you sign.
- **Start auction.** Sets a starting price (same floor as an offer) and a duration of at least {{dur:AUCTION_MIN_DURATION}}. The end must fall before the name's expiry, because an auction sells the current term; the sheet warns you and suggests renewing first. Opening an auction voids your own pending transfer and open offer. While it runs, the name cannot be listed, transferred or auctioned again, and neither the auction nor a bid can be withdrawn. A bid in the last {{dur:AUCTION_EXTENSION}} extends the end by that much, so a last-second bid never wins by surprise. At the end, the highest bid wins the name and you receive it minus commission; with no bid, the name stays yours.

What cannot coexist: an offer and an auction never both stand on one name. A pending transfer survives a new offer but not a new auction. Entering grace cancels everything and refunds any bid ([Prices](prices)).

**Payment Links**

- **Request Payment.** Builds a link that opens your name's Pay screen with the amount and the reference already in it, and copies it. Pick NIM or USDT, type what you are asking for and what it is for, and the link is ready to paste into a chat, an invoice or a message. Nothing is sent and nothing is signed: a link is a URL, not a transaction, and the payer stays in control of every field. The USDT tab is greyed until the name has an EVM address linked, and says which action links one. The tile is disabled while a name is in grace, because a name in grace does not resolve and a link to it has nothing to pay.

**Referrals**

- **Share Link.** Copies `nimiqnames.com/?ref=<your name>`, and shows how many registrations it has brought in and roughly what they earned at today's prices. Whoever registers through it pays exactly the usual price; the registry pays your name's address a share of the fee. A lifetime registration earns the share on the lifetime fee. Disabled in grace, because the registry reads the referrer's status at the moment of each registration ([Referrals](referrals)).

## Inbox: messages to your names

Anyone who finds your name can write to you. A message is a tiny transaction to the name's **owner**, not to the address it pays (which might be an exchange deposit nobody reads), carrying a short text in its data field. Your inbox lists them per sender.

- **Messages are public, permanent, and attached to your address.** Anyone can read them on chain, forever. The composer says so before your first send.
- A message is rendered as **plain text**: no links, no formatting, no address detection. A message asking you to pay somewhere is just text, and the only action a message can offer is a reply.
- The **names above a sender's address come from the registry**, not from the message. The name a message claims to be *about* is the sender's claim; if it is not one of yours, the app says so.
- **Hide sender** silences an address on this device. Hidden conversations collapse into "Hidden (n)" rather than vanishing.
- Messages fit in a 64-byte transaction, so they are short. The composer counts bytes.
- You cannot message your own name; the network would silently drop a transaction to yourself, so the app refuses first.
- A message to a **subdomain** goes to the address the parent's host answered with, the only party the query designates, and the composer says that address may not be the parent's owner.

## Market: buy, bid, sell

Every open offer and every running auction, in one list. Filter by name, or by *Buy now* and *Auctions*. Each listing shows the name, the price or the standing bid, the seller, and when it ends. Tapping one opens the name's proof above the form (its address, verification line and pin check), so nobody pays for a name they have not seen verified.

**Buying at a fixed price.** You pay exactly the price to the marketplace address, and the name is yours the moment that payment is final. Ownership never waits for anyone. The seller is paid by the settlement service, minus commission, in a separate transaction.

**Bidding.** The first bid must meet the starting price; each later bid must beat the standing bid by at least {{pct:AUCTION_MIN_INCREMENT_BP}}. The app shows the minimum next bid and refuses less. When a higher bid lands, the outbid bidder is refunded at once, so the marketplace holds one bid per auction, never a pile. At the end, the standing bid wins and the name transfers.

**What the operator holds, said plainly.** Between your payment and its settlement, the marketplace operator holds the money. A purchase that loses a race or hits a cancelled offer is refunded by the operator; a bid is held by the operator for the whole window and refunded if outbid. What is owed and what has been paid are both computable from the public log, so a shortfall can never be hidden. It is still a promise, not a protocol rule. The app asks you to acknowledge this before every purchase and every bid: "I understand a refund would come from the marketplace operator."

The Market also carries the **fee burn** figures (burned so far, owed so far, and whether the operator is behind, ahead or even), computed from the public log ([Prices](prices)).

## The verification line, everywhere

"Verified by 1 resolver" means: that resolver answered with a Merkle proof, and this app checked the proof against the resolver's published checkpoint before showing you the address. The number says how many independent parties agreed. At launch there is one, and tapping the line names it with its URL. That is not "unverified": every check the app can run has passed. What is absent is corroboration by a second party, which arrives when a second operator runs a resolver ([How you know the answer is right](trust)).

Two quieter lines can appear under a fresh name, and neither is a problem: "Proof pending. The name works now. Checkpoints are cut every ~{{dur:CHECKPOINT_INTERVAL}}." and "Repointed since the last checkpoint. This address is newer than its proof." A name works the moment its transaction is final; proofs and anchors add depth afterwards.

Red only ever means one thing: verification failed and no address is shown. "Stop. Resolvers disagree", "A resolver served a proof that does not hold", "The anchored checkpoint does not match what this resolver served." These are the failures the whole design exists to catch, and the app stops rather than guessing. The card names each resolver and what it answered, so a disagreement is something you can go and look into rather than a wall.
