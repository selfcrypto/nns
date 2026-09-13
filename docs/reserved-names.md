# `RESERVED_NAMES` — the launch list

**Status: DRAFT, 2026-09-07. Not applied.** The shipped constant is still the
58-entry battery list (`packages/core/reserved-names.json`). This document is
the operator's review copy: every entry below passes `core`'s
`validateNameSyntax` (§4.1 rules 1–5, §4.2, 5–24 characters), none is a
duplicate, and all 58 shipped entries are kept. Applying it is the last section.

Count: **1011** names.

## Why the list is shaped this way

§4.1's rule is *err long*: a name left off is anyone's the block after
`LAUNCH_HEIGHT`, forever; a name reserved by mistake comes back with one `U`.
Since r28 there is a third exit — `A`, the admin's auction of a still-reserved
name — so a reservation is never a loss, only a delay with a chosen ending.
That ending is what the tiers are. **A name is on the list because of what the
admin will do with it afterwards**, and the tier says which:

| Tier | Disposition after launch | Who is on it |
|---|---|---|
| **HOLD** | Never released as a routine. A `U` here is a decision, not a ticket. | Nimiq and operator brands, protocol vocabulary, roles a scammer would impersonate, the app's own route words |
| **AWARD** | `U` to the rightful party's address, on a verified request. Never auctioned. | Exchanges, wallets, chains and projects, payment networks and banks, big tech and consumer brands |
| **AUCTION** | Sold via `A`, starting price ≥ `MIN_PRICE`, proceeds to the treasury. | Premium generics — the words a day-one script would take first |

Two things the tiers are not: they are not protocol (the JSON is flat and the
constant is a set), and they are not a promise — an AUCTION name can be awarded
and an AWARD name can sit unclaimed forever. They are the operator's own
policy, written down so the admin key is not asked to invent it per request.

## Rules the entries follow

- **5–24 characters only.** 1–4 character names are reserved *by rule* (r18)
  and belong on the list nowhere; `okx`, `mexc`, `visa`, `wise`, `bank`,
  `web3`, `defi`, `nfts` are all already held.
- **Exact lowercase, no normalisation** — the protocol never lowercases, so the
  list holds the one spelling a user would type.
- **Hyphen variants only where the real name is two words** (`crypto-com`,
  `trust-wallet`, `cash-app`, `wells-fargo`) **or for the Nimiq family**,
  where both spellings are impersonation surfaces. A blanket hyphenated copy of
  every entry would double the list for names nobody would type.
- **Confusables only for the Nimiq family.** §4.2 leaves multigraphs (`rn`/`m`)
  to the interface layer, and that stays; but `nirniq` reads as `nimiq` in a
  proportional font and costs one line. `nimig` (`q`/`g`) likewise. Nothing
  else gets confusables — the interface layer owns the general case.
- **Names the protocol cannot hold are simply absent.** The draft tried
  `1inch`, `erc20`, `ten31` (boundary `0`/`1`), `web3wallet` (interior
  digit); `core` rejects them, so no reservation is needed — they can never be
  registered by anyone.

## Deliberately not on the list

- **Personal first names** (`david`, `maria`, `james`). The product is
  "`kike` instead of an address"; reserving first names means the person named
  that has to outbid a squatter at an admin auction instead of registering it.
  §6.2's first-come rule is the fair one here.
- **Lifestyle generics** (`pizza`, `coffee`, `football`). Not a scam surface
  and not the words a land-grab script starts with. The AUCTION tier is
  money, finance and the crypto vocabulary — where the squatter's windfall is
  largest and where an "official" reading is plausible.
- **Slurs and abuse words.** An open question for Kike, not a default: the
  only way to keep one out of the registry is to reserve it, which puts it in a
  public source file; the alternative is §8.5's interface layer hiding it.
  Neither is chosen here.
- **Political and religious names.** Same reasoning as first names: the
  protocol should not be the arbiter.
- **Country and city names.** Squatting risk is real but the set is unbounded;
  can be added as an AUCTION sub-tier if Kike wants it.

## The live demo

Three names registered on the public deployment are in the draft:
`nimiq` (an admin award, already reserved), `nimiqnames` and `satoshi`.
Applying the list to the *running* deployment flips the last two to
`NAME_RESERVED` on rebuild — the demo's `LAUNCH_HEIGHT` is in the past. The
real launch does not have this problem: the second freeze starts an empty
database at a future height.

## HOLD

### Nimiq brand and products (77)

