# Pre-launch status

NNS has not launched. Every package is built and conforms to the current draft of the specification, the wire format is settled and has been verified against Nimiq mainnet, and a public demo runs on today's values. What remains before a mainnet launch is deployment and one irreversible input, not code.

## What is provisional

These values are in the code today and will change in a final "freeze" before launch. They are shown throughout this documentation as they stand, read from the code at build time, so they are never out of date. They are not yet final.

| Value | Today | At launch |
|---|---|---|
| **The launch height** | {{height:LAUNCH_HEIGHT}}, the block the demo's indexers start from | A future block chosen at the freeze. Everything registered on the demo before it is not carried over |
| **The four role addresses** | The demo's treasury, protocol, marketplace and admin addresses ([Reference](reference)) | Regenerated at the freeze. Anything sent to today's addresses after that reaches nothing |
| **The reserved-name list** | A short battery-grade list | A curated list of about a thousand names, reviewed and applied before the freeze. It is the one input that cannot be corrected afterwards, because a name left off is anyone's the block after launch ([Names](names)) |
| **Resolver quorum** | 1, one resolver run by one named operator | Still 1 on day one, honestly labelled. The path to 2 is a second, independent operator ([How you know the answer is right](trust)) |
| **Anchor publishers** | None listed; the second-chain check does not run and the app says "Second-chain check not run" | The contract deployed on Polygon PoS and at least one listed publisher, with a second independent publisher the standing invitation |

The one deliberate consequence of the freeze: the demo registry is discarded. Names registered on the demo are demo names.

## Test eras, and how you can tell

The demo is sometimes run on a **compressed era**: the same code with the clocks cut short, so a name's whole life (registration, expiry, grace, a lapsed re-registration) fits in a few days instead of a century. Terms are days rather than a year, and prices are set for testing.

You never have to work this out. Every figure on these pages is read from the build you are looking at, so a compressed era's pages say days where mainnet's say a year; and the app carries a **Beta** strip under its masthead on every screen for as long as the term is shorter than a year. The strip is a consequence of the constants, not a setting someone remembers to switch on, so a test era cannot ship without it and mainnet cannot show it.

## What is live in the demo

Every feature on these pages: registration and renewal for a year or a lifetime, every owner action, subdomains through a live delegate, the marketplace with offers and auctions, settlement, messaging, payment links, referral links and their shares, the public log and the burn figures. Both wallets send: Nimiq Pay as a mini app, and the Nimiq Hub in a browser.

## Following along

- **The repository** holds the specification, every package, the deployment kits and the decision log. The specification is the place to start, and an issue against it is worth more than a patch: a wire format is expensive to change and cheap to argue about beforehand.
- **The specification is a numbered draft.** Revisions are narrated, and the ones that moved bytes are explicit, because each required every database derived under the old rules to be rebuilt.
- **Not an official Nimiq project.** Built on Nimiq by an independent team, MIT licensed, specification included.
