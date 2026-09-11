# Referrals

Share your name's link. Whoever registers through it pays the usual price, and your name's address receives a share of the fee.

## The link

Every registered name has one: `nimiqnames.com/?ref=<your name>`. Copy it from the **Share Link** tile on the name's card in *My names*, which also shows how many registrations the link has brought in and roughly what they earned at today's prices. A name in grace has no working link — renew first, because the registry reads the referrer's status at the moment of each registration.

## What you earn

{{referral:default}} of the registration fee, by default. The rate is the same whoever registers, and it is a share of what the registry receives: the person you referred pays exactly the price on the *Prices* page, never more.

The share follows the **fee owed**, so it follows the length of the name and the term chosen: a short name earns more than a long one, and a **lifetime** registration earns the share on the lifetime fee — {{n:LIFETIME_MULTIPLIER}} yearly shares at once, paid once, because the registry was paid once ([Prices](prices)).

The share is paid by the registry itself, after each registration, to the address your name points at — the same address that receives payments to the name. It arrives as a settlement transaction referencing the registration, so it is visible on chain like every other payout.

## The rate table

Rates are published here and nowhere else. A partner's rate is a row in the same table.

{{referral:rates}}

A rate changes by adding a row with the height it applies from. Rows are never edited, so every share ever paid can be recomputed from this table and the public log.

## How it works, and what it cannot do

A registration carries an optional `ref` field naming a registered name. The field has no effect on the registration: a wrong or unknown referrer is simply ignored and the name registers normally. Nothing about ownership, price or resolution depends on it.

The share is a policy of the registry, not a rule of the protocol. Independent indexers do not compute it and do not need to; it changes no root and no proof. What they can do is check it: the log records every referred registration and every share paid.

Referring your own registrations earns you back {{referral:default}} of a fee you paid in full — the referring name must already exist before it can refer, so there is no way to register a name through itself.

## In the app

A page opened through a link remembers the referrer until you register a name, then forgets it. The review screen before the wallet opens says who referred you and what they earn. If two links were opened, the first one counts.

A referral link and a [payment link](app) are different things and do not mix: `?ref=` says who introduced a registration, `#/pay/<name>` asks someone to pay a name. Only a registration carries a referrer.
