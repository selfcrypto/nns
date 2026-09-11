# Names and reserved names

A name is what you type instead of an address. The rules are few, each has a reason, and the app tells you which one a name broke before it asks the network anything.

## The six rules

1. **{{n:MIN_NAME_LEN}} to {{n:MAX_NAME_LEN}} characters.** Every naming system built for people lands between 15 and 39 (X 15, Farcaster 16, Instagram 30, GitHub 39), and past about 20 a name stops being recognisable at a glance. Recognition is the whole product. Names shorter than {{n:MIN_NAME_LEN}} characters are not invalid; they are *reserved* — see below.
2. **Only `a`–`z`, `0`–`9` and `-`.** Lowercase only. `Kike` is not a name and is never quietly turned into `kike` by the protocol; the app lowercases what you type before it asks, so you can type either.
3. **At least one letter.** `12345` is not a name.
4. **No hyphen at the start or the end, and never two in a row.** `my-name` yes; `-myname`, `myname-` and `my--name` no.
5. **Digits only at the ends, never between letters.** `web3`, `bitcoin7` and `21kike` are fine. `n1m1q`, `g00gle` and `b1tc0in` are not. Impersonating a name means substituting a character *inside* it, and this one rule removes that whole class without a lookup table. Additionally, **a name cannot start or end with `0` or `1`**, which closes `nimiq0`/`nimiqo` and `1kike`/`lkike`. Nothing anyone wants begins or ends in `0` or `1`.
6. **Not reserved.** See the next section.

Dots are not part of a name. `shop.kike` is a query about a subdomain, not a name of its own — see [Subdomains](subdomains).

## Why a hyphen and not an underscore

Most social platforms use the underscore, so the choice deserves a reason. An underscore disappears under an underline, and names will be rendered as links in wallets and explorers: `self_crypto` underlined reads as `self crypto` — exactly the confusion rule 5 exists to remove. Hyphens are also legal in DNS labels, so a name can become a hostname later. Allowing both would be the worst option: `my-name` and `my_name` would be a manufactured collision. Rules 2 and 4 are, arrived at independently, GitHub's username rules.

## What the search field tells you

The app names the rule that actually failed. Red means the string can never be a name; grey means it is a real name and here is the rule that governs it.

| What you typed | What you see |
|---|---|
| More than {{n:MAX_NAME_LEN}} characters | Too long — {{n:MAX_NAME_LEN}} characters at most. |
| A character outside `a–z 0–9 -` | Only a–z, 0–9 and hyphens. |
| Digits only | A name needs at least one letter. |
| A hyphen first, last, or doubled | Can't start with a hyphen. / Can't end with a hyphen. / No two hyphens in a row. |
| A digit between letters | Digits can't sit inside letters — only lead or trail. |
| `0` or `1` first or last | A name can't start or end with 0 or 1. |
| Under {{n:MIN_NAME_LEN}} characters, well formed | A grey note: names under {{n:MIN_NAME_LEN}} characters are reserved unless deliberately released. The lookup still runs, because a released short name is an ordinary name. |
| Under {{n:MIN_NAME_LEN}} characters and malformed (`sud0`, `l1do`) | The rule it broke — never "reserved", because a string that fails rules 2–5 can never be released. |
| Two dots, or a dot with nothing on one side | One dot at most — name, or label.name. / Write a subdomain as label.name. |

## Reserved names

Some names are held back by the registry. There are two ways onto that list, and they never overlap:

- **By rule: every name of 1 to 4 characters** that is otherwise well formed. `okx`, `visa`, `web3`, `bank` are all held without anyone listing them.
- **By list: a curated set** — `nimiq` and Nimiq's own products, exchanges, wallets, chains, payment networks, banks, big brands, and the words a scammer would want (`admin`, `support`, `official`). The list is fixed at launch and can only shrink afterwards: a name can be released, but adding one after launch takes a protocol revision.

A reserved name is not lost. The administrator can do one of three things with it, and the list is organised by which:

| Disposition | What it means |
|---|---|
| **Hold** | Kept off the market. Nimiq and operator brands, protocol words, roles that invite impersonation. |
| **Award** | Handed to its rightful owner on a verified request, free of charge. Exchanges, wallets, chains, brands. |
| **Auction** | Sold in a public auction with a starting price no lower than the base registration price. Premium generic words — the ones a day-one script would grab first. |

**Why err on the side of reserving.** A name left off the list is registrable by anyone the moment the registry opens, and no rule can take it back once it has an owner. A name reserved by mistake comes back with one administrative message. Under-reserving is permanent; over-reserving is reversible.

**"Why can't I register `nimiq`?"** Because it is on the list. The app shows *Reserved* and offers no register button. If you built a registration by hand and sent it anyway, the payment is forfeited — reservation is checkable before sending, so the protocol treats it as a preventable loss ([When a transaction is refused](fails)).

First names are deliberately **not** reserved. The product is `kike` instead of an address, and reserving `david` would mean the person called David has to outbid a squatter at an auction instead of registering it. First come, first served is the fair rule there.

## Subdomains, briefly

`shop.kike` is a **label** (`shop`) under a **parent** (`kike`). The parent must be a registered name whose owner has set a subdomain host. Labels have looser rules than names: 1 to {{n:MAX_LABEL_LEN}} characters from `a–z 0–9 -`, no hyphen at either end or doubled, no letter required, and no digit rule — they are not scarce, not sold, and the parent disambiguates them. Only one dot is allowed.

Nothing about a subdomain is stored on chain. The owner's own server answers for it, and the answer carries no proof. [Subdomains](subdomains) has the whole story.

## How names are shown

Every name in the app is drawn in a typeface that keeps `0` and `o`, `1` and `l`, `rn` and `m` apart, and every address you might pay is shown with its Nimiq identicon — a picture of what will actually be paid. Both exist because a name can be confusable in ways no rule catches, and a wrong payment produces no error.
