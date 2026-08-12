/**
 * `@nns/indexer` — chain-facing half.
 *
 * RPC client (envelope unwrapping, basic auth) and the scan loop
 * (`FINALITY_RULE`, §7.1 prefix discovery, §5.2 canonical order).
 * No database, no checkpoints, no reducer wiring yet.
 */

export {
  BLOCKS_PER_BATCH,
  batchAt,
  firstBlockOf,
  heightInBatch,
  lastFinalisedBatch,
  lastFinalisedHeight,
  macroBlockOf,
} from './chain.js'

export { EnvError, loadSettings, type EnvSource, type IndexerSettings } from './env.js'

export {
  createLogger,
  isLogLevel,
  type LogFields,
  type LogLevel,
  type Logger,
  type LoggerOptions,
} from './logger.js'

export { OrderingError, compare, resolvePositions, type Positioned } from './ordering.js'

export {
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  RpcClient,
  RpcError,
  RpcTransportError,
  type RpcBlock,
  type RpcClientOptions,
  type RpcMetadata,
  type RpcResponse,
  type RpcTransaction,
} from './rpc.js'

export {
  PROTOCOL_PREFIX_HEX,
  ScanError,
  Scanner,
  delay,
  hasProtocolPrefix,
  type BatchSummary,
  type NnsCandidate,
  type ScannerOptions,
  type ScanRpc,
} from './scan.js'
