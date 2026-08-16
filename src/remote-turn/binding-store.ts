import type { Rows } from "../persistence/pg-pool.ts";
import { sharedPgPool, type PgPool } from "../persistence/pg-pool.ts";
import { REMOTE_TURN_DDL_ALL } from "./schema.ts";

export type KeySetEntryState = "current" | "overlap";

export interface KeySetEntry {
  kid: string;
  publicKeyPem: string;
  state: KeySetEntryState;
  activatedAt: number;
  retiresAt: number;
}

export interface RemoteRuntimeBinding {
  bindingId: string;
  version: number;
  enabled: boolean;
  configuredOrgId: string;
  allowedScopeId: string;
  protocolVersion: number;
  runtimeAudience: string;
  transportServiceId: string;
  transportCertificatePin: string;
  releaseDigest: string;
  releaseAttestationKeyId: string;
  receiptKeySetVersion: number;
  meteringKeySetVersion: number;
  maxInputBytes: number;
  maxHistoryMessages: number;
  maxOutputBytes: number;
  maxRuntimeMs: number;
  tokenTtlMs: number;
  budgetCeilingUsd: number;
  policySnapshotHash: string;
  createdBy: string;
  createdAt: number;
  disabledBy: string | null;
  disabledAt: number | null;
  coreVerificationKeys: KeySetEntry[];
  attestorKeys: KeySetEntry[];
  receiptKeys: KeySetEntry[];
  meteringKeys: KeySetEntry[];
}

export interface CreateBindingInput {
  bindingId: string;
  configuredOrgId: string;
  allowedScopeId: string;
  protocolVersion: number;
  runtimeAudience: string;
  transportServiceId: string;
  transportCertificatePin: string;
  releaseDigest: string;
  releaseAttestationKeyId: string;
  receiptKeySetVersion: number;
  meteringKeySetVersion: number;
  maxInputBytes: number;
  maxHistoryMessages: number;
  maxOutputBytes: number;
  maxRuntimeMs: number;
  tokenTtlMs: number;
  budgetCeilingUsd: number;
  policySnapshotHash: string;
  createdBy: string;
  coreVerificationKeys: KeySetEntry[];
  attestorKeys: KeySetEntry[];
  receiptKeys: KeySetEntry[];
  meteringKeys: KeySetEntry[];
}

interface BindingRow {
  id: string;
  version: number;
  enabled: boolean;
  configured_org_id: string;
  allowed_scope_id: string;
  protocol_version: number;
  runtime_audience: string;
  transport_service_id: string;
  transport_certificate_pin: string;
  release_digest: string;
  release_attestation_key_id: string;
  receipt_key_set_version: number;
  metering_key_set_version: number;
  max_input_bytes: number;
  max_history_messages: number;
  max_output_bytes: number;
  max_runtime_ms: number;
  token_ttl_ms: number;
  budget_ceiling_usd: string;
  key_sets: {
    core: KeySetEntry[];
    attestor: KeySetEntry[];
    receipt: KeySetEntry[];
    metering: KeySetEntry[];
  };
  policy_snapshot_hash: string;
  created_by: string;
  created_at: number;
  disabled_by: string | null;
  disabled_at: number | null;
}

function rowToBinding(row: Record<string, unknown>): RemoteRuntimeBinding {
  const r = row as unknown as BindingRow;
  const keySets = typeof r.key_sets === "string" ? (JSON.parse(r.key_sets) as BindingRow["key_sets"]) : r.key_sets;
  return {
    bindingId: r.id,
    version: Number(r.version),
    enabled: Boolean(r.enabled),
    configuredOrgId: r.configured_org_id,
    allowedScopeId: r.allowed_scope_id,
    protocolVersion: Number(r.protocol_version),
    runtimeAudience: r.runtime_audience,
    transportServiceId: r.transport_service_id,
    transportCertificatePin: r.transport_certificate_pin,
    releaseDigest: r.release_digest,
    releaseAttestationKeyId: r.release_attestation_key_id,
    receiptKeySetVersion: Number(r.receipt_key_set_version),
    meteringKeySetVersion: Number(r.metering_key_set_version),
    maxInputBytes: Number(r.max_input_bytes),
    maxHistoryMessages: Number(r.max_history_messages),
    maxOutputBytes: Number(r.max_output_bytes),
    maxRuntimeMs: Number(r.max_runtime_ms),
    tokenTtlMs: Number(r.token_ttl_ms),
    budgetCeilingUsd: Number(r.budget_ceiling_usd),
    policySnapshotHash: r.policy_snapshot_hash,
    createdBy: r.created_by,
    createdAt: Number(r.created_at),
    disabledBy: r.disabled_by ?? null,
    disabledAt: r.disabled_at === null || r.disabled_at === undefined ? null : Number(r.disabled_at),
    coreVerificationKeys: keySets.core,
    attestorKeys: keySets.attestor,
    receiptKeys: keySets.receipt,
    meteringKeys: keySets.metering,
  };
}

export interface RotateBindingKeysInput {
  bindingId: string;
  expectedVersion: number;
  coreVerificationKeys?: KeySetEntry[];
  attestorKeys?: KeySetEntry[];
  receiptKeys?: KeySetEntry[];
  meteringKeys?: KeySetEntry[];
  createdBy: string;
}

export type RotateBindingKeysResult =
  | { ok: true; version: number }
  | { ok: false; reason: "not_found" | "version_conflict" | "disabled" };

