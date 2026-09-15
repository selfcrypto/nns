# packages/app/docs: the docs section's content

One Markdown file per page of the in-app documentation (`#/docs/<slug>`).
`index.md` fixes the structure: a `## Section` heading opens a section of the
sidebar and each `- slug: Title` under it is a page, in order. The flat order
is also the previous/next chain, so the file is the one place a page is
added, renamed or moved. This directory is **content only**: the formatter
is `src/lib/docsFormat.ts`, the build step `plugins/docs.ts` (it serves
`virtual:docs`), and the screen `src/screens/Docs.tsx`.

Every `##` heading in a page is a subsection: the build gives it an id from
its text (`## Expiry and grace` → `expiry-and-grace`), the sidebar lists it
under the page while that page is open, and `#/docs/prices/expiry-and-grace`
lands on it. Renaming a heading moves its route, so a link to one from
another page is `[grace](prices/expiry-and-grace)` and breaks the build the
day the heading changes, the same way a link to a missing page does.

Five things fail the build rather than reaching a reader: an unknown
placeholder key or format, a page listed in `index.md` with no file, a `.md`
file no `index.md` entry lists (it would be unreachable), a page listed
before any `## Section` heading, and a cross-link to a slug that is not a
page. Cross-links are written as the bare slug, `[Prices](prices)`, and
become `#/docs/prices`.

## Placeholders: a number from `CONSTANTS` is never typed

Every figure that is a protocol constant is written as a placeholder and
filled at build time from `@nimiqnames/core`'s `CONSTANTS`, so the second
launch freeze cannot leave a stale number in the docs. The build fails on an
unknown key or an unknown format.

| Placeholder | Renders as | Example |
|---|---|---|
| `{{nim:FEE_BASE}}` | luna → NIM, thousands separator (every §3 amount is a whole NIM since r29) | `400 NIM` |
| `{{fee:7}}` · `{{lifetime:7}}` | the yearly / lifetime fee of a name of that length, `core.feeFor` at `LAUNCH_PRICES`, so `{{fee:7}}` and `{{fee:11}}` render the band's figure alike | `2,000 NIM` · `20,000 NIM` |
| `{{fees:table}}` | `FEE_MULTIPLIERS` as a Markdown table: length band, multiple, a year, a lifetime | a table |
| `{{n:LONG_BAND_FROM}}` | the first length that pays `FEE_BASE` alone (the last multiplier row's lower edge), so the prose never types 12 | `12` |
| `{{dur:TERM_LENGTH}}` | blocks → approximate duration at ~1 block/s, no `~` of its own (a page that wants one writes it: "every ~{{dur:CHECKPOINT_INTERVAL}}") | `1 year` |
| `{{blocks:TERM_LENGTH}}` | the block count | `31,536,000 blocks` |
| `{{sec:ANCHOR_STALENESS_LIMIT_SEC}}` | seconds → duration | `48 hours` |
| `{{dur:RENEW_WINDOW}}` | how long before expiry the renewal reminder starts, `GRACE_PERIOD × 2`, derived from `states.ts` rather than `CONSTANTS` because it is the app's rule, not a §3 figure | `60 days` |
| `{{pct:BURN_SHARE_BP}}` | basis points → percent | `20%` |
| `{{n:MAX_NAME_LEN}}` | plain integer | `24` |
| `{{addr:TREASURY_ADDRESS}}` | friendly address, grouped in fours | `NQ28 TKBF …` |
| `{{height:LAUNCH_HEIGHT}}` | grouped integer | `58,842,720` |
| `{{referral:rates}}` | `packages/settlement/referral-rates.json` as a Markdown table: referrer (or *default*), the referrer's rate, the buyer's rebate (or *none*), from height (or *launch* for 0), note | a table |
| `{{referral:default}}` | the default row's referrer rate as a percentage | `4%` |
| `{{referral:rebate}}` | the default row's buyer rebate as a percentage; throws where the row pays none | `4%` |

One figure is typed on purpose: the **64-byte** transaction data limit, a
measured Nimiq property rather than an NNS constant (`MAX_DATA_BYTES` mirrors
it). `MIN_PRICE` has no constant, being `FEE_BASE` in effect at the message's
height, so the prose says "the base price in effect" and cites
`{{nim:FEE_BASE}}` as today's.

The renewal reminder's window was typed here until 2026-09-16, as "60 days".
It is `GRACE_PERIOD × 2`, and a compressed era cuts `GRACE_PERIOD` to a day,
so the live build said 60 days about a window that was two. Anything a
constant moves gets a placeholder, including the ones derived from a
constant.

## Wording rules that bind these pages

The docs teach the vocabulary the app uses, so `docs/app-states.md` §5
applies here too:

- A proven answer from one resolver is never "unverified". The proof
  verified; what is absent is a second party's corroboration.
- Alarm words (stop, do not pay, divergence, red) only for the halting
  failures. Everything else is "couldn't check" or pending depth.
- Grace is neither "gone" nor "available soon". It is renewable and not
  registrable.
- A delegated answer is never described as proven. NNS never says whether a
  subdomain exists; only its host can.
- The Market's custody is said plainly: the operator holds the money between
  a payment and its settlement. Not "escrow".
- Heights are shown as approximate durations or `≈` dates, never as block
  numbers, except in the constants table.
- **One word per thing, the app's word.** A fixed-price listing is a
  **sale** (the protocol's `O` and the verdict tokens keep "offer", in code
  face, where they name the message). The §8.6 delegate is a **host**, never
  a resolver, which is a different thing. A tab, a tile and a group are named
  exactly as `wording.ts` spells them (**My Names**, **Subdomain Host**,
  **Routing & Records**), and a line the app says is quoted verbatim.
  `docsPages.test.ts` pins the quotes it can.

What is provisional before launch is said once, on the Status page, not on
every page. Nothing operator-private (box addresses, hostnames, tunnels) and
nothing from the maintainer's working notes is published here.

## Voice

Second person, short declaratives, the reason beside each rule. Help-centre
clarity with the README's habit of saying why. No marketing adjectives; the
trust bars already carry the claims.

**No em dash splits a sentence, and no semicolon joins two.** A full stop,
a comma, a colon, or brackets where brackets earn it, and `none` or `n/a`
where a table cell has no value. The rule is the app's (`src/lib/wording.ts`,
2026-09-14) and these pages are read in the same session as the screens, so
one voice or neither. It is pinned by `docsPages.test.ts`, which fails on a
`—` in any file here. The dash was never the problem on its own: it licenses
a second clause restating the first, and taking it away forces the sentence
to end. A fact is said once, on the page it belongs to, and linked from the
others.
