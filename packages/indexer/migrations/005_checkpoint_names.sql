-- 005 · the name records as of the latest checkpoint, for proof serving
--
-- §8.3 proofs verify against a *checkpoint* root, but `names` holds state at
-- `state_height` — up to CHECKPOINT_INTERVAL−1 blocks past the last
-- checkpoint. A proof derived from `names` would carry a root committed
-- nowhere, and §8.5's cross-resolver comparison only works on roots at the
-- canonical checkpoint heights. So the boundary state's name records are kept
-- alongside the checkpoint row, written in the same transaction, replaced
-- wholesale each time a checkpoint lands. Only the latest snapshot is kept:
-- proofs are served against the current checkpoint, and history is what the
-- log and §8.8's segment snapshots are for.
--
-- This is a projection, not new truth: a replay to the checkpoint height
-- reproduces every row. The API derives the §8.1 tree from these rows via
-- `core` and refuses to serve proofs if the derived root disagrees with
-- `checkpoints.name_root` — so a torn or stale snapshot degrades to "no
-- proof", never to a proof that fails verification.
--
-- `height` is the checkpoint height, identical on every row of one snapshot;
-- it lets the reader confirm the snapshot belongs to the checkpoint row it
-- was read next to.

CREATE TABLE checkpoint_names (
  height   BIGINT   NOT NULL,
  name     TEXT     PRIMARY KEY,
  owner    CHAR(36) NOT NULL,
  target   CHAR(36) NOT NULL,
  expiry   BIGINT   NOT NULL,
  status   TEXT     NOT NULL CHECK (status IN ('REGISTERED', 'GRACE')),
  recovery CHAR(36),
  host     TEXT     NOT NULL DEFAULT ''
);
