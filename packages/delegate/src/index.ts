/**
 * `@nns/delegate` — the reference §8.6 delegate host.
 *
 * Run by a **name owner**, answering for their own subdomains. Not registry
 * infrastructure: a resolver is run by whoever operates NNS, a delegate by
 * whoever owns the name above the dot. A partner may run both, and that is a
 * compose profile rather than a shared package.
 *
 * What NNS proves stops at the dot. The owner of `binance` proved ownership on
 * chain and named this host in a `D`; everything this server says about
 * `shop.binance` is that host's word and nothing else's. See `README.md`.
 */

export { createRoutes, type DelegateResponse, type RouteHandler, type RouteOptions } from './routes.js'
export { createServer } from './server.js'
export { LabelStore, type LabelSource, type StoreOptions } from './store.js'
export {
  countLabels,
  parseLabelFile,
  readLabelFile,
  LabelFileError,
  DEFAULT_TTL_SEC,
  MAX_TTL_SEC,
  type LabelAnswer,
  type LabelFile,
  type NameLabels,
} from './labels.js'
export { createLogger, isLogLevel, type Logger, type LogFields, type LoggerOptions, type LogLevel } from './logger.js'
export { EnvError, loadSettings, type DelegateSettings, type EnvSource } from './env.js'
