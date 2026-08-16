export const REMOTE_RUNTIME_BINDING_DDL = `CREATE TABLE IF NOT EXISTS remote_runtime_binding(
  id TEXT PRIMARY KEY,
  version INT NOT NULL,
  enabled BOOL NOT NULL,
  configured_org_id TEXT NOT NULL,
  allowed_scope_id TEXT NOT NULL,
  protocol_version INT NOT NULL,
  runtime_audience TEXT NOT NULL,
  transport_service_id TEXT NOT NULL,
  transport_certificate_pin TEXT NOT NULL,
  transport_source_auth_key_id TEXT NOT NULL,
  release_digest TEXT NOT NULL,
  release_attestation_key_id TEXT NOT NULL,
  receipt_key_set_version INT NOT NULL,
  metering_key_set_version INT NOT NULL,
  max_input_bytes INT NOT NULL,
  max_history_messages INT NOT NULL,
  max_output_bytes INT NOT NULL,
  max_runtime_ms INT NOT NULL,
  token_ttl_ms INT NOT NULL,
  budget_ceiling_usd NUMERIC NOT NULL,
  key_sets JSONB NOT NULL,
  policy_snapshot_hash TEXT NOT NULL,
  network_policy_id TEXT NOT NULL,
  endpoint_allowlist JSONB NOT NULL,
  egress_audience TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  disabled_by TEXT,
  disabled_at BIGINT
)`;

export const REMOTE_TURN_DDL = `CREATE TABLE IF NOT EXISTS remote_turn(
  id TEXT PRIMARY KEY,
  core_run_id TEXT NOT NULL UNIQUE,
  admission_key TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  qm_session_id TEXT,
  governance_authorization_digest TEXT,
  governance_decision_id TEXT,
  binding_id TEXT NOT NULL,
  binding_version INT NOT NULL,
  policy_snapshot_hash TEXT,
  release_digest TEXT,
  input_digest TEXT,
  envelope_digest TEXT,
  history_digest TEXT,
  turn_jti_hash TEXT,
  abort_jti_hash TEXT,
  execution_lease_hash TEXT,
  attestation_nonce_hash TEXT,
  workload_identity TEXT,
  planned_sandbox_id TEXT,
  reply TEXT,
  output_bytes INT,
  budget_reservation_id TEXT,
  status TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  dispatch_owner TEXT,
  dispatch_attempt INT,
  pre_admission_expires_at BIGINT,
  pre_claim_expires_at BIGINT,
  dispatch_started_at BIGINT,
  claim_expires_at BIGINT,
  claimed_at BIGINT,
  parked_at BIGINT,
  reconciled_from_state TEXT,
  reconciliation_evidence_ref TEXT,
  abort_requested_at BIGINT,
  receipt_digest TEXT,
  trusted_usage_digest TEXT,
  usage_settlement_id TEXT,
  receipt_key_snapshot JSONB,
  termination_proof_digest TEXT,
  correlation_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
)`;

export const REMOTE_TURN_RECEIPT_SNAPSHOT_ALTER_DDL = `ALTER TABLE remote_turn ADD COLUMN IF NOT EXISTS receipt_key_snapshot JSONB`;

export const REMOTE_BINDING_SOURCE_AUTH_ALTER_DDL = `ALTER TABLE remote_runtime_binding ADD COLUMN IF NOT EXISTS transport_source_auth_key_id TEXT NOT NULL DEFAULT ''`;

export const REMOTE_BINDING_POLICY_ALTER_DDL = `ALTER TABLE remote_runtime_binding ADD COLUMN IF NOT EXISTS network_policy_id TEXT NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS endpoint_allowlist JSONB NOT NULL DEFAULT '[]', ADD COLUMN IF NOT EXISTS egress_audience TEXT NOT NULL DEFAULT ''`;

export const REMOTE_TURN_PRECLAIM_ALTER_DDL = `ALTER TABLE remote_turn ADD COLUMN IF NOT EXISTS policy_digest TEXT, ADD COLUMN IF NOT EXISTS endpoint_allowlist JSONB, ADD COLUMN IF NOT EXISTS egress_audience TEXT, ADD COLUMN IF NOT EXISTS pre_claim_expiry BIGINT`;

