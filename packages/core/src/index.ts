/**
 * `@nns/core` — the protocol rules.
 *
 * Pure and deterministic: no I/O, no network, no clock, no randomness. Two
 * independent implementations following `docs/nns-spec-v1.md` must produce
 * identical bytes from this surface.
 *
 * One exception, and it is not a consensus path: {@link generateKeypair} draws
 * entropy, because generating a key is what it is for. Its entropy source is a
 * parameter, so it is pure whenever a caller supplies one, and every
 * derivation step around it — {@link keypairFromPrivateKey},
 * {@link addressFromPublicKey} — is pure unconditionally. Nothing that feeds a
 * root or a log hash touches it.
 */

export { CONSTANTS, LUNA_PER_NIM } from './constants.js'

export {
  ADDRESS_BYTES,
  AddressError,
  ZERO_ADDRESS,
  addressEquals,
  addressFromBytes,
  addressToBytes,
  formatAddress,
  isZeroAddress,
  parseAddress,
  tryParseAddress,
  type Address,
} from './address.js'

export {
  KeypairError,
  PRIVATE_KEY_BYTES,
  PUBLIC_KEY_BYTES,
  addressFromPublicKey,
  generateKeypair,
  keypairFromPrivateKey,
  privateKeyBytes,
  publicKeyFromPrivateKey,
  type KeyInput,
  type Keypair,
  type RandomBytes,
} from './keypair.js'

export {
  ConfigError,
  defineConfig,
  type NnsConfig,
  type NnsConfigInput,
} from './config.js'

export {
  feeBand,
  isValidName,
  isValidRef,
  parseQuery,
  validateHost,
  validateLabel,
  validateName,
  type FeeBand,
  type HostInvalidReason,
  type HostValidation,
  type LabelInvalidReason,
  type LabelValidation,
  type NameInvalidReason,
  type NameValidation,
  type Query,
  type QueryInvalidReason,
  type QueryParse,
} from './name.js'

export {
  LAUNCH_PRICES,
  initialState,
  isReserved,
  lookup,
  minPrice,
  refKey,
  resolve,
  type NameRecord,
  type NameStatus,
  type NnsState,
  type Obligation,
  type ObligationKind,
  type Offer,
  type PendingGovernance,
  type PendingRecovery,
  type PendingTransfer,
  type PendingUnreserve,
  type Prices,
  type TxRef,
} from './state.js'

export {
  ReducerError,
  advanceTo,
  commissionOn,
  feeFor,
  reduce,
  type ChainTransaction,
  type ForfeitReason,
  type IgnoredReason,
  type ReduceResult,
  type RefundReason,
  type Verdict,
} from './reduce.js'

export {
  HASH_BYTES,
  MerkleError,
  bytesEqual,
  checkpoint,
  compareNames,
  encodeLeaf,
  leafHash,
  merkleNonInclusion,
  merkleProof,
  merkleRoot,
  pendingCommitment,
  pricesCommitment,
  sortedRecords,
  unreservedCommitment,
  verifyProof,
  type Checkpoint,
  type MerkleProof,
  type NameTreeState,
  type NonInclusionProof,
  type ProofStep,
} from './merkle.js'

export {
  LogError,
  canonicalLogLine,
  cidFromDigest,
  createLogHasher,
  digestFromCid,
  logFile,
  logHash,
  parseLogLine,
  verdictToken,
  type LogHasher,
} from './log.js'

export {
  BURN_ADDRESS,
  CodecError,
  MESSAGE_TYPES,
  encodeAuction,
  encodeBurn,
  encodeBuy,
  encodeCancel,
  encodeDelegate,
  encodeGovernance,
  encodeOffer,
  encodeRecovery,
  encodeRegister,
  encodeRenew,
  encodeSetTarget,
  encodeSettlement,
  encodeTransfer,
  encodeUnreserve,
  parse,
  type BuiltTransaction,
  type Message,
  type MessageType,
  type ParseFailure,
  type ParseResult,
  type SenderOption,
} from './codec.js'
