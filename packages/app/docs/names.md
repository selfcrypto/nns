# Rules and reserved names

A name is what you type instead of an address. The app names the rule a string broke before it asks the network anything.

## The six rules

1. **{{n:MIN_NAME_LEN}} to {{n:MAX_NAME_LEN}} characters.** Shorter names are not invalid. They are *reserved*, see below.
2. **Only `a` to `z`, `0` to `9` and `-`.** Lowercase only. Type `Rico` and the app searches `rico`.
3. **At least one letter.** `12345` is not a name.
4. **No hyphen at the start or the end, and never two in a row.** `my-name` yes. `-myname`, `myname-` and `my--name` no.
5. **Digits only at the ends, never between letters.** `web3`, `bitcoin7` and `21rico` are fine. `n1m1q`, `nim1qpay`, `g00gle` and `b1tc0in` are not. Impersonating a name means swapping a letter inside it for a digit that looks like one, and this rule removes that whole class. At the ends, `0` and `1` are barred as well, which closes `sud0` against `sudo` and `1ayer` against `layer`.
6. **Not reserved.** See below.

Dots are not part of a name. `shop.rico` is a subdomain of `rico` ([Subdomains](subdomains)).

**Why a hyphen and not an underscore.** An underscore disappears under a link's underline: `self_crypto` reads as `self crypto`. A hyphen does not, and it is legal in a hostname.

## What the search field tells you

Red means the string can never be a name. Grey means it is a real name with a rule that applies to it.

| What you typed | What you see |
|---|---|
| More than {{n:MAX_NAME_LEN}} characters | Too long. {{n:MAX_NAME_LEN}} characters at most. |
| A character outside `a-z 0-9 -` | Only a–z, 0–9 and hyphens. |
| Digits only | A name needs at least one letter. |
| A hyphen first, last, or doubled | Can't start with a hyphen. / Can't end with a hyphen. / No two hyphens in a row. |
| A digit between letters | Digits go at the start or the end, never in the middle. |
| `0` or `1` first or last | A name can't start or end with 0 or 1. |
| Under {{n:MIN_NAME_LEN}} characters, well formed (`okx`) | A grey note: names under {{n:MIN_NAME_LEN}} characters are reserved unless deliberately released. The lookup still runs, in case this one was released. |
| Under {{n:MIN_NAME_LEN}} characters and malformed (`sud0`, `l1do`) | The rule it broke. A string that fails rules 2 to 5 can never be released. |
| Two dots, or a dot with nothing on one side | One dot at most. Write name, or label.name. / Write a subdomain as label.name. |

## Reserved names

Two kinds of name are held back by the registry.

- **Every name of 1 to 4 characters.** `okx`, `visa`, `web3` and `bank` are all held without anyone listing them.
- **A curated list** of about 22,600 names. `nimiq` and Nimiq's own products, exchanges, wallets, chains, payment networks, banks, big brands, famous people and sports clubs by their full names, and the words a scammer would want (`admin`, `support`, `official`). The list is fixed at launch and can only shrink afterwards.

A reserved name is not lost. The administrator can do one of three things with it.

| Disposition | What it means |
|---|---|
| **Hold** | Kept off the market. Nimiq and operator brands, protocol words, roles that invite impersonation. |
| **Award** | Handed to its rightful owner on a verified request, free of charge. Exchanges, wallets, chains, brands. |
| **Auction** | Sold in a public auction with a starting price no lower than the base registration price. Premium generic words. |

The list errs on the side of reserving. A name left off it is anyone's the moment the registry opens, and no rule can take it back. A name reserved by mistake is released with one message.

First names and surnames are **not** reserved. The product is `rico` instead of an address, and the person called David should not have to outbid a squatter for `david`. Two exceptions: the Telegram handles of the Nimiq team, kept for them, and a handful of one-word names only one star answers to, like `ronaldo`.

## How names are shown

Every name in the app is drawn in a typeface that keeps `0` and `o`, `1` and `l`, `rn` and `m` apart. Every address you might pay is shown with its Nimiq identicon, a picture of what will actually be paid.
