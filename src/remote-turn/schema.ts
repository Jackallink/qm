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
  termination_proof_digest TEXT,
  correlation_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
)`;

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

export const REMOTE_TURN_DDL_ALL = [
  REMOTE_RUNTIME_BINDING_DDL,
  REMOTE_TURN_DDL,
  REMOTE_TURN_ADMISSION_KEY_PARTIAL_UNIQUE_INDEX_DDL,
  REMOTE_TURN_EVENTS_DDL,
] as const;
