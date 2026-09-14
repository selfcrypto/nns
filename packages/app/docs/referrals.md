# Referrals

Share your name's link. Whoever registers through it gets {{referral:rebate}} of the fee back, and your name's address receives {{referral:default}} of it.

## The link

Every registered name has one: `nimiqnames.com/?ref=<your name>`. Copy it from the **Share Link** tile on the name's card in *My names*, which also shows how many registrations the link has brought in and roughly what they earned at today's prices. A name in grace has no working link. Renew first: the registry reads the referrer's status at the moment of each registration.

Inside Nimiq Pay there is no address bar, so a link can also simply be **pasted into the search box** on *Buy*. The app reads the referrer out of it and searches for nothing.

## What you earn, and what they get back

{{referral:default}} of the registration fee to the referrer, and {{referral:rebate}} back to the person who registered, both before the registry's burn, which the rate table explains. Both are paid by the registry out of what it received; the buyer pays the price on the *Prices* page in full and the rebate arrives afterwards, as its own transaction. A registration cannot cost less than its fee (the protocol checks the amount and refunds anything short), so the money comes back rather than coming off.

Both follow the **fee owed**, so they follow the length of the name and the term chosen: a short name earns more than a long one, and a **lifetime** registration is priced on the lifetime fee: {{n:LIFETIME_MULTIPLIER}} yearly fees at once, counted once, because the registry was paid once ([Prices](prices)).

Both are paid by the registry itself after the registration: the share to the address the referring name points at, the rebate to whoever sent the registration. Each arrives as a settlement transaction referencing the registration, so both are visible on chain like every other payout.

A referral is earned **once, when the link is used**. Only a registration carries a referrer; renewing a name later, or extending it to a lifetime, carries none and pays nothing.

## The rate table

Rates are published here and nowhere else. A partner's rate is a row in the same table.

{{referral:rates}}

A rate changes by adding a row with the height it applies from. Rows are never edited, so every payout ever made can be recomputed from this table and the public log.

The rates above are what the programme pays **before the registry's burn**. A fixed share of everything the registry takes in is burned, and a referral is paid out of money it did take in, so each payout carries the burn on its own portion and arrives a fifth smaller. A {{referral:default}} share of a 400 NIM fee is 20 NIM, and 16 NIM lands.

## How it works, and what it cannot do

A registration carries an optional `ref` field naming a registered name. The field has no effect on the registration: a wrong or unknown referrer is simply ignored and the name registers normally. Nothing about ownership, price or resolution depends on it.

The payouts are a policy of the registry, not a rule of the protocol. Independent indexers do not compute them and do not need to; they change no root and no proof. What anyone can do is check them: the log records every referred registration and every payout made.

**Your own link does not pay you.** If the address registering already owns the referring name, the table prices both payouts at nothing. A referral pays for bringing somebody, and there is nobody to bring. The app drops such a link before the registration is sent and says so.

## In the app

A page opened through a link remembers the referrer for a week, or until you register a name. The strip under the search box names who referred you, and removes them if you say so; the review screen before the wallet opens repeats it. If two links were opened, the first one counts.

A referral link and a [payment link](app) are different things and do not mix: `?ref=` says who introduced a registration, `#/pay/<name>` asks someone to pay a name. Only a registration carries a referrer.