export interface RemoteBindingStore {
  createBinding(input: CreateBindingInput): Promise<RemoteRuntimeBinding>;
  getBinding(bindingId: string): Promise<RemoteRuntimeBinding | null>;
  rotateBindingKeys(input: RotateBindingKeysInput): Promise<RotateBindingKeysResult>;
  setEnabled(bindingId: string, enabled: boolean, actor: string): Promise<{ version: number }>;
  setEnabledOn(
    client: import("pg").PoolClient,
    bindingId: string,
    enabled: boolean,
    actor: string,
  ): Promise<{ version: number }>;
  listBindings(): Promise<RemoteRuntimeBinding[]>;
  close(): Promise<void>;
}

export function createRemoteBindingStore(connectionString: string): RemoteBindingStore {
  const db: PgPool = sharedPgPool(connectionString, [...REMOTE_TURN_DDL_ALL]);

  async function createBinding(input: CreateBindingInput): Promise<RemoteRuntimeBinding> {
    const now = Date.now();
    const keySets = JSON.stringify({
      core: input.coreVerificationKeys,
      attestor: input.attestorKeys,
      receipt: input.receiptKeys,
      metering: input.meteringKeys,
    });
    await db.q(
      `INSERT INTO remote_runtime_binding(
        id, version, enabled, configured_org_id, allowed_scope_id, protocol_version,
        runtime_audience, transport_service_id, transport_certificate_pin, release_digest,
        release_attestation_key_id, receipt_key_set_version, metering_key_set_version,
        max_input_bytes, max_history_messages, max_output_bytes, max_runtime_ms, token_ttl_ms,
        budget_ceiling_usd, key_sets, policy_snapshot_hash, created_by, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        input.bindingId, 1, true, input.configuredOrgId, input.allowedScopeId, input.protocolVersion,
        input.runtimeAudience, input.transportServiceId, input.transportCertificatePin, input.releaseDigest,
        input.releaseAttestationKeyId, input.receiptKeySetVersion, input.meteringKeySetVersion,
        input.maxInputBytes, input.maxHistoryMessages, input.maxOutputBytes, input.maxRuntimeMs,
        input.tokenTtlMs, input.budgetCeilingUsd, keySets, input.policySnapshotHash, input.createdBy, now,
      ],
    );
    return {
      ...input,
      bindingId: input.bindingId,
      version: 1,
      enabled: true,
      createdAt: now,
      disabledBy: null,
      disabledAt: null,
    };
  }

  async function getBinding(bindingId: string): Promise<RemoteRuntimeBinding | null> {
    const rows = await db.q("SELECT * FROM remote_runtime_binding WHERE id=$1", [bindingId]);
    return rows[0] ? rowToBinding(rows[0]) : null;
  }

  async function setEnabled(bindingId: string, enabled: boolean, actor: string): Promise<{ version: number }> {
    const pool = await db.pool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await setEnabledOn(client, bindingId, enabled, actor);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function setEnabledOn(
    client: import("pg").PoolClient,
    bindingId: string,
    enabled: boolean,
    actor: string,
  ): Promise<{ version: number }> {
    const now = Date.now();
    const { rows: current } = await client.query<{ version: number }>(
      "SELECT version FROM remote_runtime_binding WHERE id=$1",
      [bindingId],
    );
    if (!current[0]) throw new Error(`remote binding ${bindingId} does not exist`);
    const expected = Number(current[0].version);
    const { rows } = await client.query<{ version: number }>(
      `UPDATE remote_runtime_binding SET version=version+1, enabled=$2,
         disabled_by=$3, disabled_at=$4
       WHERE id=$1 AND version=$5
       RETURNING version`,
      [bindingId, enabled, enabled ? null : actor, enabled ? null : now, expected],
    );
    if (!rows[0]) throw new Error(`remote binding ${bindingId} version conflict`);
    return { version: Number(rows[0].version) };
  }

  async function rotateBindingKeys(input: RotateBindingKeysInput): Promise<RotateBindingKeysResult> {
    const rows = await db.q("SELECT * FROM remote_runtime_binding WHERE id=$1", [input.bindingId]);
    if (!rows[0]) return { ok: false as const, reason: "not_found" as const };
    const current = rowToBinding(rows[0]);
    if (!current.enabled) return { ok: false as const, reason: "disabled" as const };
    const merged = JSON.stringify({
      core: input.coreVerificationKeys ?? current.coreVerificationKeys,
      attestor: input.attestorKeys ?? current.attestorKeys,
      receipt: input.receiptKeys ?? current.receiptKeys,
      metering: input.meteringKeys ?? current.meteringKeys,
    });
    const { rows: updated } = await db.query(
      `UPDATE remote_runtime_binding SET version=version+1, key_sets=$2
       WHERE id=$1 AND version=$3 AND enabled
       RETURNING version`,
      [input.bindingId, merged, input.expectedVersion],
    );
    if (!updated[0]) return { ok: false as const, reason: "version_conflict" as const };
    return { ok: true as const, version: Number(updated[0].version) };
  }

  async function listBindings(): Promise<RemoteRuntimeBinding[]> {
    const rows = await db.q("SELECT * FROM remote_runtime_binding ORDER BY created_at ASC");
    return rows.map(rowToBinding);
  }

  async function close(): Promise<void> {
    await db.close();
  }

  return { createBinding, getBinding, rotateBindingKeys, setEnabled, setEnabledOn, listBindings, close };
}
