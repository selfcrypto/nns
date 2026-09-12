# packages/app/docs — the docs section's content

One Markdown file per page of the in-app documentation (`#/docs/<slug>`).
`index.md` fixes the sidebar order and each page's title — and the order is
also the previous/next chain, so it is the one place a page is added, renamed
or moved. This directory is **content only**: the formatter is
`src/lib/docsFormat.ts`, the build step `plugins/docs.ts` (it serves
`virtual:docs`), and the screen `src/screens/Docs.tsx`.

Four things fail the build rather than reaching a reader: an unknown
placeholder key or format, a page listed here with no file, a `.md` file no
`index.md` entry lists (it would be unreachable), and a cross-link to a slug
that is not a page. Cross-links are written as the bare slug —
`[Prices](prices)` — and become `#/docs/prices`.

## Placeholders — a number from `CONSTANTS` is never typed

Every figure that is a protocol constant is written as a placeholder and
filled at build time from `@nns/core`'s `CONSTANTS`, so the second launch
freeze cannot leave a stale number in the docs. The build fails on an
unknown key or an unknown format.

| Placeholder | Renders as | Example |
|---|---|---|
| `{{nim:FEE_BASE}}` | luna → NIM, thousands separator (every §3 amount is a whole NIM since r29) | `400 NIM` |
| `{{fee:7}}` · `{{lifetime:7}}` | the yearly / lifetime fee of a name of that length, `core.feeFor` at `LAUNCH_PRICES` — the band's figure, so `{{fee:7}}` and `{{fee:11}}` render alike | `2,000 NIM` · `20,000 NIM` |
| `{{fees:table}}` | `FEE_MULTIPLIERS` as a Markdown table — length band, multiple, a year, a lifetime | a table |
| `{{n:LONG_BAND_FROM}}` | the first length that pays `FEE_BASE` alone (the last multiplier row's lower edge), so the prose never types 12 | `12` |
| `{{dur:TERM_LENGTH}}` | blocks → approximate duration at ~1 block/s, no `~` of its own (a page that wants one writes it: "every ~{{dur:CHECKPOINT_INTERVAL}}") | `1 year` |
| `{{blocks:TERM_LENGTH}}` | the block count | `31,536,000 blocks` |
| `{{sec:ANCHOR_STALENESS_LIMIT_SEC}}` | seconds → duration | `48 hours` |
| `{{pct:BURN_SHARE_BP}}` | basis points → percent | `20%` |
| `{{n:MAX_NAME_LEN}}` | plain integer | `24` |
| `{{addr:TREASURY_ADDRESS}}` | friendly address, grouped in fours | `NQ28 TKBF …` |
| `{{height:LAUNCH_HEIGHT}}` | grouped integer | `58,842,720` |
| `{{referral:rates}}` | `packages/settlement/referral-rates.json` as a Markdown table — referrer (or *default*), the referrer's rate, the buyer's rebate (or `—`), from height (or *launch* for 0), note | a table |
| `{{referral:default}}` | the default row's referrer rate as a percentage | `4%` |
| `{{referral:rebate}}` | the default row's buyer rebate as a percentage; throws where the row pays none | `4%` |

Two figures are typed on purpose, because they are not constants: the
renewal reminder's **60 days** (`GRACE_PERIOD × 2`, §10.4 — the app derives
it in `states.ts`) and the **64-byte** transaction data limit, which is a
measured Nimiq property (`MAX_DATA_BYTES` mirrors it). `MIN_PRICE` has no
constant — it is `FEE_BASE` in effect at the message's height — so the prose
says "the base price in effect" and cites `{{nim:FEE_BASE}}` as today's.

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
  numbers, except in the reference table.

What is provisional before launch is said once, on the Status page, not on
every page. Nothing operator-private (box addresses, hostnames, tunnels) and
nothing from `docs/status.md`, `docs/audit/` or `docs/decisions.md` is
published here.

## Voice

Second person, short declaratives, the reason beside each rule. Help-centre
clarity with the README's habit of saying why. No marketing adjectives; the
trust bars already carry the claims.
