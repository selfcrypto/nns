# Rules and reserved names

A name is what you type instead of an address. The rules are few, each has a reason, and the app names the one a string broke before it asks the network anything.

## The six rules

1. **{{n:MIN_NAME_LEN}} to {{n:MAX_NAME_LEN}} characters.** Every naming system built for people lands between 15 and 39 (X 15, Farcaster 16, Instagram 30, GitHub 39), and past about 20 a name stops being recognisable at a glance. Names shorter than {{n:MIN_NAME_LEN}} characters are not invalid. They are *reserved*, see below.
2. **Only `a` to `z`, `0` to `9` and `-`.** Lowercase only. `Kike` is not a name and the protocol never turns it into `kike`. The app lowercases what you type before it asks, so you can type either.
3. **At least one letter.** `12345` is not a name.
4. **No hyphen at the start or the end, and never two in a row.** `my-name` yes. `-myname`, `myname-` and `my--name` no.
5. **Digits only at the ends, never between letters.** `web3`, `bitcoin7` and `21kike` are fine. `n1m1q`, `g00gle` and `b1tc0in` are not. Impersonating a name means substituting a character inside it, and this rule removes that whole class without a lookup table. A name also cannot start or end with `0` or `1`, which closes `nimiq0` against `nimiqo` and `1kike` against `lkike`.
6. **Not reserved.** See below.

Dots are not part of a name. `shop.kike` is a query about a subdomain, not a name of its own ([Subdomains](subdomains)).

## Why a hyphen and not an underscore

An underscore disappears under an underline, and names will be rendered as links in wallets and explorers: `self_crypto` underlined reads as `self crypto`, the confusion rule 5 exists to remove. Hyphens are also legal in DNS labels, so a name can become a hostname later. Allowing both would manufacture a collision between `my-name` and `my_name`. Rules 2 and 4 are GitHub's username rules, arrived at independently.

## What the search field tells you

Red means the string can never be a name. Grey means it is a real name, and here is the rule that governs it.

| What you typed | What you see |
|---|---|
| More than {{n:MAX_NAME_LEN}} characters | Too long. {{n:MAX_NAME_LEN}} characters at most. |
| A character outside `a-z 0-9 -` | Only a–z, 0–9 and hyphens. |
| Digits only | A name needs at least one letter. |
| A hyphen first, last, or doubled | Can't start with a hyphen. / Can't end with a hyphen. / No two hyphens in a row. |
| A digit between letters | Digits go at the start or the end, never in the middle. |
| `0` or `1` first or last | A name can't start or end with 0 or 1. |
| Under {{n:MIN_NAME_LEN}} characters, well formed | A grey note: names under {{n:MIN_NAME_LEN}} characters are reserved unless deliberately released. The lookup still runs, because a released short name is an ordinary name. |
| Under {{n:MIN_NAME_LEN}} characters and malformed (`sud0`, `l1do`) | The rule it broke, never "reserved". A string that fails rules 2 to 5 can never be released. |
| Two dots, or a dot with nothing on one side | One dot at most. Write name, or label.name. / Write a subdomain as label.name. |

## Reserved names

Some names are held back by the registry. There are two ways onto that list, and they never overlap.

- **By rule: every name of 1 to 4 characters** that is otherwise well formed. `okx`, `visa`, `web3` and `bank` are all held without anyone listing them.
- **By list: a curated set.** `nimiq` and Nimiq's own products, exchanges, wallets, chains, payment networks, banks, big brands, and the words a scammer would want (`admin`, `support`, `official`). The list is fixed at launch and can only shrink afterwards. A name can be released, but adding one after launch takes a protocol revision.

A reserved name is not lost. The administrator can do one of three things with it.

| Disposition | What it means |
|---|---|
| **Hold** | Kept off the market. Nimiq and operator brands, protocol words, roles that invite impersonation. |
| **Award** | Handed to its rightful owner on a verified request, free of charge. Exchanges, wallets, chains, brands. |
| **Auction** | Sold in a public auction with a starting price no lower than the base registration price. Premium generic words, the ones a day-one script would grab first. |

**Why err on the side of reserving.** A name left off the list is registrable by anyone the moment the registry opens, and no rule can take it back once it has an owner. A name reserved by mistake comes back with one administrative message. Under-reserving is permanent. Over-reserving is reversible.

**"Why can't I register `nimiq`?"** Because it is on the list. The app shows *Reserved* and offers no Register button. A registration built by hand and sent anyway forfeits its payment, because reservation is checkable before sending ([Refused transactions](fails)).

First names are deliberately **not** reserved. The product is `kike` instead of an address, and reserving `david` would make the person called David outbid a squatter at an auction. First come, first served is the fair rule there.

## How names are shown

Every name in the app is drawn in a typeface that keeps `0` and `o`, `1` and `l`, `rn` and `m` apart. Every address you might pay is shown with its Nimiq identicon, a picture of what will actually be paid. A name can be confusable in ways no rule catches, and a wrong payment produces no error.