Nimiq Pay, Hub, Wallet, Keyguard, OASIS, Fastspot, Albatross, the Foundation;
every product suffix a scammer would append; the `rn`/`m` and `q`/`g`
confusables.

`albatross` `fast-spot` `fastspot` `keyguard` `nimig` `nimigpay` `nimiq`
`nimiq-app` `nimiq-chat` `nimiq-foundation` `nimiq-hub` `nimiq-labs`
`nimiq-names` `nimiq-network` `nimiq-oasis` `nimiq-official` `nimiq-pay`
`nimiq-safe` `nimiq-support` `nimiq-team` `nimiq-wallet` `nimiq-watch`
`nimiqadmin` `nimiqapp` `nimiqbank` `nimiqblog` `nimiqcard` `nimiqcash`
`nimiqchat` `nimiqcoin` `nimiqcommunity` `nimiqdao` `nimiqdev` `nimiqdevs`
`nimiqexplorer` `nimiqforum` `nimiqfoundation` `nimiqfund` `nimiqhelp`
`nimiqhub` `nimiqkeyguard` `nimiqlabs` `nimiqminer` `nimiqmining`
`nimiqmobile` `nimiqname` `nimiqnames` `nimiqnetwork` `nimiqnews` `nimiqoasis`
`nimiqofficial` `nimiqpay` `nimiqpayments` `nimiqpays` `nimiqpool` `nimiqq`
`nimiqs` `nimiqsafe` `nimiqshop` `nimiqstake` `nimiqstaking` `nimiqstore`
`nimiqsupport` `nimiqswap` `nimiqteam` `nimiqtoken` `nimiqvalidator`
`nimiqwallet` `nimiqwatch` `nimiqx` `nirniq` `nirniqhub` `nirniqnames`
`nirniqpay` `nirniqwallet` `oasis` `paynimiq`

### Operator (17)

SelfCrypto, Sonar, and the `nns` prefix — which a 3-letter rule already holds
bare, but not as a prefix.

`delegated` `nns-admin` `nns-official` `nns-protocol` `nns-support` `nns-team`
`nnsadmin` `nnsnames` `nnsofficial` `nnsprotocol` `nnssupport` `nnsteam`
`self-crypto` `selfcrypto` `sonar` `sonar-tech` `sonartech`

### Protocol vocabulary (55)

Words the spec, the API and the app use for the protocol's own parts.
`treasury` or `resolver` as a registered name is a phishing page.

`anchor` `auction` `auctions` `blockchain` `bridge` `burn-address`
`burnaddress` `checkpoint` `checkpoints` `commission` `consensus` `delegate`
`delegates` `devnet` `expired` `expiry` `explorer` `faucet` `genesis`
`governance` `grace` `indexer` `mainnet` `marketplace` `mempool` `merkle`
`network` `nodes` `offer` `offers` `params` `pending` `proof` `proofs`
`protocol` `quorum` `register` `registrar` `registration` `registry` `relay`
`reserve` `reserved` `resolver` `resolvers` `settlement` `stakers` `staking`
`testnet` `transfer` `treasury` `unreserve` `unreserved` `validator`
`validators`

### Roles and impersonation (109)

The words every name system reserves: support, security, no-reply,
verification, billing — plus authorities a charity or tax scam wears. Includes
`example`, `undefined`, `localhost`, which exist to be printed in docs and
error paths.

`abuse` `account` `accounts` `admin` `administrator` `admins` `alert` `alerts`
`anonymous` `audit` `authentic` `billing` `bounty` `bug-bounty` `bugbounty`
`compliance` `contact` `contacts` `coredev` `customer` `customer-service`
`customer-support` `customers` `customerservice` `customersupport` `default`
`dev-team` `developer` `developers` `devteam` `donotreply` `engineering`
`escrow` `europol` `everyone` `example` `founder` `founders` `genuine`
`gobierno` `government` `guest` `hacienda` `health` `helpdesk` `hostmaster`
`interpol` `invoice` `invoices` `legal` `localhost` `login` `logout`
`maintainer` `master` `metrics` `moderator` `moderators` `monitor` `no-reply`
`nobody` `noreply` `notification` `notifications` `official` `officials`
`operations` `operator` `original` `owner` `owners` `password` `payment`
`payments` `police` `policy` `postmaster` `privacy` `private` `public`
`red-cross` `redcross` `refund` `refunds` `sales` `sample` `security`
`service` `services` `signin` `signup` `staff` `status` `superuser` `support`
`sysadmin` `system` `terms` `testing` `trusted` `undefined` `unicef`
`united-nations` `unitednations` `unknown` `verification` `verified` `verify`
`webmaster`

