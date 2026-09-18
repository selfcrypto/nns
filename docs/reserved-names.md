# `RESERVED_NAMES` — the launch list

**Applied 2026-09-18: 22,449 names in 46 categories** (`tasks/25`); the
Nimiq team's Telegram handles and a sports pass (club nicknames, 2024–26
stars) joined 2026-09-19 — **22,635 names in 47**. The list
lives in `packages/core/reserved-names/`, one JSON file per category, each
naming its tier and its source; `pnpm gen:reserved` flattens them into
`src/reserved-names.ts`, the constant that ships. This file is the policy —
the names are in the category files and nowhere else.

## The stance

§4.1's asymmetry, taken at face value: a name left off is anyone's the block
after `LAUNCH_HEIGHT`, forever; a name reserved by mistake comes back with one
`U`. So **when unsure, reserve** (Kike, 2026-09-18: *it can be speculative,
protect as much as possible, we can always release them*). A doubtful entry
goes in under its category's `speculative` array — reserved exactly like the
rest, listed apart only so the release candidates are one read away.

**The one exception is personal names.** First names (`david`, `maria`) and
common surnames (`smith`, `garcia`, `jordan`) are never reserved, whoever
famous bears them: people are the paying customers, and someone registering
their own name gets it at the normal fee in one transaction. A famous *full*
name has one rightful holder and is reserved (`elonmusk`, `elon-musk`,
`cz-binance`); a bare mononym only when it is not also an ordinary name
(`messi`, `shakira`, `obama` in; `gerrard`, `neville`, `hazard` out). `ronaldo` is in on the same test (Kike,
2026-09-19): a first name elsewhere, one footballer's to anyone searching it. The
filter was a merged list of ~1,100 common first names and surnames across 14
countries plus a hand pass over every bare entry in the people categories.
Brands that happen to be names (`ferrari`, `mercedes`, `alexa`, `claude`)
stay: a brand has one holder.

## Tiers

A name is on the list because of what the admin does with it afterwards.
Tiers are operator policy, not protocol — the constant is a flat set.

| Tier | Disposition | Names |
|---|---|---|
| **HOLD** | Never released as a routine; a `U` here is a decision | 1,514 |
| **AWARD** | `U` to the rightful party on a verified request; never auctioned | 20,904 |
| **AUCTION** | Sold via `A`, proceeds to the treasury | 1,560 |

(Counts are per category and overlap; the deduplicated total is 22,635.)

## Categories

| Tier | File | What | Names + speculative |
|---|---|---|---|
| HOLD | `nimiq-words` | Nimiq, every product and repo word, both joins, the `nirniq`/`nimig` confusables, typo-squats (speculative) | 493 + 13 |
| HOLD | `nimiq-infra` | Explorers, the 25 live validators and pools, NIM exchanges and partners, community channels | 137 + 9 |
| HOLD | `operator`, `protocol-vocabulary`, `roles`, `app-routes` | The 2026-09-07 draft's sections, unchanged | 217 |
| HOLD | `government` | Offices, parliaments, ministries, tax agencies, regulators, central banks, police, militaries | 424 |
| HOLD | `scam-bait` | Drainer and phishing vocabulary (`giveaway`, `presale`, `wallet-recovery`) | 221 |
| AWARD | `people-*` (10 files) | Politics, business, crypto figures, creators, football, basketball, US sports, other sports, music, film and TV, icons; religious leaders all speculative | 7,066 + 184 |
| AWARD | `crypto-*` (7 files) | Exchanges, DEXes, chains, tokens, protocols, infra, wallets | 4,573 |
| AWARD | `companies-global`, `consumer`, `tech-products`, `ai`, `platforms`, `big-tech` | Index constituents and big private companies, consumer brands, products, AI labs | 3,493 |
| AWARD | `finance`, `banks-payments`, `media`, `telecom-travel`, `gaming`, `sports-orgs` | Industry brands and every club and franchise in the major leagues, and the fan nicknames (`barca`, `juve`, `gooners`) | 4,377 + 807 |
| AWARD | `intl-orgs`, `universities`, `parties` | Institutions | 718 |
| AWARD | `nimiq-team` | The team's Telegram handles, gifted by `U` — the one deliberate exception to the personal-names rule (`martin`, `stefan`, `micha`) | 26 |
| AUCTION | `countries`, `cities`, `crypto-vocabulary`, `premium-generics` | Places and generics | 1,560 |

Each file's `source` says what it was built from and whether that was a live
fetch or knowledge: CoinGecko and DefiLlama APIs, the nimiq GitHub org and
validators API, and Wikipedia were fetched on 2026-09-18; most rankings of
people and brands were compiled from knowledge, and say so.

**Where the data was cut.** Crypto sources were thresholded rather than taken
whole — every DefiLlama deployment and dead exchange would reserve thousands
of ordinary words for projects nobody will claim: CoinGecko exchanges with
≥1 BTC daily volume or trust score ≥5, DEXes with ≥$1M TVL, the top 500
protocols by TVL, the top 500 tokens, stablecoins over $10M. Version, chain
and pool-type suffixes (`-v3`, `clmm`) are dropped, and so are invented
suffixes (`bershkafashion`, `calm-app`) and legal forms (`dowinc`).

## Not on the list

- **Personal names** — above.
- **Nimiq team members' legal names and GitHub handles** — the team is
  reserved by the Telegram handles it uses daily (`nimiq-team`), Kike's list,
  2026-09-19; the 27-person public-source draft was dropped.
- **Slurs** — an open question for Kike: reserving one puts it in a public
  file; the alternative is §8.5's interface layer hiding it.
- **Blanket variants** (`elonmusk-official`) — they multiply without end, and
  the interface layer owns them.
- **Names the protocol cannot hold** — `g2esports`, `n26bank`, `plus500`,
  `1inch` break §4.2 and are unregistrable by anyone.
- **Confusables beyond the Nimiq family** — §4.2 and the interface layer.

## Changing it

1. Edit or add a category file (`tier`, `title`, `source`, `names`, optional
   `speculative`); run `pnpm gen:reserved` in `packages/core`.
2. Move the count and sha256 pin in `constants.test.ts` and the
   `configFingerprint` baseline in `packages/indexer/src/store.test.ts`.
3. `pnpm build && pnpm typecheck && pnpm test`.
4. A deployed database built under another list refuses to resume
   (`configFingerprint`), and `rebuild --from-log` refuses too — its cursor
   check runs first — so a list change on a live box is a drop and resync.
5. Free until `LAUNCH_HEIGHT`; after it, an addition is a spec revision
   (§10.6).
