# The verification line

Every address the app shows you sits in one block with the line that says who vouched for it. It is the same block on the Buy card, on Pay, above the Market sheet and under a subdomain's parent.

## "Verified by N resolvers"

That resolver answered with a Merkle proof, and this app checked the proof against the resolver's published checkpoint before showing you the address. The number says how many independent parties agreed. Tap the line to see each one: the endpoint that answered, and how long the round trip took.

"Verified by 1 resolver" is not "unverified". Every check the app can run has passed. What is absent is corroboration by a second party, and the count moves the day one exists ([How you know the answer is right](trust)).

## Two quiet lines

Either can appear under a fresh name, and neither is a problem.

- "Proof pending. The name works now. Checkpoints are cut every ~{{dur:CHECKPOINT_INTERVAL}}." The name is registered and resolves. The proof arrives with the next checkpoint.
- "Repointed since the last checkpoint. This address is newer than its proof." The owner changed the target after the last checkpoint. The proof covers the previous address, and the next checkpoint covers this one.

A name works the moment its transaction is final. Proofs and anchors add depth afterwards.

## A subdomain

A subdomain card is marked *Subdomain* and badged *Resolved by `parent`*. The parent is proven. The address is the parent owner's server's word, and the "?" beside it says so ([Subdomains](subdomains)).

## Red

Red only ever means one thing: verification failed and no address is shown.

- "Stop. Resolvers disagree"
- "A resolver served a proof that does not hold. Do not pay any address it showed."
- "The anchored checkpoint does not match what this resolver served. Do not pay any address it showed."

These are the failures the whole design exists to catch, and the app stops rather than guessing. The card lists each resolver and what it answered, so a disagreement is something you can go and look into.

## The pin

The one check that needs no resolver. The first time you use a name on a device, the app remembers the address. If the name later points elsewhere, Pay stops with "Stop. This name changed address" and both addresses side by side ([Pay](pay)).