### App and web routes (37)

If `nimiqnames.com/<name>` ever becomes a profile page, these are the paths it
already needs. Cheap now, a routing conflict later.

`about` `apps` `assets` `callback` `changelog` `dashboard` `download`
`downloads` `explore` `favicon` `graphql` `hello` `images` `inbox` `index`
`install` `litepaper` `manifest` `oauth` `profile` `profiles` `release`
`releases` `resolve` `roadmap` `robots` `search` `settings` `sitemap` `specs`
`static` `update` `updates` `webhook` `webhooks` `welcome` `whitepaper`


## AWARD

### Exchanges, DEXes, on-ramps, data sites (119)

Where NIM trades or swaps first (KuCoin, HitBTC, AscendEx, Gate.io, Fastspot,
Moonpay, Simplex), then the rest of the top tier. Awarded on a request from
the operator of that brand.

`alchemypay` `ascendex` `balancer` `bancor` `banxa` `binance` `bingx` `bisq`
`bitbuy` `bitfinex` `bitget` `bithumb` `bitkub` `bitmart` `bitmex` `bitpanda`
`bitpay` `bitrue` `bitso` `bitstamp` `bitvavo` `blockchair` `btcmarkets`
`btcpay` `btcpayserver` `bybit` `cex-io` `cexio` `changelly` `changenow`
`coinbase` `coindcx` `coinex` `coingate` `coingecko` `coinify` `coinjar`
`coinlist` `coinmarketcap` `coinone` `coinpaprika` `coinpayments` `coinspot`
`compound` `cowswap` `crypto-com` `cryptocom` `curvefinance` `defillama`
`deribit` `dexscreener` `dextools` `digifinex` `etherscan` `etoro` `exmo`
`exolix` `fixedfloat` `gate-io` `gateio` `gemini` `godex` `hitbtc` `hodl-hodl`
`hodlhodl` `huobi` `hyperliquid` `jupiter` `kraken` `kucoin` `kyber`
`kyberswap` `latoken` `lbank` `letsexchange` `lidofinance` `livecoinwatch`
`localbitcoins` `makerdao` `mempool-space` `mempoolspace` `mercuryo` `messari`
`moonpay` `nowpayments` `okcoin` `oneinch` `onramper` `opennode` `osmosis`
`pancakeswap` `paraswap` `paxful` `phemex` `poloniex` `probit` `rampnetwork`
`raydium` `robinhood` `robosats` `sardine` `shakepay` `sideshift` `simpleswap`
`simplex` `stealthex` `sushiswap` `swapzone` `swyftx` `thorswap` `tradingview`
`transak` `uniswap` `upbit` `utrust` `wazirx` `webull` `whitebit` `zebpay`

### Wallets (83)

Software, hardware and browser wallets, and the generic `wallet` family —
`mywallet`, `cryptowallet` are the names a fake-wallet page would want.

`arculus` `argent` `atomic-wallet` `atomicwallet` `backpack` `bcvault`
`binancewallet` `bitbox` `bitcoin-wallet` `bitcoinwallet` `bitgetwallet`
`bitkeep` `bitkey` `blockstream` `blockstreamgreen` `bluewallet` `bravewallet`
`cake-wallet` `cakewallet` `coinbase-wallet` `coinbasewallet` `coinomi`
`coldcard` `crypto-wallet` `cryptowallet` `cypherock` `dcent` `edgewallet`
`electrum` `ellipal` `enkrypt` `exodus` `gnosis-safe` `gnosissafe`
`greenwallet` `guarda` `hardware-wallet` `hardwarewallet` `imtoken` `keplr`
`keystone` `leather` `ledger` `ledger-live` `ledgerlive` `mathwallet`
`metamask` `monerujo` `muunwallet` `my-wallet` `mycrypto` `myetherwallet`
`mywallet` `ngrave` `nunchuk` `okxwallet` `phantom` `rabby` `rainbow`
`rainbowwallet` `safepal` `safewallet` `samourai` `solflare` `sparrow`
`sparrowwallet` `tangem` `tokenpocket` `trezor` `trezor-suite` `trezorsuite`
`trust-wallet` `trustwallet` `unchained` `unisat` `uniswapwallet` `wallet`
`walletconnect` `wallets` `wasabi` `xdefi` `xverse` `zengo`

### Chains, coins, projects, people (136)

