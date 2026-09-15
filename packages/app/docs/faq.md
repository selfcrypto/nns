# Questions

**Why no smart contracts?**
Nimiq has no virtual machine, and none is needed. Names travel in ordinary transaction data, published rules turn that history into a registry, and proofs let anyone check the result. [What NNS is](intro).

**Is this an official Nimiq project?**
No. It is built on Nimiq by an independent team, MIT licensed. The source is at [github.com/selfcrypto/nns](https://github.com/selfcrypto/nns).

**What does "Verified by 1 resolver" mean?**
One resolver answered with a Merkle proof and your device checked it. The number is how many independent resolvers agreed. [The verification line](verification).

**Can I recover my name if I lose my key?**
No. A lost or stolen owner key is a lost name, as in ENS. Keep the key safe. [How you know the answer is right](trust).

**Why can't I register `nimiq`, or a three-letter name?**
Both are reserved: every name of 1 to 4 characters, and a list of brands, products, exchanges and impersonation words. [Rules and reserved names](names).

**Can I renew a name I don't own?**
Yes. Anyone can renew any name. The app calls it **Gift a renewal**, and the name stays the owner's. [Buy](buy).

**What is a "lifetime" registration?**
{{n:LIFETIME_TERMS}} years for the price of {{n:LIFETIME_MULTIPLIER}}. The app shows the date it reaches. [Prices](prices).

**What happens when my name expires?**
It enters a {{dur:GRACE_PERIOD}} grace period: it stops resolving, nobody else can register it, and a renewal brings it back. After grace it is available to anyone. The app reminds you from 60 days before. [Prices](prices).

**Is the marketplace custodial?**
Between your payment and its settlement, yes. The operator holds the money and pays the seller, or refunds you, in a separate transaction. The name itself moves the moment your payment is final. [Market](market).

**Why does paying USDT need POL?**
The mini app sends USDT as a plain Polygon token transfer, and Polygon charges its fee in POL. [Pay](pay).

**Can I send someone a link that asks them to pay?**
Yes. The **Request Payment** tile on your name's card builds one. [Pay](pay).

**Can I earn anything for bringing people in?**
Yes. Whoever registers through your name's share link gets {{referral:rebate}} of the fee back, and your name's address receives {{referral:default}}. [Referrals](referrals).

**Are messages private?**
No. An Inbox message is a transaction, readable by anyone on chain forever. So is the message on a payment. [Inbox](inbox).

**Can I move my name to another wallet?**
To keep the name but pay into a new wallet, change the **Target Address**. To hand it to someone else, use **Transfer Ownership**. [My Names](my-names).

**Does a subdomain cost anything?**
Nothing. The name's owner runs a small server with a JSON file of labels and addresses. [Subdomains](subdomains).

**Why do dates say ≈?**
The protocol counts blocks, and a block is roughly a second. [Getting started](getting-started).

**Can I run this myself?**
Yes. A resolver needs a Nimiq history node and one `docker compose up`. A subdomain host needs a JSON file. [Running your own](operators).
