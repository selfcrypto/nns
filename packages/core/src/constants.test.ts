import { describe, expect, it } from 'vitest'
import { parseAddress } from './address.js'
import { CONSTANTS, LUNA_PER_NIM, feeMultiplier } from './constants.js'
import { validateNameSyntax } from './name.js'

describe('CONSTANTS — §3', () => {
  it('is frozen, so nothing downstream can edit a protocol rule at runtime', () => {
    expect(Object.isFrozen(CONSTANTS)).toBe(true)
  })

  it('states every amount in luna, matching the NIM figures §3 prints', () => {
    expect(LUNA_PER_NIM).toBe(100_000n)
    expect(CONSTANTS.FEE_BASE).toBe(40_000_000n) //          400 NIM
    expect(CONSTANTS.PRICE_FLOOR).toBe(100_000n) //         1 NIM
    expect(CONSTANTS.PRICE_CEILING).toBe(10_000_000_000n) // 100,000 NIM
  })

  it('keeps the launch prices inside the governance bounds they are subject to', () => {
    expect(CONSTANTS.FEE_BASE).toBeGreaterThanOrEqual(CONSTANTS.PRICE_FLOOR)
    expect(CONSTANTS.FEE_BASE).toBeLessThanOrEqual(CONSTANTS.PRICE_CEILING)
    expect(CONSTANTS.COMMISSION_RATE).toBeLessThanOrEqual(CONSTANTS.COMMISSION_CEILING)
  })

  it('prices every length from FEE_BASE over the seven §10.1 rows', () => {
    // The table as §3 prints it, one assertion per row edge. Frozen: a P
    // moves FEE_BASE, never a multiplier (§10.6).
    const rows: Array<[number, bigint]> = [
      [1, 200n],
      [2, 200n],
      [3, 100n],
      [4, 50n],
      [5, 25n],
      [6, 10n],
      [7, 5n],
      [11, 5n],
      [12, 1n],
      [CONSTANTS.MAX_NAME_LEN, 1n],
    ]
    for (const [length, times] of rows) expect(feeMultiplier(length), `length ${length}`).toBe(times)
    // The yearly figures the spec quotes, in NIM (§10.1): $5 at the open
    // bands' top, and the released short names above it.
    const nim = (length: number): bigint => (CONSTANTS.FEE_BASE * feeMultiplier(length)) / LUNA_PER_NIM
    expect([nim(2), nim(3), nim(4), nim(5), nim(6), nim(8), nim(12)]).toEqual([
      80_000n,
      40_000n,
      20_000n,
      10_000n,
      4_000n,
      2_000n,
      400n,
    ])
  })

  it('has no band outside 1…MAX_NAME_LEN — a name §4.1 rejects is never priced', () => {
    expect(() => feeMultiplier(0)).toThrow(RangeError)
    expect(() => feeMultiplier(CONSTANTS.MAX_NAME_LEN + 1)).toThrow(RangeError)
    expect(() => feeMultiplier(1.5)).toThrow(RangeError)
    // Rows ascend and the last one ends exactly at the ceiling, so every
    // length in range has exactly one row.
    const edges = CONSTANTS.FEE_MULTIPLIERS.map((row) => row.upTo)
    expect(edges).toEqual([...edges].sort((a, b) => a - b))
    expect(edges.at(-1)).toBe(CONSTANTS.MAX_NAME_LEN)
  })

  it('prices a lifetime at ten yearly fees and a hundred terms, as a plain height (§10.4)', () => {
    expect(CONSTANTS.LIFETIME_MULTIPLIER).toBe(10n)
    expect(CONSTANTS.LIFETIME_TERMS).toBe(100)
    // A century out from any height the chain can reach stays a safe integer
    // and a u64 — the expiry needs no sentinel and §8.1 encodes it as ever.
    const lifetime = CONSTANTS.LIFETIME_TERMS * CONSTANTS.TERM_LENGTH
    expect(lifetime).toBe(3_153_600_000)
    expect(Number.isSafeInteger(CONSTANTS.LAUNCH_HEIGHT + lifetime)).toBe(true)
  })

  it('cannot use a DUST_VALUE of 0 — the network rejects it (§5.4)', () => {
    expect(CONSTANTS.DUST_VALUE).toBeGreaterThan(0n)
  })

  it('caps D below the global data ceiling, so it keeps the same margin (§6 D)', () => {
    expect(CONSTANTS.MAX_DELEGATE_MESSAGE_BYTES).toBeLessThan(CONSTANTS.MAX_DATA_BYTES)
  })

  it('states the sizes §6 gives its largest messages', () => {
    const prefix = CONSTANTS.PROTOCOL_ID.length + 1 // NNS1 + type character
    // Literal pins: recomputed from constants, but asserted against the numbers
    // §6 prints. The *relation* they feed is the test below, kept separate so a
    // profile that moved one of these still reaches the budget check.
    expect(prefix + CONSTANTS.MAX_NAME_LEN + 1 + CONSTANTS.MAX_REF_LEN + 2).toBe(56) // G with |L
    expect(prefix + CONSTANTS.MAX_NAME_LEN + 2).toBe(31) // N and U with |L
    expect(prefix + CONSTANTS.MAX_NAME_LEN + 1 + 15).toBe(45) // O
    expect(prefix + CONSTANTS.MAX_NAME_LEN + 1 + 15 + 1 + 10).toBe(56) // A
    expect(prefix + 15 + 1 + 5 + 1 + 10).toBe(37) // P
  })

  it('leaves every message type room inside the 64-byte budget (§5.1, §6)', () => {
    const prefix = CONSTANTS.PROTOCOL_ID.length + 1
    const sizes = [
      prefix + CONSTANTS.MAX_NAME_LEN + 1 + CONSTANTS.MAX_REF_LEN + 2, // G with |L
      prefix + CONSTANTS.MAX_NAME_LEN + 1 + 15, // O
      prefix + CONSTANTS.MAX_NAME_LEN + 1 + 15 + 1 + 10, // A
      CONSTANTS.MAX_DELEGATE_MESSAGE_BYTES, // D
    ]
    for (const size of sizes) expect(size).toBeLessThanOrEqual(CONSTANTS.MAX_DATA_BYTES)
  })

  it('orders the name-length thresholds as §4.1 requires', () => {
    expect(CONSTANTS.MIN_NAME_LEN).toBeLessThan(CONSTANTS.MAX_NAME_LEN)
  })

  it('has no recovery timelock — `R` was removed in r20', () => {
    expect(CONSTANTS).not.toHaveProperty('RECOVERY_TIMELOCK')
  })

  it('has no governance rate limit — both were removed in r20 (§10.6)', () => {
    // Deleted rather than widened: a limit loose enough to permit legitimate
    // repricing is loose enough for an attacker to walk through, so the notice
    // window is what protects and these two only implied otherwise. Pinned so
    // reintroducing one is a deliberate edit here as well as in reduce.ts.
    expect(CONSTANTS).not.toHaveProperty('PRICE_MAX_FACTOR')
    expect(CONSTANTS).not.toHaveProperty('PRICE_MIN_INTERVAL')
  })

  it('gives a governance change a full day of notice (§10.6)', () => {
    // The whole of the protection against a hostile P.
    expect(CONSTANTS.GOVERNANCE_DELAY).toBe(86_400)
  })

  it('gives that notice more room than a transfer timelock (§10.6)', () => {
    // Twice XFER_TIMELOCK rather than equal to it as it was through r19, since
    // the notice window is no longer one protection among several.
    //
    // Split out of the literal pin above deliberately: this is a *relation*,
    // and behind `toBe(86_400)` it never ran on a compressed-tempo branch —
    // the literal throws first and takes the relation with it. Every
    // relational assertion in this file has to survive a profile edit, because
    // that branch is where the constants are most likely to be wrong.
    // `scripts/check-tempo-relations.mjs` is the fork-time run of all of them.
    expect(CONSTANTS.GOVERNANCE_DELAY).toBeGreaterThan(CONSTANTS.XFER_TIMELOCK)
  })

  it('keeps the grace period shorter than the term it follows (§7.3, §10.4)', () => {
    // The two move together — r20 shortened both — and a grace period at or
    // past a full term would let a name sit unresolvable for longer than it
    // was ever owned, with §10.4's reminder (GRACE_PERIOD × 2) firing before
    // the registration it warns about.
    expect(CONSTANTS.GRACE_PERIOD).toBeLessThan(CONSTANTS.TERM_LENGTH)
    expect(CONSTANTS.GRACE_PERIOD * 2).toBeLessThan(CONSTANTS.TERM_LENGTH)
  })

  it('lets an offer be cancelled well before it auto-expires (§6 O)', () => {
    expect(CONSTANTS.OFFER_IRREVOCABLE).toBeLessThan(CONSTANTS.OFFER_MAX_LIFETIME)
  })

  it('keeps the anti-sniping extension inside the shortest auction (§6 A, r28)', () => {
    // A late bid moves the end to `bid + AUCTION_EXTENSION`; an extension at
    // or past AUCTION_MIN_DURATION would let one bid define a longer window
    // than the opener was allowed to. A relation, so it survives a tempo
    // profile — `scripts/check-tempo-relations.mjs` runs it at fork time.
    expect(CONSTANTS.AUCTION_EXTENSION).toBeLessThan(CONSTANTS.AUCTION_MIN_DURATION)
    expect(CONSTANTS.AUCTION_MIN_DURATION).toBeLessThan(CONSTANTS.TERM_LENGTH)
  })

  it('equals the mainnet values, field for field', () => {
    // Every value restated as an inline literal — never derived from
    // constants.ts, or an edit there would move both sides. Compressed-tempo
    // testing edits CONSTANTS on a throwaway branch that is never merged;
    // this is the test that
    // fails CI if such an edit ever reaches master. It also covers
    // CHECKPOINT_INTERVAL, which no conformance vector exercises.
    // RESERVED_NAMES is pinned separately, as a set: it is the one entry whose
    // *order* must not be protocol (see below).
    const { RESERVED_NAMES: _reserved, ...values } = CONSTANTS
    expect(values).toStrictEqual({
      // Not a §3 value: the revision these rules claim to be, pinned here so
      // a fold that moves a rule and forgets the number fails on the way out.
      SPEC_REVISION: 30,
      PROTOCOL_ID: 'NNS1',
      MAX_DATA_BYTES: 64,
      MAX_DELEGATE_MESSAGE_BYTES: 58,
      MIN_NAME_LEN: 5,
      MAX_NAME_LEN: 24,
      MAX_LABEL_LEN: 24,
      MAX_HOST_LEN: 30,
      MAX_REF_LEN: 24,
      DUST_VALUE: 1n,
      REFUND_FLOOR: 100_000n,
      LISTING_FEE: 0n,
      FEE_BASE: 40_000_000n, //                400 NIM
      FEE_MULTIPLIERS: [
        { upTo: 2, times: 200n },
        { upTo: 3, times: 100n },
        { upTo: 4, times: 50n },
        { upTo: 5, times: 25n },
        { upTo: 6, times: 10n },
        { upTo: 11, times: 5n },
        { upTo: 24, times: 1n },
      ],
      LIFETIME_MULTIPLIER: 10n,
      LIFETIME_TERMS: 100,
      PRICE_FLOOR: 100_000n, //                  1 NIM
      PRICE_CEILING: 10_000_000_000n, //   100,000 NIM
      COMMISSION_RATE: 250n,
      COMMISSION_CEILING: 1_000n,
      COMMISSION_MAX_STEP: 250n,
      BURN_SHARE_BP: 2_000n,
      BASIS_POINTS: 10_000n,
      GOVERNANCE_DELAY: 86_400,
      XFER_TIMELOCK: 43_200,
      TERM_LENGTH: 31_536_000,
      GRACE_PERIOD: 2_592_000,
      OFFER_IRREVOCABLE: 8_640,
      OFFER_MAX_LIFETIME: 1_296_000,
      AUCTION_MIN_INCREMENT_BP: 500n,
      AUCTION_MIN_DURATION: 86_400,
      AUCTION_EXTENSION: 600,
      CHECKPOINT_INTERVAL: 720,
      SEGMENT_LENGTH: 31_536_000,
      RESOLVER_QUORUM: 2,
      ANCHOR_QUORUM: 2,
      ANCHOR_STALENESS_LIMIT_SEC: 172_800,
      // The launch freeze's second half (2026-08-14). The height and the
      // four addresses are the operator-supplied battery cast; launch
      // replaces them in a second freeze that edits these exact literals
      // (the launch freeze). Compact form: parseAddress strips the spaces.
      LAUNCH_HEIGHT: 58_842_720,
      TREASURY_ADDRESS: 'NQ28TKBFVF67HP8RY8125FNMNNDNTS7QF5G3',
      PROTOCOL_ADDRESS: 'NQ38NKD47ALGYRDQDXL8PARE7JRSJGJDMAU8',
      ADMIN_ADDRESS: 'NQ806XNVJDFYYEKFHMM3UCYKVBLP7H6YFNXS',
      MARKETPLACE_ADDRESS: 'NQ71TPMVQN9DMV6A1HX1NL2Q4CJG5J8MQPTB',
      BURN_ADDRESS: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
    })
  })

  it('keeps the four §3 role addresses pairwise distinct (§3, §10.6)', () => {
    // The check `defineConfig` ran at every startup, asserted once now that
    // the values are literals: the treasury/protocol split is what makes the
    // burn base exact, the admin key is cold while the treasury is hot, and
    // the marketplace is "distinct from both".
    const roles = [
      CONSTANTS.TREASURY_ADDRESS,
      CONSTANTS.PROTOCOL_ADDRESS,
      CONSTANTS.ADMIN_ADDRESS,
      CONSTANTS.MARKETPLACE_ADDRESS,
    ]
    expect(new Set(roles).size).toBe(roles.length)
    // And none of them is the burn address, which decodes to the §8.1
    // "unset" sentinel of 20 zero bytes.
    for (const role of roles) expect(role).not.toBe(parseAddress(CONSTANTS.BURN_ADDRESS))
  })

  it('sits LAUNCH_HEIGHT above the PoS genesis, where batch numbering starts', () => {
    expect(CONSTANTS.LAUNCH_HEIGHT).toBeGreaterThan(3_456_000)
  })

  it('equals the published RESERVED_NAMES list, as a set — order is not protocol (§4.1)', () => {
    // The same inline-literal pin as above, with one difference that is the
    // whole point: it compares **sets**. Rule 6 is exact-match membership, so
    // resorting the constant — or inserting an entry in the middle rather than
    // at the end — must never be a protocol change or a red CI run. Length is
    // asserted against the literal too, which is what catches a duplicate that
    // set comparison alone would swallow.
    const published = [
      'abn-amro', 'abnamro', 'about', 'abuse', 'account', 'accounts', 'activision', 'adidas', 'admin',
      'administrator', 'admins', 'adobe', 'adult', 'adyen', 'agency', 'airbnb', 'airdrop', 'airdrops',
      'albatross', 'alchemy', 'alchemypay', 'alert', 'alerts', 'algorand', 'alibaba', 'aliexpress', 'alipay',
      'alpha', 'alphabet', 'amazon', 'amazon-pay', 'amazonaws', 'amazonpay', 'american-express',
      'americanexpress', 'amina', 'anchor', 'android', 'anonymous', 'anthropic', 'apple', 'apple-pay',
      'applepay', 'aptos', 'arbitrum', 'arch-linux', 'archlinux', 'arculus', 'argent', 'arkham', 'arweave',
      'ascendex', 'asset', 'assets', 'atomic-wallet', 'atomicwallet', 'auction', 'auctions', 'audit',
      'authentic', 'avalanche', 'azure', 'backpack', 'balancer', 'banco-de-espana', 'bancodeespana',
      'bancolombia', 'bancor', 'bank-of-america', 'bank-of-england', 'banking', 'bankinter', 'bankless',
      'bankofamerica', 'bankofengland', 'banks', 'banorte', 'banxa', 'barclays', 'bcvault', 'betting',
      'billing', 'binance', 'binance-coin', 'binancecoin', 'binancewallet', 'bingx', 'bitbox', 'bitbucket',
      'bitbuy', 'bitcoin', 'bitcoin-cash', 'bitcoin-foundation', 'bitcoin-magazine', 'bitcoin-suisse',
      'bitcoin-wallet', 'bitcoincash', 'bitcoinfoundation', 'bitcoinmagazine', 'bitcoins', 'bitcoinsuisse',
      'bitcoinwallet', 'bitfinex', 'bitget', 'bitgetwallet', 'bithumb', 'bitkeep', 'bitkey', 'bitkub',
      'bitmart', 'bitmex', 'bitpanda', 'bitpay', 'bitrefill', 'bitrue', 'bitso', 'bitstamp', 'bitvavo',
      'bizum', 'blackrock', 'blast', 'blizzard', 'blockchain', 'blockchair', 'blockstream',
      'blockstreamgreen', 'bloomberg', 'bluewallet', 'bnb-chain', 'bnbchain', 'bnp-paribas', 'bnpparibas',
      'bonds', 'bonfida', 'booking', 'borrow', 'bounty', 'bradesco', 'bravewallet', 'bridge', 'btcmarkets',
      'btcpay', 'btcpayserver', 'bug-bounty', 'bugbounty', 'bundesbank', 'burn-address', 'burnaddress',
      'business', 'buterin', 'bybit', 'caixa', 'caixabank', 'cake-wallet', 'cakewallet', 'callback',
      'capital', 'capital-one', 'capitalone', 'cardano', 'cash-app', 'cashapp', 'casino', 'celestia',
      'cex-io', 'cexio', 'chainalysis', 'chainlink', 'chainstack', 'changelly', 'changelog', 'changenow',
      'chase', 'chatgpt', 'checkout', 'checkpoint', 'checkpoints', 'chime', 'chrome', 'circle', 'cisco',
      'citibank', 'citigroup', 'claude', 'cloud', 'cloudflare', 'coca-cola', 'cocacola', 'coinbase',
      'coinbase-wallet', 'coinbasewallet', 'coincorner', 'coindcx', 'coindesk', 'coinex', 'coingate',
      'coingecko', 'coinify', 'coinjar', 'coinlist', 'coinmarketcap', 'coinomi', 'coinone', 'coinpaprika',
      'coinpayments', 'coins', 'coinspot', 'cointelegraph', 'coldcard', 'commerzbank', 'commission',
      'company', 'compliance', 'compound', 'consensus', 'consensys', 'contact', 'contacts', 'coredev',
      'cosmos', 'cowswap', 'credit', 'credit-suisse', 'creditagricole', 'creditsuisse', 'crypto',
      'crypto-com', 'crypto-wallet', 'cryptocom', 'cryptocurrencies', 'cryptocurrency', 'cryptowallet',
      'curvefinance', 'customer', 'customer-service', 'customer-support', 'customers', 'customerservice',
      'customersupport', 'cypherock', 'danskebank', 'dashboard', 'dating', 'dcent', 'debian', 'decrypt',
      'deepmind', 'default', 'defillama', 'degen', 'delegate', 'delegated', 'delegates', 'deribit',
      'deutsche-bank', 'deutschebank', 'dev-team', 'developer', 'developers', 'devnet', 'devteam',
      'dexscreener', 'dextools', 'dfinity', 'diamond', 'digifinex', 'digital', 'digitalocean', 'diners-club',
      'dinersclub', 'discord', 'discover', 'disney', 'docker', 'dogecoin', 'donotreply', 'download',
      'downloads', 'dropbox', 'duneanalytics', 'edgewallet', 'el-corte-ingles', 'elcorteingles', 'electrum',
      'ellipal', 'elliptic', 'email', 'energy', 'engineering', 'enkrypt', 'ens-domains', 'ensdomains',
      'enterprise', 'epic-games', 'epicgames', 'escrow', 'ethena', 'ether', 'ethereum', 'ethereum-classic',
      'ethereum-foundation', 'ethereumclassic', 'ethereumfoundation', 'etherscan', 'etoro',
      'europeancentralbank', 'europol', 'events', 'everyone', 'example', 'exchange', 'exodus', 'exolix',
      'expedia', 'expired', 'expiry', 'explore', 'explorer', 'facebook', 'fantom', 'farcaster', 'farming',
      'fashion', 'fast-spot', 'fastspot', 'faucet', 'favicon', 'federal-reserve', 'federalreserve',
      'fidelity', 'filebase', 'filecoin', 'finance', 'financial', 'firefox', 'fixedfloat', 'floki', 'forbes',
      'forex', 'fortnite', 'foundation', 'founder', 'founders', 'funds', 'futures', 'games', 'gaming',
      'gate-io', 'gateio', 'gemini', 'genesis', 'genuine', 'giropay', 'github', 'gitlab', 'glassnode',
      'global', 'gmail', 'gnosis', 'gnosis-safe', 'gnosissafe', 'gobierno', 'godex', 'goldman-sachs',
      'goldmansachs', 'google', 'google-pay', 'googlepay', 'governance', 'government', 'grace',
      'graphprotocol', 'graphql', 'greenwallet', 'guarda', 'guest', 'hacienda', 'handshake',
      'hardware-wallet', 'hardwarewallet', 'health', 'hedera', 'hello', 'helpdesk', 'heroku', 'hetzner',
      'hitbtc', 'hodl-hodl', 'hodlhodl', 'hostmaster', 'hotel', 'hotels', 'hotmail', 'huobi', 'hyperliquid',
      'icloud', 'ideal', 'images', 'imtoken', 'inbox', 'income', 'index', 'indexer', 'inditex', 'infura',
      'ing-direct', 'ingdirect', 'injective', 'instagram', 'install', 'insurance', 'intel', 'internet',
      'internetcomputer', 'interpol', 'intesasanpaolo', 'invest', 'investing', 'investment', 'investments',
      'investor', 'invoice', 'invoices', 'iphone', 'javascript', 'jp-morgan', 'jpmorgan', 'juliusbaer',
      'jupiter', 'kadena', 'kaspa', 'keplr', 'keyguard', 'keystone', 'klarna', 'kraken', 'kubernetes',
      'kucoin', 'kusama', 'kyber', 'kyberswap', 'lambo', 'latoken', 'lbank', 'leather', 'ledger',
      'ledger-live', 'ledgerlive', 'legal', 'lending', 'lensprotocol', 'letsexchange', 'lidofinance',
      'lightning', 'lightning-network', 'lightningnetwork', 'lightspark', 'linea', 'linkedin', 'linux',
      'litecoin', 'litepaper', 'livecoinwatch', 'lloyds', 'loans', 'localbitcoins', 'localhost', 'login',
      'logout', 'lottery', 'macbook', 'magic-eden', 'magiceden', 'mainnet', 'maintainer', 'makerdao',
      'manifest', 'mantle', 'market', 'marketplace', 'marvel', 'master', 'mastercard', 'mathwallet',
      'mcdonalds', 'media', 'memes', 'mempool', 'mempool-space', 'mempoolspace', 'mercado-pago', 'mercadona',
      'mercadopago', 'mercuryo', 'merkle', 'messari', 'metamask', 'metaplatforms', 'metaverse', 'metrics',
      'microsoft', 'minecraft', 'miner', 'miners', 'mining', 'mobile', 'mobilepay', 'moderator',
      'moderators', 'monero', 'monerujo', 'money', 'moneygram', 'monitor', 'monzo', 'moonpay', 'moralis',
      'morgan-stanley', 'morganstanley', 'mortgage', 'movistar', 'mozilla', 'music', 'muunwallet',
      'my-wallet', 'mycrypto', 'myetherwallet', 'mywallet', 'nakamoto', 'namecoin', 'names', 'nansen',
      'natwest', 'neteller', 'netflix', 'netlify', 'network', 'ngrave', 'nimig', 'nimigpay', 'nimiq',
      'nimiq-app', 'nimiq-chat', 'nimiq-foundation', 'nimiq-hub', 'nimiq-labs', 'nimiq-names',
      'nimiq-network', 'nimiq-oasis', 'nimiq-official', 'nimiq-pay', 'nimiq-safe', 'nimiq-support',
      'nimiq-team', 'nimiq-wallet', 'nimiq-watch', 'nimiqadmin', 'nimiqapp', 'nimiqbank', 'nimiqblog',
      'nimiqcard', 'nimiqcash', 'nimiqchat', 'nimiqcoin', 'nimiqcommunity', 'nimiqdao', 'nimiqdev',
      'nimiqdevs', 'nimiqexplorer', 'nimiqforum', 'nimiqfoundation', 'nimiqfund', 'nimiqhelp', 'nimiqhub',
      'nimiqkeyguard', 'nimiqlabs', 'nimiqminer', 'nimiqmining', 'nimiqmobile', 'nimiqname', 'nimiqnames',
      'nimiqnetwork', 'nimiqnews', 'nimiqoasis', 'nimiqofficial', 'nimiqpay', 'nimiqpayments', 'nimiqpays',
      'nimiqpool', 'nimiqq', 'nimiqs', 'nimiqsafe', 'nimiqshop', 'nimiqstake', 'nimiqstaking', 'nimiqstore',
      'nimiqsupport', 'nimiqswap', 'nimiqteam', 'nimiqtoken', 'nimiqvalidator', 'nimiqwallet', 'nimiqwatch',
      'nimiqx', 'nintendo', 'nirniq', 'nirniqhub', 'nirniqnames', 'nirniqpay', 'nirniqwallet', 'nns-admin',
      'nns-official', 'nns-protocol', 'nns-support', 'nns-team', 'nnsadmin', 'nnsnames', 'nnsofficial',
      'nnsprotocol', 'nnssupport', 'nnsteam', 'no-reply', 'nobody', 'nodejs', 'nodes', 'nordea', 'noreply',
      'notification', 'notifications', 'notion', 'nowpayments', 'npmjs', 'nubank', 'nunchuk', 'nvidia',
      'nytimes', 'oasis', 'oauth', 'offer', 'offers', 'official', 'officials', 'okcoin', 'okxwallet',
      'oneinch', 'online', 'onramper', 'openai', 'openbank', 'opennode', 'opensea', 'operations', 'operator',
      'optimism', 'options', 'oracle', 'ordinals', 'original', 'osmosis', 'outlook', 'owner', 'owners',
      'pancakeswap', 'params', 'paraswap', 'password', 'paxful', 'paxos', 'payment', 'payments', 'paynimiq',
      'payoneer', 'paypal', 'paysafe', 'paysafecard', 'pending', 'pepecoin', 'pepsi', 'phantom', 'phemex',
      'phone', 'photo', 'pinata', 'pinterest', 'playstation', 'podcast', 'pokemon', 'poker', 'police',
      'policy', 'polkadot', 'poloniex', 'polygon', 'postfinance', 'postmaster', 'press', 'price', 'prices',
      'privacy', 'private', 'probit', 'profile', 'profiles', 'profit', 'profits', 'proof', 'proofs',
      'property', 'protocol', 'protocol-labs', 'protocollabs', 'proton', 'protonmail', 'public', 'python',
      'quicknode', 'quorum', 'rabby', 'rabobank', 'raiffeisen', 'rainbow', 'rainbowwallet', 'rampnetwork',
      'rarible', 'raydium', 'real-estate', 'realestate', 'red-cross', 'redcross', 'reddit', 'refund',
      'refunds', 'register', 'registrar', 'registration', 'registry', 'relay', 'release', 'releases',
      'remitly', 'reserve', 'reserved', 'resolve', 'resolver', 'resolvers', 'reuters', 'revolut',
      'riotgames', 'ripple', 'riverfinancial', 'roadmap', 'robinhood', 'roblox', 'robosats', 'robots',
      'runes', 'rustlang', 'sabadell', 'safepal', 'safewallet', 'sales', 'salesforce', 'samourai', 'sample',
      'samsung', 'samsung-pay', 'samsungpay', 'santander', 'sardine', 'satoshi', 'satoshi-nakamoto',
      'satoshinakamoto', 'savings', 'scotiabank', 'scroll', 'search', 'secure', 'security', 'self-crypto',
      'selfcrypto', 'service', 'services', 'settings', 'settlement', 'shakepay', 'shares', 'shiba',
      'shiba-inu', 'shibainu', 'shopify', 'shopping', 'sideshift', 'signal', 'signin', 'signup', 'silver',
      'simpleswap', 'simplex', 'sitemap', 'skrill', 'slack', 'smart-contract', 'smartcontract',
      'smartcontracts', 'snapchat', 'social', 'societegenerale', 'sofort', 'solana', 'solflare', 'sonar',
      'sonar-tech', 'sonartech', 'sonic', 'space-id', 'spaceid', 'spacex', 'sparrow', 'sparrowwallet',
      'specs', 'sportsbook', 'spotify', 'square', 'stackoverflow', 'stacks', 'staff', 'stake', 'stakers',
      'staking', 'starbucks', 'starknet', 'starkware', 'starling', 'starlink', 'startup', 'static', 'status',
      'stealthex', 'steam', 'stellar', 'stock', 'stocks', 'store', 'stream', 'streaming', 'strike', 'stripe',
      'studio', 'superrare', 'superuser', 'support', 'sushiswap', 'swanbitcoin', 'swaps', 'swapzone',
      'swedbank', 'swift', 'swish', 'swisscom', 'swissquote', 'swyftx', 'sygnum', 'sysadmin', 'system',
      't-mobile', 'tangem', 'taproot', 'td-bank', 'tdbank', 'telefonica', 'telegram', 'terms', 'tesla',
      'testing', 'testnet', 'tether', 'tezos', 'the-block', 'the-graph', 'theblock', 'thegraph', 'thorchain',
      'thorswap', 'tickets', 'tiktok', 'tmobile', 'token', 'tokenpocket', 'tokens', 'toncoin', 'trade',
      'trader', 'trading', 'tradingview', 'transak', 'transfer', 'transferwise', 'travel', 'treasury',
      'trezor', 'trezor-suite', 'trezorsuite', 'tronix', 'truist', 'trust-wallet', 'trusted', 'trustwallet',
      'tutanota', 'twint', 'twitch', 'twitter', 'typescript', 'ubisoft', 'ubuntu', 'unchained', 'undefined',
      'unicef', 'unicredit', 'unionpay', 'unisat', 'uniswap', 'uniswapwallet', 'united-nations',
      'unitednations', 'unknown', 'unreserve', 'unreserved', 'unstoppable', 'unstoppable-domains',
      'unstoppabledomains', 'upbit', 'update', 'updates', 'us-bank', 'usbank', 'usd-coin', 'usdcoin',
      'utrust', 'validator', 'validators', 'value', 'valve', 'vanguard', 'vault', 'vaults', 'venmo',
      'venture', 'ventures', 'vercel', 'verification', 'verified', 'verify', 'verizon', 'video', 'vipps',
      'vitalik', 'vitalikbuterin', 'vodafone', 'wallet', 'walletconnect', 'wallets', 'walmart', 'warnerbros',
      'warpcast', 'wasabi', 'wazirx', 'wealth', 'webhook', 'webhooks', 'webmaster', 'webull', 'wechat',
      'wechat-pay', 'wechatpay', 'welcome', 'wells-fargo', 'wellsfargo', 'western-union', 'westernunion',
      'whale', 'whales', 'whatsapp', 'whitebit', 'whitepaper', 'wikimedia', 'wikipedia', 'windows', 'world',
      'world-bank', 'worldbank', 'worldchain', 'worldcoin', 'xdefi', 'xverse', 'yahoo', 'yield', 'youtube',
      'zcash', 'zebpay', 'zengo', 'zksync',
    ]
    expect(new Set(CONSTANTS.RESERVED_NAMES)).toEqual(new Set(published))
    expect(CONSTANTS.RESERVED_NAMES).toHaveLength(published.length)
    expect(published).toHaveLength(1001)
  })

  it('holds no duplicate entry — membership is a set (§4.1 rule 6)', () => {
    // Split out of the literal list pin above: a duplicate is what set
    // comparison alone swallows, and behind that pin this never ran on a tempo
    // branch — which is exactly the branch that appends throwaway entries to
    // the list.
    expect(new Set(CONSTANTS.RESERVED_NAMES).size).toBe(CONSTANTS.RESERVED_NAMES.length)
  })

  it('keeps every published entry registrable, so no entry reserves nothing', () => {
    // An entry that no `G` could ever carry — uppercase, too short, a digit in
    // the wrong place — silently reserves nothing at all: the name it looks
    // like stays registrable and nobody finds out until it is taken. §4.1
    // never normalises, so this is exact.
    for (const name of CONSTANTS.RESERVED_NAMES) {
      expect(validateNameSyntax(name), name).toEqual({ ok: true })
      expect(name.length, name).toBeGreaterThanOrEqual(CONSTANTS.MIN_NAME_LEN)
      expect(name, name).toBe(name.toLowerCase())
    }
  })

  it('leaves the published list to the names the by-rule route cannot reach', () => {
    // 1–4 character names are members by rule (§4.1, r18) and are deliberately
    // not materialised. An entry here would be either redundant or, worse,
    // read as the list being the only route.
    expect(CONSTANTS.RESERVED_NAMES.filter((name) => name.length < CONSTANTS.MIN_NAME_LEN)).toEqual([])
  })

  it('freezes the list itself, not just the object holding it', () => {
    // Object.freeze is shallow; a frozen CONSTANTS with a live array is a
    // consensus input any caller could push onto.
    expect(Object.isFrozen(CONSTANTS.RESERVED_NAMES)).toBe(true)
  })
})
