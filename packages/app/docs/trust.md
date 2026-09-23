# How you know the answer is right

An operator's answer is an operator's word. NNS is built so you never have to take it. Every answer carries a proof, several resolvers can be asked and compared, and the whole registry can be recomputed from the chain by anyone.

## Two clocks

| Clock | Every | What it gates |
|---|---|---|
| **Finality** | ~{{dur:CHECKPOINT_INTERVAL}}, the macro block that closes a batch | The name is registered, resolves, and carries a Merkle proof. Payments to it work |
| **Anchor** | on change, at least daily | The root is notarised on an EVM chain |

Only the first decides whether a name works. A checkpoint is cut at every finalised macro block, so a name registered a minute ago resolves normally and already carries its proof. "Proof pending" appears only when a resolver's newest checkpoint is behind its own state, and it adds depth, not doubt. The anchor adds depth too.

## What a proof is

Every resolver publishes a **checkpoint** at every finalised macro block (every ~{{dur:CHECKPOINT_INTERVAL}}): one hash that commits to every name, every address, the prices in effect, every pending sale, transfer and auction, and the public log up to that block. An answer comes with the leaf for the name and the path from that leaf to the root. Your device rebuilds the leaf, recombines the path, and compares the result to the committed root. If one byte of the answer differs, the comparison fails.

So a resolver cannot serve you an address the checkpoint does not contain, and cannot tell you and your neighbour different things under one root. What a proof cannot do is tell you whether the checkpoint itself is honest. That is what the next two mechanisms are for.

## Quorum

The client asks **several independent resolvers** and compares their roots and their answers. If they disagree, it stops and says so. It never quietly prefers one.

The resolver list ships inside the client and is never downloaded, so it can only change by publishing a version everyone can inspect.

The two shipped resolvers are run by one operator on two machines that replay separately. That catches a bug or a bad deploy on one of them. It does not catch the operator. The count in "Verified by N resolvers" is exact, so the day a second operator runs one, it moves ([The verification line](verification)).

## Anchoring

Publishers post each checkpoint's commitment to a contract on an EVM chain, on change and at least once a day. The client reads that back from a public RPC and requires the checkpoint its proof used to be the one that was published. Two independent publishers must agree. An anchor older than {{sec:ANCHOR_STALENESS_LIMIT_SEC}} makes the client say so.

Anchoring is a timestamp, not a court. It stops the operator rewriting a past claim. It does not let the other chain arbitrate NNS state. The contract is permissionless, so a second party can anchor without asking anyone.

## The public log

Every NNS transaction, accepted or refused, is one line in a public log: block, position, hash, sender, recipient, value, data, verdict. Its hash is inside every checkpoint, and each snapshot is published to IPFS. It is what makes the burn commitment auditable ([Prices](prices)) and what lets anyone rebuild the registry in seconds on a laptop with no node at all.

## Three ways to verify

1. **Anyone, no node, seconds.** Fetch the log, replay it with the reference implementation, compare the derived checkpoint to the anchored root. Catches any manipulation of state or rules.
2. **Anyone with a node or a public RPC endpoint.** Spot-check log lines by transaction hash against the chain. Catches fabricated entries.
3. **Anyone with a Nimiq history node.** Replay the chain itself from the launch height. The only tier that catches **omission**.

The third is the one that matters, and the project wants other people running it ([Running your own](operators)).

## What is guaranteed, and what is not

Proofs and anchors alone do not stop a dishonest operator. One party that produces the state and publishes the anchor can build a false registry, anchor it, and serve proofs that verify. What defeats that is independent replay, a client that compares more than one source, and more than one publisher. The guarantee is *the registry can be rebuilt without the operator*, not *the operator cannot cheat*.

Outside the guarantee:

- **The app you are running.** A hostile page could show any address for any name. That is the trust boundary of every web app, and why the app is MIT and anyone can host their own copy.
- **The marketplace's money in flight.** Between a purchase or bid and its settlement, the operator holds it ([Market](market)).
- **Subdomain answers.** A subdomain's address is its parent owner's word ([Subdomains](subdomains)).
- **Censorship.** A resolver that refuses to answer for a name is detectable but not preventable. Switch resolver.

## Front-running

A registration is one transaction, so someone watching the network could race you for a name. This is accepted rather than mitigated: short names are reserved, so the prize is thin, and Nimiq has no established MEV tooling. The specification records what would reopen the decision.

## The pin, and your own key

**The pin** is the one defence that needs nobody else. The first time you use a name on a device, the app remembers the address. If the name later points elsewhere, the app stops before you pay.

**A lost or stolen owner key is a lost name**, as in ENS. There is no recovery mechanism. The transfer's waiting period guards a mistyped recipient, not a thief.

**Ownership follows the signing key.** Nimiq Pay sends from a contract it may later rebuild. The registry attributes a message to the key that authorised it, so a name registered from Pay stays yours across that.
