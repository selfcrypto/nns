# Pre-launch status

NNS has not launched. Every package is built, the wire format has been verified against Nimiq mainnet, and a public demo runs on today's values. What remains before a mainnet launch is deployment and one irreversible input, the reserved-name list.

## What is provisional

These values will change in a final freeze before launch. They are shown throughout this documentation as they stand today, read from the code at build time.

| Value | Today | At launch |
|---|---|---|
| **The launch height** | {{height:LAUNCH_HEIGHT}}, the block the demo's indexers start from | A future block chosen at the freeze. Nothing registered on the demo is carried over |
| **The four role addresses** | The demo's ([Constants](constants)) | Regenerated at the freeze |
| **The reserved-name list** | A short test list | A curated list of about a thousand names, applied before the freeze. It cannot be corrected afterwards ([Rules and reserved names](names)) |
| **Resolver quorum** | 2, both run by one operator on two machines | Still 2 on day one. Independence needs a third resolver run by somebody else ([How you know the answer is right](trust)) |
| **Anchor publishers** | None listed. The app says "Second-chain check not run." | The contract deployed on Polygon PoS and at least one listed publisher |

Names registered on the demo are demo names. The demo registry is discarded at the freeze.

## Test eras, and how you can tell

The demo sometimes runs on a **compressed era**: the same code with the clocks cut short, so a name's whole life fits in a few days. Terms are days rather than a year, and prices are set for testing.

You never have to work this out. Every figure on these pages is read from the build you are looking at, and the app carries a **Beta** strip under its masthead for as long as the term is shorter than a year.

## What is live in the demo

Everything on these pages: registration and renewal for a year or a lifetime, every owner action, subdomains through a live host, the marketplace with sales and auctions, settlement, messaging, payment links, referral links, the public log and the burn figures. Both wallets send: Nimiq Pay as a mini app, and the Nimiq Hub in a browser.

## Following along

The repository, [github.com/selfcrypto/nns](https://github.com/selfcrypto/nns), holds the specification, every package, the deployment kits and the decision log. The specification is a numbered draft and the place to start. An issue against it is worth more than a patch: a wire format is expensive to change and cheap to argue about beforehand.
