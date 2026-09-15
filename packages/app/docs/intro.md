# What NNS is

One name instead of an address. `kike` pays `NQ64 VFXQ TPAS 5Q7S ADEX 072S CR2M QCQ4 8P8M`, on Nimiq, with no smart contract and no custodian in between.

## How it works

1. **A registration is one ordinary Nimiq transaction.** Its data field says `NNS1Gkike`, its recipient is the registry's treasury address, and its value is the fee.
2. **An indexer reads every such transaction and applies the published rules.** The result is a table of name → address. Anyone can run one, and every honest one derives the same table.
3. **Your wallet asks a resolver for a name and gets the address with a Merkle proof.** The wallet checks the proof before it shows you anything.

## What that gives you

- **Your name is held by your key.** Nobody can take it, freeze it or move it, the people who run the service included.
- **Nothing on chain to trust or upgrade.** The rules are public, and anyone can re-run them over the chain.
- **Answers you can check.** Every lookup carries a proof. If a resolver's answer and the chain disagree, your wallet stops and says so.
- **Subdomains for free.** Register `exchange` once and hand out `alice.exchange` from a server you run.
- **A name is something to be paid at.** Send a link that opens someone's wallet on your name with the amount filled in. Share a link that earns you a share of the fee when someone registers through it.

## Where to go next

| You want to… | Read |
|---|---|
| Pay someone by name | [Pay](pay) |
| Ask someone to pay you | [Pay](pay), under payment links |
| Get a name of your own | [Rules and reserved names](names), [Prices](prices), then [Buy](buy) |
| Manage a name you hold | [My Names](my-names) |
| Give your users `name.yourname` addresses | [Subdomains](subdomains) |
| Know what the proofs guarantee | [How you know the answer is right](trust) |
| Resolve names in your own app or contract | [Integrating NNS](developers) |
| Run a resolver, a subdomain host or an anchor publisher | [Running your own](operators) |

## What it is not

- **Not an official Nimiq project.** It is built on Nimiq by an independent team, MIT licensed, specification included.
- **Not a custodian.** Names are never held for you. The one place money passes through the operator is the marketplace, between a purchase and its settlement ([Market](market)).
- **Not a rollup.** Checkpoint roots are notarised on an EVM chain so past claims cannot be quietly rewritten. The other chain cannot reconstruct or arbitrate NNS state.
