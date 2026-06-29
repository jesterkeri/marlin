-- Marlin Phase-1 schema. Idempotent (CREATE ... IF NOT EXISTS), applied by db/init.ts.
-- One submission can have many attempts (retries); bundle_uuid + signature + the
-- raw Jito result are recorded PER ATTEMPT (the idempotency + failed-bundle evidence trail).

CREATE TABLE IF NOT EXISTS submissions (
  id                      UUID PRIMARY KEY,
  idempotency_key         TEXT UNIQUE NOT NULL,
  target_leader_identity  TEXT,
  target_slot             BIGINT,
  blockhash               TEXT,
  last_valid_block_height BIGINT,
  final_outcome           TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS submission_attempts (
  id                      UUID PRIMARY KEY,
  submission_id           UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  attempt_no              INT  NOT NULL,
  bundle_uuid             TEXT,
  signed_tx_signature     TEXT,
  tip_lamports            BIGINT,
  blockhash               TEXT,
  -- Blockhash-expiry PROOF (forced fault injection): the validity-window height
  -- and the observed block height that exceeded it (explorer-consistent evidence).
  last_valid_block_height BIGINT,
  expiry_block_height     BIGINT,
  raw_bundle_result       JSONB,          -- latest result snapshot; full history is in bundle_events
  result_received_at      TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (submission_id, attempt_no)
);

-- Idempotently backfill the expiry-proof columns on a pre-existing attempts table
-- (CREATE TABLE IF NOT EXISTS above won't add columns to a table that already exists).
ALTER TABLE submission_attempts ADD COLUMN IF NOT EXISTS last_valid_block_height BIGINT;
ALTER TABLE submission_attempts ADD COLUMN IF NOT EXISTS expiry_block_height     BIGINT;

-- Append-only Jito bundle-result history. One row per (attempt, kind) so the full
-- accepted -> processed -> finalized/dropped/rejected progression is preserved
-- (a single COALESCE'd JSONB field on the attempt would keep only one snapshot).
CREATE TABLE IF NOT EXISTS bundle_events (
  id                UUID PRIMARY KEY,
  attempt_id        UUID NOT NULL REFERENCES submission_attempts(id) ON DELETE CASCADE,
  bundle_uuid       TEXT NOT NULL,
  kind              TEXT NOT NULL,         -- accepted | processed | finalized | dropped | rejected | unknown
  dropped_reason    TEXT,
  rejected_reason   TEXT,
  raw_bundle_result JSONB,
  ts                TIMESTAMPTZ NOT NULL,
  UNIQUE (attempt_id, kind)
);

CREATE TABLE IF NOT EXISTS lifecycle_events (
  id               UUID PRIMARY KEY,
  attempt_id       UUID NOT NULL REFERENCES submission_attempts(id) ON DELETE CASCADE,
  stage            TEXT NOT NULL,            -- submitted | processed | confirmed | finalized
  slot             BIGINT,
  ts               TIMESTAMPTZ NOT NULL,
  latency_delta_ms BIGINT,
  UNIQUE (attempt_id, stage)
);

CREATE TABLE IF NOT EXISTS tip_decisions (
  id                  UUID PRIMARY KEY,
  attempt_id          UUID NOT NULL REFERENCES submission_attempts(id) ON DELETE CASCADE,
  source              TEXT NOT NULL,         -- tip_floor | last_good_degraded
  floor_lamports      BIGINT,
  p50_lamports        BIGINT,
  p75_lamports        BIGINT,
  max_lamports        BIGINT,
  congestion          DOUBLE PRECISION,
  chosen_tip_lamports BIGINT,
  ts                  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS failures (
  id                UUID PRIMARY KEY,
  attempt_id        UUID NOT NULL REFERENCES submission_attempts(id) ON DELETE CASCADE,
  classification    TEXT NOT NULL,           -- ExpiredBlockhash | FeeTooLow | ComputeExceeded | BundleFailure
  jito_drop_reason  TEXT,
  raw_bundle_result JSONB,
  signal            TEXT,
  slot              BIGINT,
  ts                TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_decisions (
  id                   UUID PRIMARY KEY,
  attempt_id           UUID NOT NULL REFERENCES submission_attempts(id) ON DELETE CASCADE,
  inputs               JSONB,
  output               JSONB,
  clamped_tip_lamports BIGINT,
  model                TEXT,
  malformed            BOOLEAN NOT NULL DEFAULT false,
  ts                   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_submission ON submission_attempts(submission_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_attempt   ON lifecycle_events(attempt_id);
CREATE INDEX IF NOT EXISTS idx_failures_attempt    ON failures(attempt_id);
CREATE INDEX IF NOT EXISTS idx_agent_attempt       ON agent_decisions(attempt_id);
CREATE INDEX IF NOT EXISTS idx_bundle_events_attempt ON bundle_events(attempt_id);
