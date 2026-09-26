# Referrals

Share your name's link. Whoever registers through it gets {{referral:rebate}} of the fee back, and your name earns at least {{referral:default}} of it.

## The link

Every registered name has one: `nimiqnames.com/?ref=<your name>`. Copy it from the **Share Link** tile on the name's card in My Names, which also shows how many registrations it has brought in and roughly what they earned.

Inside Nimiq Pay there is no address bar, so a link can also be pasted into the search box on the Search tab.

A name in grace has no working link. Renew first.

## Rates

A buyer who registers through a link always gets {{referral:rebate}} of the fee back. The name whose link it was gets at least {{referral:default}}.

Both are a share of the fee the registration paid, so a short name earns more than a long one and a lifetime registration earns on the lifetime fee. {{pct:BURN_SHARE_BP}} of everything the registry takes in is burned, and a payout carries its share of that, so a {{referral:default}} rate arrives as {{referral:paid}} of the fee.

**Partners.** An exchange, a wallet or a community that brings in registrations at volume can agree a higher rate with us. Get in touch through **Contact** at the top of the app.

## How it is paid

The registry pays after the registration, each as its own transaction: the referrer's share to the address the name points at, the rebate to whoever registered. The buyer pays the full price and gets the rebate back afterwards. A registration cannot cost less than its fee.

A referral is earned once, at registration. Renewals carry no referrer and pay nothing.

**Your own link does not pay you.** If the address registering already owns the referring name, both payouts are zero. The app drops such a link and says so.

## What a referral cannot do

The `ref` field on a registration has no effect on the registration. The registry records it as sent and checks nothing about it: a wrong or unknown referrer earns nothing and the name registers normally. The public log prints the field as typed, so a line can read *referred by* a name that was never registered. Nothing about ownership, price or resolution depends on it.

The payouts are a policy of the registry, not a rule of the protocol. Anyone can check them: the public log records every referred registration and every payout.

## In the app

A page opened through a link remembers the referrer for a week, or until you register a name. If two links were opened, the first one counts. The strip under the search box names who referred you, with a **Remove** control, and the review before the wallet opens repeats it.