export const REMOTE_TURN_CORE_RUN_FK_DDL = `DO $fk$ BEGIN IF to_regclass('runs') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'remote_turn_core_run_fk') THEN ALTER TABLE remote_turn ADD CONSTRAINT remote_turn_core_run_fk FOREIGN KEY (core_run_id) REFERENCES runs(id) ON DELETE RESTRICT; END IF; END $fk$`;

export const REMOTE_TURN_SESSION_FK_DDL = `DO $fk$ BEGIN IF to_regclass('sessions') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'remote_turn_session_fk') THEN ALTER TABLE remote_turn ADD CONSTRAINT remote_turn_session_fk FOREIGN KEY (qm_session_id) REFERENCES sessions(id) ON DELETE RESTRICT; END IF; END $fk$`;

export const REMOTE_TURN_ADMISSION_KEY_PARTIAL_UNIQUE_INDEX_DDL = `CREATE UNIQUE INDEX IF NOT EXISTS remote_turn_admission_key_active
  ON remote_turn(admission_key)
  WHERE status NOT IN ('completed','rejected','failed_pre_dispatch','failed','cancelled','parked')`;

export const REMOTE_TURN_EVENTS_DDL = `CREATE TABLE IF NOT EXISTS remote_turn_events(
  id BIGSERIAL PRIMARY KEY,
  remote_turn_id TEXT NOT NULL,
  seq INT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB,
  created_at BIGINT NOT NULL,
  UNIQUE(remote_turn_id, seq)
)`;

export const REMOTE_TURN_SESSION_DDL = [
  `CREATE TABLE IF NOT EXISTS sessions(
      id TEXT PRIMARY KEY, type TEXT NOT NULL, scope_id TEXT NOT NULL,
      thread_ref TEXT UNIQUE NOT NULL, created_at BIGINT NOT NULL, title TEXT, channel_name TEXT
    )`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS surface TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity BIGINT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS messages INT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turns INT`,
  `CREATE TABLE IF NOT EXISTS session_leases(
      session_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at BIGINT NOT NULL
    )`,
  `ALTER TABLE session_leases ADD COLUMN IF NOT EXISTS holder TEXT`,
  `ALTER TABLE session_leases ADD COLUMN IF NOT EXISTS acquired_at BIGINT`,
] as const;

export const REMOTE_TURN_RUN_DDL = [
  `CREATE TABLE IF NOT EXISTS runs(
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
      request TEXT NOT NULL, result TEXT, idempotency_key TEXT UNIQUE,
      attempts INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL DEFAULT 3,
      lease_token TEXT, lease_expires_at BIGINT, worker_id TEXT,
      created_at BIGINT NOT NULL, started_at BIGINT, finished_at BIGINT
    )`,
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS delivery_mode TEXT NOT NULL DEFAULT 'local'`,
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS error_attempts INT NOT NULL DEFAULT 0`,
] as const;

export const REMOTE_TURN_AUDIT_READS_DDL = `CREATE TABLE IF NOT EXISTS remote_turn_audit_reads(
  id BIGSERIAL PRIMARY KEY,
  scope_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at BIGINT NOT NULL
)`;

export const REMOTE_TURN_DDL_ALL = [
  REMOTE_RUNTIME_BINDING_DDL,
  REMOTE_BINDING_SOURCE_AUTH_ALTER_DDL,
  REMOTE_BINDING_POLICY_ALTER_DDL,
  REMOTE_TURN_DDL,
  REMOTE_TURN_PRECLAIM_ALTER_DDL,
  REMOTE_TURN_RECEIPT_SNAPSHOT_ALTER_DDL,
  REMOTE_TURN_CORE_RUN_FK_DDL,
  REMOTE_TURN_SESSION_FK_DDL,
  REMOTE_TURN_ADMISSION_KEY_PARTIAL_UNIQUE_INDEX_DDL,
  REMOTE_TURN_EVENTS_DDL,
  REMOTE_TURN_AUDIT_READS_DDL,
] as const;
