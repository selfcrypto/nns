/**
 * `@nns/indexer` — RPC tail → `@nns/core` reducer → Postgres → §8.1 checkpoints.
 *
 * The RPC client (envelope unwrapping, basic auth), the scan loop
 * (`FINALITY_RULE`, §7.1 prefix discovery, §5.2 canonical order), the reducer
 * wiring, the Postgres projection and the checkpoint builder.
 */

export {
  BLOCKS_PER_BATCH,
  CalibrationError,
  calibrate,
  geometryFor,
  lastFinalisedBatch,
  type ChainGeometry,
} from './chain.js'

export {
  COMMITMENT_LAYOUT,
  CheckpointBuilder,
  CheckpointError,
  checkpointRow,
  commitmentFor,
  hex,
  logLineFromRow,
  type CheckpointBuilderOptions,
  type CheckpointRow,
} from './checkpoint.js'

export {
  EnvError,
  isSnapshotSource,
  isStartMode,
  loadSettings,
  type EnvSource,
  type IndexerSettings,
  type SnapshotSource,
  type StartMode,
} from './env.js'

export {
  HorizonError,
  assertHistoryHorizon,
  earliestBlockHeld,
  historyHorizon,
  holdsBlock,
  type HorizonCheck,
  type HorizonRpc,
} from './horizon.js'

export {
  createLogger,
  isLogLevel,
  type LogFields,
  type LogLevel,
  type Logger,
  type LoggerOptions,
} from './logger.js'

export { Progress, type ProgressOptions } from './progress.js'

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
  PipelineError,
  Pipeline,
  advanceThroughBoundaries,
  nextBoundaryAbove,
  toChainTransaction,
  type BatchResult,
  type BoundaryCrossing,
  type PipelineOptions,
  type VerdictCounts,
} from './pipeline.js'

export {
  RowError,
  paramsRow,
  nameRows,
  pendingRows,
  rowsOf,
  settlementRows,
  stateFromRows,
  toHeight,
  toLuna,
  type LogRow,
  type NameRow,
  type ParamsRow,
  type PendingRow,
  type SettlementRow,
  type StateRows,
} from './rows.js'

export { diffState, type StateDiff } from './diff.js'

export {
  DatabaseError,
  MIGRATIONS_DIR,
  createPool,
  migrate,
  withTransaction,
} from './db.js'

export {
  Store,
  StoreError,
  configFingerprint,
  type CommitInput,
  type Cursor,
  type StoredCheckpoint,
  type Verification,
} from './store.js'

export {
  AnchorSourceError,
  anchoredSource,
  gatewayUrl,
  type AnchoredSourceOptions,
} from './anchored.js'

export { BootstrapError, bootstrap, type BootstrapOptions, type BootstrapResult } from './bootstrap.js'

export { VerificationError, verifyFromChain, type VerifyOptions } from './shadow.js'

export {
  PeerError,
  fetchLogBytes,
  fetchPeerCheckpoint,
  fetchPeerSnapshot,
  httpFetcher,
  peerSource,
  type Fetcher,
  type LogSource,
  type PeerCheckpoint,
  type PeerSnapshot,
} from './peer.js'

export {
  PROTOCOL_PREFIX_HEX,
  ScanError,
  Scanner,
  delay,
  hasProtocolPrefix,
  type BatchSummary,
  type CompletedBatch,
  type NnsCandidate,
  type ScannerOptions,
  type ScanRpc,
} from './scan.js'
