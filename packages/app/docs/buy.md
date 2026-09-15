# Buy

Type a name, or `label.name`. The search runs by itself a second after you stop typing.

## What comes back

| Outcome | What the card shows | What you can do |
|---|---|---|
| **Available** | The price for its length, a year or a lifetime | **Register** |
| **Registered** | The owner, the address it points to, the expiry, and the verification line | **Pay this address**, **Message the owner**, **Gift a renewal** |
| **You own this** | The same card, marked as yours | **Manage it**, which opens the name in My Names |
| **In grace** | "Expired and not available. The owner can renew until ≈ date." | **Gift a renewal**. Anyone can renew a name, and it stays the owner's |
| **Reserved** | "Reserved by the registry. Not open for registration." | Nothing ([Rules and reserved names](names)) |
| **For sale or under auction** | The listing, with **Check now** | Hands you to Market |
| **A subdomain** (`shop.kike`) | The parent's verified card, then the address the parent's host gave, marked *Subdomain* | **Pay this address**, **Message this address**. Subdomains are not registered on NNS |
| **Not a valid name** | The rule it broke, in red, before any request leaves your device | Fix the name |
| **Just registered by someone** | "Just registered by someone else. Search again to see it." | Search again |

Every registered card carries the **verification line**, "Verified by N resolvers", with each resolver and its round trip one tap behind it ([The verification line](verification)).

**A subdomain card has two halves.** The parent (`kike`) is proven. The address for `shop` is the parent owner's server's word, and the card says so. If that server does not answer, the card keeps the parent verified and says "kike's host did not answer. Only its owner can say whether the subdomain exists."

## Registering

Register opens a sheet with the two terms side by side: **a year**, and **a lifetime**, {{n:LIFETIME_TERMS}} terms for the price of {{n:LIFETIME_MULTIPLIER}}, each priced for that name's length. The review says what it pays and shows the expiry as the date it reaches ([Prices](prices)). You confirm in the app, then in the wallet's own sheet, which shows the treasury address and the amount.

The app then waits for the registration to appear in the registry. Every send in the app ends in one of these lines.

| Line | Meaning |
|---|---|
| Waiting for the wallet… | The wallet's sheet is open |
| Sent. Waiting for the next macro block to confirm it (<1 min). | Signed and broadcast. The app is watching for the effect |
| Done. | The name is yours and points at your address |
| Confirmed on chain. The registry catches up at the next macro block (<1 min). | The chain has it. The resolver reads in batches, so it is up to one macro block behind. Nothing to do |
| On chain, but it did not execute. Nothing changed and the fee is spent. | The transaction failed on chain. The network fee is spent, nothing else changed |
| Not confirmed: it hasn't appeared on chain. Check the name before sending again. | It may still arrive. A retry signs a second transaction |
| Sent, but the service didn't answer, so this is unconfirmed. Check again later. | The checker was down, not your send. It may well have gone through |

Two people can register the same name in the same minute. The first in block order wins, and the other's payment is refunded ([Refused transactions](fails)). The app checks availability with a proof of absence before it offers Register, so this only happens when two registrations genuinely race.

## Gifting a renewal

Anyone can renew any name. On a name you do not hold, the action is called **Gift a renewal**, and the review says before you sign that the name stays the owner's. The term extends from the current expiry, at the current price ([Prices](prices)).

## Referral links

A registration made through a share link pays the usual price and gets part of it back. The strip under the search box names who referred you, and a share link can be pasted into the search box itself ([Referrals](referrals)).
