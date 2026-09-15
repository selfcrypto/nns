# Referrals

Share your name's link. Whoever registers through it gets {{referral:rebate}} of the fee back, and your name's address receives {{referral:default}} of it.

## The link

Every registered name has one: `nimiqnames.com/?ref=<your name>`. Copy it from the **Share Link** tile on the name's card in My Names, which also shows how many registrations it has brought in and roughly what they earned.

Inside Nimiq Pay there is no address bar, so a link can also be pasted into the search box on Buy.

A name in grace has no working link. Renew first.

## What is paid

Both payouts are a share of the fee the registration paid, so a short name earns more than a long one and a lifetime registration earns on the lifetime fee. The registry pays them after the registration, each as its own transaction: the share to the address your name points at, the rebate to whoever registered.

The buyer pays the full price and gets the rebate back afterwards. A registration cannot cost less than its fee.

A referral is earned once, at registration. Renewals carry no referrer and pay nothing.

## The rate table

Rates are published here and nowhere else. A partner's rate is a row in the same table.

{{referral:rates}}

A rate changes by adding a row with the height it applies from. Rows are never edited, so every payout ever made can be recomputed from this table and the public log.

The rates are before the registry's burn. {{pct:BURN_SHARE_BP}} of everything the registry takes in is burned, and a payout carries its share of that, so each arrives {{pct:BURN_SHARE_BP}} smaller than the rate says.

## What a referral cannot do

The `ref` field on a registration has no effect on the registration. A wrong or unknown referrer is ignored and the name registers normally. Nothing about ownership, price or resolution depends on it.

The payouts are a policy of the registry, not a rule of the protocol. Anyone can check them: the log records every referred registration and every payout.

**Your own link does not pay you.** If the address registering already owns the referring name, both payouts are zero. The app drops such a link and says so.

## In the app

A page opened through a link remembers the referrer for a week, or until you register a name. If two links were opened, the first one counts. The strip under the search box names who referred you, with a **Remove** control, and the review before the wallet opens repeats it.
