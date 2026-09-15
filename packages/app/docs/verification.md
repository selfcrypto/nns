# The verification line

Every address the app shows sits in one block with the line that says who vouched for it: on the Buy card, on Pay, above the Market sheet, and under a subdomain's parent.

## "Verified by N resolvers"

Each resolver answered with a Merkle proof, and the app checked the proof against that resolver's published checkpoint before showing the address. N is how many independent resolvers agreed. Tap the line to see each one, with the endpoint that answered and its round trip.

"Verified by 1 resolver" is not "unverified". Every check the app can run has passed. What is absent is a second party's confirmation, and the count moves the day one exists ([How you know the answer is right](trust)).

## Two quiet lines

Either can appear under a fresh name, and neither is a problem.

- "Proof pending. The name works now. Checkpoints are cut every ~{{dur:CHECKPOINT_INTERVAL}}." The name is registered and resolves. The proof arrives with the next checkpoint.
- "Repointed since the last checkpoint. This address is newer than its proof." The owner changed the target after the last checkpoint. The next checkpoint covers the new address.

## A subdomain

A subdomain card is marked *Subdomain* and badged *Resolved by* the host that answered. The parent is proven. The address is the parent owner's server's word ([Subdomains](subdomains)).

## Red

Red means verification failed and no address is shown.

- "Stop. Resolvers disagree"
- "A resolver served a proof that does not hold. Do not pay any address it showed."
- "The anchored checkpoint does not match what this resolver served. Do not pay any address it showed."

The card lists each resolver and what it answered, so you can see who disagreed with whom.

## The pin

The one check that needs no resolver. The first time you use a name on a device, the app remembers the address. If the name later points elsewhere, Pay stops with "Stop. This name changed address" and shows both addresses ([Pay](pay)).
