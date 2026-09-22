# Buy

Type a name, or `label.name`. The search runs by itself a second after you stop typing.

## What comes back

| Outcome | What the card shows | What you can do |
|---|---|---|
| **Available** | The price for a year and for a lifetime | **Register** |
| **Registered** | The address it points to, the expiry, and the verification line | **Pay this address**, **Message the owner**, **Gift a renewal** |
| **You own this** | The same card, marked as yours | **Manage it**, which opens the name in My Names |
| **In grace** | "Expired and not available. The owner can renew until ≈ date." | **Gift a renewal** |
| **Reserved** | "Reserved by the registry. Not open for registration." | Nothing ([Rules and reserved names](names)) |
| **For sale or under auction** | The listing, with **Check now** | Opens it in Market |
| **A subdomain** (`shop.rico`) | The parent's verified card, then the address its host gave, marked *Subdomain* | **Pay this address**, **Message this address** |
| **Not a valid name** | The rule it broke, in red | Fix the name |
| **Just registered by someone** | "Just registered by someone else. Search again to see it." | Search again |

Every registered card carries the **verification line**, "Verified by N resolvers" ([The verification line](verification)).

A subdomain card has two halves. The parent (`rico`) is proven. The address for `shop` is the parent owner's server's word. If that server does not answer, the card says "rico's host did not answer. Only its owner can say whether the subdomain exists."

## Registering

Register opens a sheet with the two terms side by side, **a year** and **a lifetime**, each with its price. The review shows what you pay and the date the name runs to. You confirm in the app, then in the wallet's sheet, which shows the treasury address and the amount.

The app then watches for the registration and ends on one of these lines. Every send in the app uses the same ones.

| Line | Meaning |
|---|---|
| Waiting for the wallet… | The wallet's sheet is open |
| Sent. Waiting for the next macro block to confirm it (<1 min). | Signed and broadcast |
| Done. | The name is yours and points at your address |
| Confirmed on chain. The registry catches up at the next macro block (<1 min). | It landed. The registry is up to one macro block behind the chain. Nothing to do |
| On chain, but it did not execute. Nothing changed and the fee is spent. | The transaction failed on chain. Only the network fee is spent |
| Not confirmed: it hasn't appeared on chain. Check the name before sending again. | It may still arrive. Sending again would sign a second transaction |
| Sent, but the service didn't answer, so this is unconfirmed. Check again later. | The checker was down, not your send |

If two people register the same name in the same block, the first in block order wins and the other's payment is refunded ([Refused transactions](fails)).

## Gifting a renewal

Anyone can renew any name. On a name you do not hold, the action is called **Gift a renewal**, and the review says the name stays the owner's ([Prices](prices)).
