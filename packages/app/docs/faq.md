# Questions

**Why no smart contracts?**
Nimiq has no virtual machine, and it turns out none is needed. Names travel in ordinary transaction data; a published set of rules turns that history into a registry; proofs let anyone check the result. There is nothing to deploy, nothing to upgrade, and nothing on chain that could be exploited. [What NNS is](intro).

**Is this an official Nimiq project?**
No. It is built on Nimiq by an independent team, and it is MIT licensed, specification included.

**What does "Verified by 1 resolver" mean? Is that unverified?**
It means one resolver answered with a Merkle proof and your device checked the proof against that resolver's published checkpoint. Every check the app can run passed. What is absent is a second party's corroboration, which arrives when a second operator runs a resolver. The number will say 2 that day. [How you know the answer is right](trust).

**Can I recover my name if I lose my key?**
No. A lost or stolen owner key is a lost name, as in ENS. There is deliberately no recovery mechanism, because every version of one either could be cancelled by the owner key (useless against a thief) or outranked the owner. Keep the key safe. [How you know the answer is right](trust).

**Why can't I register `nimiq`, or a three-letter name?**
Both are reserved: every name of 1–4 characters by rule, and a curated list of brands, products, exchanges and impersonation words by list. Reserved names are held, awarded to their rightful owner, or auctioned. [Names](names).

**Can someone front-run my registration?**
In principle, yes: a registration is one transaction, and a watcher could race it. This is accepted rather than mitigated, because the prize is thin (short names are reserved) and Nimiq has no established MEV tooling. The specification records the triggers that would reopen the decision. [How you know the answer is right](trust).

**Can I renew a name I don't own?**
Yes. Renewal is a payment naming the name, and anyone can make it. On another person's name the app calls it *Gift a renewal* and says before you sign that the name stays theirs. [Using the app](app).

**What is a "lifetime" registration?**
{{n:LIFETIME_TERMS}} terms bought at once for the price of {{n:LIFETIME_MULTIPLIER}}, offered beside the one-year term on every registration and renewal. It is an ordinary expiry {{n:LIFETIME_TERMS}} years out, which the app shows as the date it reaches. The name can still be renewed again, transferred and sold. The word is the label on the choice, not a promise the registry makes about you. [Prices](prices).

**What happens when my name expires?**
It enters a {{dur:GRACE_PERIOD}} grace period: it stops resolving, but nobody else can register it and a renewal, by anyone, brings it back with its records. After grace it is available to anyone and the old record is gone. The app reminds you from 60 days before. [Prices](prices).

**Is the marketplace custodial?**
Between your payment and its settlement, yes: the operator holds the money and pays the seller, or refunds you, in a separate transaction. Ownership of the name never waits for that: it moves the moment your payment is final. What is owed and what has been paid are computable from the public log, so a shortfall cannot be hidden. The app asks you to acknowledge this before every purchase and bid. [Using the app](app).

**Why does paying USDT need POL?**
The mini app sends USDT through the wallet's EVM provider as a plain token transfer, and that path pays Polygon's fee in POL. The wallet's own USDT flow is fee-free because it uses a relay the mini app cannot reach. [Using the app](app).

**Can I send someone a link that asks them to pay?**
Yes. The **Request Payment** tile on your name's card builds one: it opens Pay with your name, the amount and a reference already filled in, and copies it ready to paste into a chat or an invoice. It is a URL, not a transaction: the payer can change any field, and nothing is sent until they press Pay. Tapping such a link opens a browser rather than Nimiq Pay, so a payer already inside the mini app pastes it into the recipient field instead. [Using the app](app).

**Can I earn anything for bringing people in?**
Yes. Every registered name has a share link (`nimiqnames.com/?ref=<your name>`) from the **Share Link** tile. Whoever registers through it pays the usual price and gets {{referral:rebate}} of the fee back, and the registry pays your name's address {{referral:default}} of it. Both rates are before the registry's burn. [Referrals](referrals).

**Are messages private?**
No, and this covers both kinds. An Inbox message is a transaction: public, permanent, and attached to your address, readable by anyone on chain forever; the composer says so before your first send. The **reference on a payment** travels in the same place, so an invoice number is public against both addresses too. Neither is a private channel. [Using the app](app).

**Can I move my name to another wallet?**
Two ways, and they are different. To keep the name but pay into a new wallet, change the **target**. To hand the name to someone else, **transfer** it; the transfer takes {{dur:XFER_TIMELOCK}} to complete and can be cancelled meanwhile, which guards a mistyped address. [Using the app](app).

**Does a subdomain cost anything?**
Nothing on NNS. The parent's owner runs a small server with a JSON file of labels and addresses, and hands out as many as they like. Nothing about a subdomain is stored on chain, and nothing about it is proven. [Subdomains](subdomains).

**What does the "?" next to a line do?**
It explains the line. What must be visible is on the card; the reason is one tap away. A blue **(i)** is the same control inside a sheet you are about to send from: the review there is the amount, the address and the date, and the rules behind them are in the bubble. What a purchase must show you stays on the screen, and it still asks you to acknowledge it.

**Is there a dark mode?**
Yes, on the app. The sun/moon button in the top corner switches it, and the choice is remembered on the device. Before you press it the app follows whatever the device itself is set to. The landing page stays light: its photographs were shot for a white page.

**Why do dates say ≈?**
The protocol counts blocks, not seconds. A block is roughly a second, so a date computed from a block height is an estimate, and the app says so.

**Can I run this myself?**
Yes, and the project wants you to. A resolver needs a Nimiq history node and one `docker compose up`; a subdomain host needs a JSON file; an anchor publisher needs a funded EVM key. [Running your own](operators).

**Where is the source?**
In the repository, under an MIT licence, specification included. [Pre-launch status](status).
