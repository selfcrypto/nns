# What NNS is

One name instead of an address. `kike` pays `NQ64 VFXQ TPAS 5Q7S ADEX 072S CR2M QCQ4 8P8M`, on Nimiq, with no smart contract and no custodian in between.

## The idea in three lines

1. **A registration is one ordinary Nimiq transaction.** Its data field says `NNS1Gkike`, its recipient is the registry's treasury address, and its value is the fee. No contract call, no account to open.
2. **An indexer reads every such transaction and applies the published rules.** The result is a table of name → address. Anyone can run one, and every honest one derives the same table, because the rules are deterministic and the chain is final.
3. **Your wallet asks a resolver for a name and gets the address with a Merkle proof.** The wallet checks the proof against a published root before it shows you anything.

## What that buys you

- **Your name is held by your key.** Ownership follows whoever signed the registration. Nobody can take it, freeze it or move it, the people who run the service included.
- **Nothing to trust or upgrade on chain.** The chain is used as what it already is: an ordered, final list of transactions. The rules that interpret it are public, so anyone can re-run them.
- **Answers you can check.** Every lookup carries a proof. If a resolver's answer and the chain disagree, your wallet stops and says so.
- **Subdomains for free.** Register `exchange` once and hand out `alice.exchange` from a server you run, with nothing stored on chain per user.
- **Priced to stay small.** A price that follows length, a one-year term or a lifetime, and a fee on every name, so the public record stays small enough for anyone to replay.
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

- **Not an official Nimiq project.** It is built on Nimiq by an independent team.
- **Not a rollup.** Checkpoint roots are notarised on an EVM chain so past claims cannot be quietly rewritten. That is a timestamp, not a court: the other chain cannot reconstruct or arbitrate NNS state.
- **Not a custodian.** Names are never held for you. The one place money passes through the operator is the marketplace, between a purchase and its settlement, and the app says so wherever it applies.

Everything here is MIT licensed, the protocol specification included.
