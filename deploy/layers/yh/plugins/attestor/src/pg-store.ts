import type { PreClaimRecord, AttestorStore } from "./index.ts";

export function createPostgresAttestorStore(opts: {
  connectionString: string;
}): AttestorStore {
  const pg = async () => {
    const mod = await import("pg");
    return new mod.default.Pool({ connectionString: opts.connectionString });
  };
  let poolPromise: Promise<import("pg").Pool> | null = null;
  const pool = (): Promise<import("pg").Pool> => {
    if (!poolPromise) {
      poolPromise = (async () => {
        const p = await pg();
        await p.query(`CREATE TABLE IF NOT EXISTS attestor_pre_claims(
          remote_turn_id TEXT PRIMARY KEY,
          nonce_hash TEXT NOT NULL,
          turn_jti_hash TEXT NOT NULL,
          sandbox_id TEXT NOT NULL,
          network_name TEXT NOT NULL,
          volume_name TEXT NOT NULL,
          container_name TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          status TEXT NOT NULL,
          execution_lease_hash TEXT,
          egress_token_id TEXT,
          termination_proof_digest TEXT
        )`);
        return p;
      })();
    }
    return poolPromise;
  };

  const toRecord = (row: Record<string, unknown>): PreClaimRecord => ({
    remoteTurnId: row.remote_turn_id as string,
    nonceHash: row.nonce_hash as string,
    turnJtiHash: row.turn_jti_hash as string,
    sandboxId: row.sandbox_id as string,
    networkName: row.network_name as string,
    volumeName: row.volume_name as string,
    containerName: row.container_name as string,
    createdAt: Number(row.created_at),
    status: row.status as PreClaimRecord["status"],
    ...(row.execution_lease_hash ? { executionLeaseHash: row.execution_lease_hash as string } : {}),
    ...(row.egress_token_id ? { egressTokenId: row.egress_token_id as string } : {}),
    ...(row.termination_proof_digest ? { terminationProofDigest: row.termination_proof_digest as string } : {}),
  });

  return {
    async insertPreClaim(record) {
      const p = await pool();
      const { rowCount } = await p.query(
        `INSERT INTO attestor_pre_claims(remote_turn_id, nonce_hash, turn_jti_hash, sandbox_id, network_name, volume_name, container_name, created_at, status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (remote_turn_id) DO NOTHING`,
        [record.remoteTurnId, record.nonceHash, record.turnJtiHash, record.sandboxId, record.networkName, record.volumeName, record.containerName, record.createdAt, record.status],
      );
      return (rowCount ?? 0) === 1;
    },
    async getPreClaim(remoteTurnId) {
      const p = await pool();
      const { rows } = await p.query("SELECT * FROM attestor_pre_claims WHERE remote_turn_id=$1", [remoteTurnId]);
      return rows[0] ? toRecord(rows[0] as Record<string, unknown>) : null;
    },
    async updatePreClaim(remoteTurnId, patch) {
      const p = await pool();
      const fields: string[] = [];
      const values: unknown[] = [remoteTurnId];
      const set: string[] = [];
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        const column = {
          status: "status",
          executionLeaseHash: "execution_lease_hash",
          egressTokenId: "egress_token_id",
          terminationProofDigest: "termination_proof_digest",
        }[key];
        if (!column) continue;
        set.push(`${column}=$${values.length + 1}`);
        values.push(value);
      }
      if (set.length === 0) return;
      await p.query(`UPDATE attestor_pre_claims SET ${set.join(",")} WHERE remote_turn_id=$1`, values);
    },
    async listPreClaims() {
      const p = await pool();
      const { rows } = await p.query("SELECT * FROM attestor_pre_claims");
      return rows.map((row) => toRecord(row as Record<string, unknown>));
    },
    async countPending() {
      const p = await pool();
      const { rows } = await p.query("SELECT count(*) AS n FROM attestor_pre_claims WHERE status='pending'");
      return Number((rows[0] as { n: string }).n);
    },
  };
}