The major chains and stablecoins, infrastructure (Infura, Alchemy, IPFS
hosts), NFT and social platforms, the other name services, and the two people
every chain reserves.

`alchemy` `algorand` `ankr` `aptos` `arbitrum` `arkham` `arweave` `avalanche`
`bankless` `binance-coin` `binancecoin` `bitcoin` `bitcoin-cash`
`bitcoin-foundation` `bitcoin-magazine` `bitcoincash` `bitcoinfoundation`
`bitcoinmagazine` `bitrefill` `blast` `bnb-chain` `bnbchain` `bonfida`
`buterin` `cardano` `celestia` `chainalysis` `chainlink` `chainstack` `circle`
`coincorner` `coindesk` `cointelegraph` `consensys` `cosmos` `decrypt`
`dfinity` `dogecoin` `duneanalytics` `elliptic` `ens-domains` `ensdomains`
`ethena` `ethereum` `ethereum-classic` `ethereum-foundation` `ethereumclassic`
`ethereumfoundation` `fantom` `farcaster` `filebase` `filecoin` `floki`
`foundation` `glassnode` `gnosis` `graphprotocol` `handshake` `hedera`
`infura` `injective` `internetcomputer` `kadena` `kaspa` `kusama`
`lensprotocol` `lightning` `lightning-network` `lightningnetwork` `lightspark`
`linea` `litecoin` `magic-eden` `magiceden` `mantle` `monero` `moralis`
`nakamoto` `namecoin` `nansen` `opensea` `optimism` `ordinals` `paxos`
`pepecoin` `pinata` `polkadot` `polygon` `protocol-labs` `protocollabs`
`quicknode` `rarible` `ripple` `riverfinancial` `runes` `satoshi`
`satoshi-nakamoto` `satoshinakamoto` `scroll` `shiba` `shiba-inu` `shibainu`
`solana` `sonic` `space-id` `spaceid` `stacks` `starknet` `starkware`
`stellar` `strike` `superrare` `swanbitcoin` `taproot` `tether` `tezos`
`the-block` `the-graph` `theblock` `thegraph` `thorchain` `toncoin` `tron`
`tronix` `unstoppable` `unstoppable-domains` `unstoppabledomains` `usd-coin`
`usdcoin` `vitalik` `vitalikbuterin` `warpcast` `worldchain` `worldcoin`
`zcash` `zksync`

### Payment networks and banks (126)

Card networks, wallets, bank-transfer schemes (Bizum, TWINT, SEPA instant
brands), the largest banks in Spain, Switzerland, the EU, the UK and the US,
and the central banks. A bank name resolving to an address is a wire-fraud
page.

`abn-amro` `abnamro` `adyen` `alipay` `american-express` `americanexpress`
`amina` `apple-pay` `applepay` `banco-de-espana` `bancodeespana` `bancolombia`
`bank-of-america` `bank-of-england` `bankinter` `bankofamerica`
`bankofengland` `banorte` `barclays` `bitcoin-suisse` `bitcoinsuisse` `bizum`
`blackrock` `bnp-paribas` `bnpparibas` `bradesco` `bundesbank` `caixa`
`caixabank` `capital-one` `capitalone` `cash-app` `cashapp` `chase` `checkout`
`chime` `citibank` `citigroup` `commerzbank` `credit-suisse` `creditagricole`
`creditsuisse` `danskebank` `deutsche-bank` `deutschebank` `diners-club`
`dinersclub` `discover` `europeancentralbank` `federal-reserve`
`federalreserve` `fidelity` `giropay` `goldman-sachs` `goldmansachs`
`google-pay` `googlepay` `ideal` `ing-direct` `ingdirect` `intesasanpaolo`
`itau` `jp-morgan` `jpmorgan` `juliusbaer` `klarna` `lloyds` `mastercard`
`mercado-pago` `mercadopago` `mobilepay` `moneygram` `monzo` `morgan-stanley`
`morganstanley` `natwest` `neteller` `nordea` `nubank` `openbank` `payoneer`
`paypal` `paysafe` `paysafecard` `postfinance` `rabobank` `raiffeisen`
`remitly` `revolut` `sabadell` `samsung-pay` `samsungpay` `santander`
`scotiabank` `skrill` `societegenerale` `sofort` `square` `starling` `stripe`
`swedbank` `swift` `swish` `swissquote` `sygnum` `td-bank` `tdbank`
`transferwise` `truist` `twint` `unicredit` `unionpay` `us-bank` `usbank`
`vanguard` `venmo` `vipps` `wechat` `wechat-pay` `wechatpay` `wells-fargo`
`wellsfargo` `western-union` `westernunion` `world-bank` `worldbank`

