# What NNS is

One name instead of an address. `kike` pays `NQ64 VFXQ TPAS 5Q7S ADEX 072S CR2M QCQ4 8P8M`, on Nimiq, with no smart contract and no custodian in between.

## The idea in three lines

1. **A registration is one ordinary Nimiq transaction.** Its data field says `NNS1Gkike`, its recipient is the registry's treasury address, and its value is the fee. Nothing else is needed: no contract call, no account to open.
2. **An indexer reads every such transaction and applies the published rules.** The result is a table of name → address. Anyone can run one, and every honest one derives exactly the same table, because the rules are deterministic and the chain is final.
3. **Your wallet asks a resolver for a name and gets the address with a Merkle proof.** The wallet checks the proof against a published root before it shows you anything. An operator's word is never enough on its own.

## What that buys you

- **Your name is held by your key.** Ownership follows whoever signed the registration. Nobody can take it, freeze it or move it — not the people who run the service, not anyone else.
- **Nothing to trust or upgrade on chain.** The chain is used as what it already is: an ordered, finalised list of transactions. Everything else is interpretation, and the interpretation rules are public so anyone can re-run them.
- **Answers you can check.** Every lookup carries a proof. If a resolver's answer and the chain disagree, your wallet stops and says so instead of guessing.
- **Subdomains for free.** Register `exchange` once and hand out `alice.exchange` from a server you run, with nothing stored on chain per user.
- **Cheap, and priced to stay small.** Two price bands, a one-year term, and a fee on every band so the public record stays small enough for anyone to replay.

## Who this is for

| You want to… | Read |
|---|---|
| Pay someone by name | [Using the app](app) — the Pay tab |
| Get a name of your own | [Names](names), [Prices](prices), then [Using the app](app) — the Buy tab |
| Manage a name you hold | [Using the app](app) — My names |
| Give your users `name.yourname` addresses | [Subdomains](subdomains) |
| Know what the proofs actually guarantee | [How you know the answer is right](trust) |
| Resolve names in your own app or contract | [Integrating NNS](developers) |
| Run an independent resolver, delegate or anchor publisher | [Running your own](operators) |

## What it is not

- **Not an official Nimiq project.** It is built on Nimiq by an independent team.
- **Not a rollup.** Checkpoint roots are notarised on an EVM chain so past claims cannot be quietly rewritten. That is a timestamp, not a court: the other chain cannot reconstruct or arbitrate NNS state.
- **Not a custodian.** Names are never held for you. The one place money passes through the operator is the marketplace, between a purchase and its settlement, and that is said plainly wherever it applies.

Everything here — the protocol specification included — is MIT licensed. An interpretation layer that anyone may reimplement is the only kind worth trusting.
