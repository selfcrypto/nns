# Status

NNS is live on Nimiq mainnet. The registry opened on 22 September 2026 at block {{height:LAUNCH_HEIGHT}}, and every value on these pages has been frozen since: the launch height, the four role addresses ([Constants](constants)), the price table ([Prices](prices)) and the reserved-name list ([Rules and reserved names](names)). Every figure is read from the build you are looking at, so a change in the code is a change on the page.

## What is still open

| What | Today | What closes it |
|---|---|---|
| **Resolver quorum** | {{n:RESOLVER_QUORUM}}, both run by one operator on two machines that replay separately | A third resolver run by somebody else, which turns the count into an independence check ([Running your own](operators)) |
| **Anchor publishers** | One, run by the operator, anchoring every checkpoint change to Sepolia; the Stats page shows the newest. The app says "Second-chain check not run." | The contract deployed on Polygon PoS and a publisher run by somebody else ([How you know the answer is right](trust)) |
| **The reserved-name list** | About 22,600 names, fixed at launch | Nothing. A name can be released but never added |

## What is live

Everything on these pages: registration and renewal for a year or a lifetime, every owner action, subdomains through a live host, the marketplace with sales and auctions, settlement, messaging, payment links, referral links, notifications by email and Telegram, the public log and the burn figures. Both wallets send: Nimiq Pay as a mini app, and the Nimiq Hub in a browser.

## Following along

The repository, [github.com/selfcrypto/nns](https://github.com/selfcrypto/nns), holds the specification, every package, the deployment kits and the decision log. The specification is a numbered draft and the place to start. An issue against it is worth more than a patch: a wire format is expensive to change and cheap to argue about beforehand. **Contact** at the top of the app opens the project's Telegram group.