### Big tech and consumer brands (129)

Platforms, AI labs, hardware, developer infrastructure, operating systems,
mail providers, the largest Spanish retailers and telcos, and the games a
teenager would register.

`activision` `adidas` `adobe` `airbnb` `alibaba` `aliexpress` `alphabet`
`amazon` `amazon-pay` `amazonaws` `amazonpay` `android` `anthropic` `apple`
`arch-linux` `archlinux` `azure` `bitbucket` `blizzard` `bloomberg` `booking`
`chatgpt` `chrome` `cisco` `claude` `cloudflare` `coca-cola` `cocacola`
`debian` `deepmind` `digitalocean` `discord` `disney` `docker` `dropbox`
`el-corte-ingles` `elcorteingles` `epic-games` `epicgames` `expedia`
`facebook` `firefox` `forbes` `fortnite` `github` `gitlab` `gmail` `google`
`heroku` `hetzner` `hotmail` `icloud` `inditex` `instagram` `intel` `iphone`
`javascript` `kubernetes` `linkedin` `linux` `macbook` `marvel` `mcdonalds`
`mercadona` `metaplatforms` `microsoft` `minecraft` `movistar` `mozilla`
`netflix` `netlify` `nintendo` `nodejs` `notion` `npmjs` `nvidia` `nytimes`
`openai` `oracle` `outlook` `pepsi` `pinterest` `playstation` `pokemon`
`proton` `protonmail` `python` `reddit` `reuters` `riotgames` `roblox`
`rustlang` `salesforce` `samsung` `shopify` `signal` `slack` `snapchat`
`spacex` `spotify` `stackoverflow` `starbucks` `starlink` `steam` `swisscom`
`t-mobile` `telefonica` `telegram` `tesla` `tiktok` `tmobile` `tutanota`
`twitch` `twitter` `typescript` `ubisoft` `ubuntu` `valve` `vercel` `verizon`
`vodafone` `walmart` `warnerbros` `whatsapp` `wikimedia` `wikipedia` `windows`
`yahoo` `youtube`


## AUCTION

### Premium generics (123)

Money, finance and the crypto vocabulary. `crypto`, `exchange`, `wallet` are
AUCTION only in the sense that their holder is chosen by bid rather than by
being first to script the launch; the operator may keep any of them.

`adult` `agency` `airdrop` `airdrops` `alpha` `asset` `banking` `banks`
`betting` `bitcoins` `bonds` `borrow` `business` `capital` `cash` `casino`
`cloud` `coins` `company` `credit` `crypto` `cryptocurrencies`
`cryptocurrency` `dating` `degen` `diamond` `digital` `email` `energy`
`enterprise` `ether` `events` `exchange` `farming` `fashion` `finance`
`financial` `forex` `funds` `futures` `games` `gaming` `global` `gold` `hotel`
`hotels` `income` `insurance` `internet` `invest` `investing` `investment`
`investments` `investor` `jobs` `lambo` `lending` `loans` `lottery` `market`
`media` `memes` `metaverse` `miner` `miners` `mining` `mobile` `money`
`mortgage` `music` `names` `news` `online` `options` `phone` `photo` `podcast`
`poker` `press` `price` `prices` `profit` `profits` `property` `real-estate`
`realestate` `savings` `secure` `shares` `shopping` `silver` `smart-contract`
`smartcontract` `smartcontracts` `social` `sportsbook` `stake` `startup`
`stock` `stocks` `store` `stream` `streaming` `studio` `swaps` `tickets`
`token` `tokens` `trade` `trader` `trading` `travel` `value` `vault` `vaults`
`venture` `ventures` `video` `wealth` `whale` `whales` `world` `yield`


## Applying it

1. Replace the `names` array in `packages/core/reserved-names.json` with the
   union of the sections above; `pnpm gen:reserved` writes
   `src/reserved-names.ts`.
2. Update the inline pin in `constants.test.ts` (the `published` literal and
   its `toHaveLength(58)`) — the pin is the point, so it moves by hand.
3. `pnpm build && pnpm typecheck && pnpm test`.
4. It is a consensus input: every deployed resolver **rebuilds from empty**
   (a drop and resync), which on the demo forfeits `nimiqnames` and
   `satoshi` as above.
5. Every pass before the launch freeze is the last cheap one. After
   `LAUNCH_HEIGHT`, adding a name is a spec revision (§10.6).
