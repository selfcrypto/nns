# How you know the answer is right

An operator's answer is an operator's word. NNS is built so you never have to take it: every answer carries a proof, several parties can be asked and compared, and the whole registry can be recomputed from the chain by anyone who wants to, without the operator's help.

## Three clocks

| Clock | Every | What it gates |
|---|---|---|
| **Finality** | ~minutes | **The name is registered and resolves.** Payments to it work |
| **Checkpoint** | ~{{dur:CHECKPOINT_INTERVAL}} | A Merkle proof exists for it |
| **Anchor** | on change, at least daily | The root is notarised on an EVM chain |

Only the first decides whether a name works. A name registered a minute ago resolves normally and shows "Proof pending"; ten minutes later it has a proof; within the day the root that covers it is anchored. Those two later lines are depth, not doubt, and the app words them that way. Someone who just paid for a name is never told something is wrong with it.

## What a proof is

Every resolver publishes a **checkpoint** every ~{{dur:CHECKPOINT_INTERVAL}}: one hash that commits to every name, every address, the prices in effect, every pending offer, transfer and auction, and the hash of the public log up to that block. An answer comes with the leaf for the name and the path from that leaf to the root. Your device rebuilds the leaf from the fields it was given, recombines the path, and compares the result to the committed root. If a single byte of the answer differs from what the checkpoint commits to, the comparison fails.

Two facts follow. A resolver cannot serve you an address the checkpoint does not contain. And a resolver cannot tell you and your neighbour different things under one root. What a proof cannot do is tell you whether the checkpoint itself is honest — a resolver that invented an entire registry can build a perfectly consistent tree over it. That is what the next two mechanisms are for.

## Quorum

The client asks **several independent resolvers** and compares both their roots and their answers. If they disagree, it stops and says so; it never quietly prefers one. Independence is the point: two copies of the same indexer run by the same people have the same bugs and agree by construction.

**At launch there is one resolver**, run by one named operator, and the app shows "Verified by 1 resolver" with the operator's URL under it. Everything above still ran: the proof verified, the checkpoint was checked against itself. What is missing is a second party's corroboration, and the line says exactly that number so that the day a second operator runs a resolver, the count moves to 2 with no change to the app. The resolver list ships inside the client and is never fetched: a list downloaded at runtime could be swapped for one user on one network without a trace, whereas a list compiled into the app can only be changed by publishing a version everyone can inspect.

## Anchoring

Publishers post each checkpoint's commitment to a contract on an EVM chain — on change, and at least once a day. The client reads that back from a public RPC, not from the resolver, and requires the checkpoint its proof used to be the one that was published. Two independent publishers must agree; an anchor older than {{sec:ANCHOR_STALENESS_LIMIT_SEC}} makes the client say so, because it cannot tell "nothing changed" from "the publisher stopped".

Anchoring is a timestamp, not a court. It stops the operator rewriting a past claim and stops them telling different stories to different people. It does not let the other chain arbitrate NNS state. The contract is permissionless, so a second party can anchor without asking anyone — and a second party is what turns a timestamp into corroboration.

## The public log

Every NNS transaction, accepted or refused, is one line in a public log: block, position, hash, sender, recipient, value, data, verdict. Its hash is inside every checkpoint, and each snapshot is published to IPFS with its address in the anchor. Under 15 MB for a hundred thousand messages. It is what makes the burn commitment auditable ([Prices](prices)), what lets a refused transaction be checked rather than inferred from an absence, and what lets anyone rebuild the registry in seconds on a laptop with no node at all.

## Three ways to verify, from cheapest to strongest

1. **Anyone, no node, seconds.** Fetch the log, replay it with the reference implementation, compare the derived checkpoint to the anchored root. Catches any manipulation of state or rules.
2. **Anyone with a node or a public RPC endpoint.** Spot-check log lines by transaction hash against the chain. Catches fabricated entries.
3. **Anyone with a Nimiq history node.** Replay the chain itself from the launch height. The only tier that catches **omission**, and the only one that catches a wholly forged state.

The third is the one that matters, and the project actively wants other people running it — see [Running your own](operators). An NNS with no independent replay has an honest-operator assumption, however many proofs it serves.

## What is guaranteed, and what is not

Stated plainly, because it is easy to overclaim.

**Proofs and anchors alone do not stop a dishonest operator.** One party that produces the state and publishes the anchor can build a false registry, anchor it, and serve proofs that verify. What defeats that is not cryptography but the three things above: independent replay, a client that compares more than one source, and more than one publisher. The property that makes the attack pointless is that the true registry is **recomputable from the chain without the operator**. A stolen namespace would be honoured only by a resolver nobody uses.

So the guarantee is: *the registry can be reconstituted without the operator*, not *the operator cannot cheat*. Everything above exists to make the first statement cheap enough to be true in practice.

**Outside the guarantee:**

- **The app you are running.** Every check above is code served by the operator's website. A hostile page could show any address for any name. That is the ordinary trust boundary of every web app, but it deserves saying here. It is why the app is MIT and anyone can host their own copy, why third-party apps embedding the resolver library are outside the operator's reach entirely, and why resolution built into the wallet itself would close the hole rather than narrow it.
- **The marketplace's money in flight.** Between a purchase or bid and its settlement, the operator holds it. Auditable, not trustless ([Using the app](app)).
- **Delegated answers.** A subdomain's address is its parent owner's word ([Subdomains](subdomains)).
- **Censorship.** A resolver that refuses to answer for a name is detectable — the entry is in the log and any other resolver answers it — but not preventable. Switch resolver.

## Front-running, accepted

A registration is one transaction, so someone watching the network could race you for a name after seeing yours. This is accepted rather than mitigated, and the reasons are written down: Nimiq has no established MEV tooling, every 1–4 character name is reserved so the prize is thin, and the realistic launch threat is a scripted grab of unreserved names, which commit-reveal schemes do nothing against. The mitigation that does work is the reserved list. The triggers for revisiting this — a registration price above ~$20, more than 1% of registrations lost to races, or an observed bot — are recorded in the specification, with the likely fix (a soft commitment in the registration message) sketched beside them.

## The pin, and your own key

**The pin** is the one defence that needs nobody else. The first time you use a name on a device, the app remembers the address; if the name later points elsewhere, the app stops before you pay. A mass redirection becomes many simultaneous alarms, and it covers the look-alike names no rule can catch.

**A lost or stolen owner key is a lost name**, as in ENS. There is no recovery mechanism, deliberately: every version the owner key could cancel was theatre, and every version it could not outranked the owner. The transfer's waiting period guards a mistyped recipient, not a thief, who can sell the name to themselves in two blocks.

**Ownership follows the signing key.** Nimiq Pay sends from a contract it may later rebuild; the registry attributes a message to the key that authorised it, so a name registered from Pay stays yours across that.
