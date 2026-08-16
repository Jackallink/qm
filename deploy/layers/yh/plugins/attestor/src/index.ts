import { createServer } from "node:http";
import {
  sha256Hex,
  signArtifact,
  verifyArtifact,
  verifyTurnToken,
} from "../../shared/src/protocol.ts";
import type { KeySetEntry } from "../../shared/src/protocol.ts";
import type { DockerClient } from "./docker.ts";

export interface AttestorConfig {
  attestorKey: { kid: string; privateKeyPem: string };
  coreVerificationKeys: KeySetEntry[];
  runtimeAudience: string;
  releaseDigest: string;
  releaseImage: string;
  networkPolicyId: string;
  endpointAllowlist: string[];
  egressAudience: string;
  policySnapshotHash: string;
  isolationMode: string;
  executorEnv: Record<string, string>;
  maxPreClaimSandboxes: number;
  preClaimReapGraceMs: number;
  egressGateway: EgressGatewayClient;
  docker: DockerClient;
  store: AttestorStore;
  now?: () => number;
  bindingVersion: number;
  workloadIdentityFor?: (remoteTurnId: string) => string;
}

export interface EgressGatewayClient {
  mintToken(input: {
    executionLeaseHash: string;
    workloadIdentity: string;
    endpointAllowlist: string[];
    expiryMs: number;
  }): Promise<{ ok: true; token: string; tokenId: string } | { ok: false; reason: string }>;
  revokeToken(tokenId: string): Promise<{ ok: true; ack: boolean } | { ok: false; reason: string }>;
}

export interface PreClaimRecord {
  remoteTurnId: string;
  nonceHash: string;
  turnJtiHash: string;
  sandboxId: string;
  networkName: string;
  volumeName: string;
  containerName: string;
  createdAt: number;
  status: "pending" | "started" | "terminated" | "reaped";
  executionLeaseHash?: string;
  egressTokenId?: string;
  terminationProofDigest?: string;
}

export interface AttestorStore {
  insertPreClaim(record: PreClaimRecord): Promise<boolean>;
  getPreClaim(remoteTurnId: string): Promise<PreClaimRecord | null>;
  updatePreClaim(remoteTurnId: string, patch: Partial<PreClaimRecord>): Promise<void>;
  listPreClaims(): Promise<PreClaimRecord[]>;
  countPending(): Promise<number>;
}

export function createMemoryAttestorStore(): AttestorStore {
  const records = new Map<string, PreClaimRecord>();
  return {
    async insertPreClaim(record) {
      if (records.has(record.remoteTurnId)) return false;
      records.set(record.remoteTurnId, record);
      return true;
    },
    async getPreClaim(remoteTurnId) {
      return records.get(remoteTurnId) ?? null;
    },
    async updatePreClaim(remoteTurnId, patch) {
      const existing = records.get(remoteTurnId);
      if (existing) records.set(remoteTurnId, { ...existing, ...patch });
    },
    async listPreClaims() {
      return [...records.values()];
    },
    async countPending() {
      return [...records.values()].filter((r) => r.status === "pending").length;
    },
  };
}

function sandboxName(remoteTurnId: string): string {
  return `rt-sb-${remoteTurnId.slice(0, 8)}`;
}

function networkName(remoteTurnId: string): string {
  return `rt-net-${remoteTurnId.slice(0, 8)}`;
}

function volumeName(remoteTurnId: string): string {
  return `rt-vol-${remoteTurnId.slice(0, 8)}`;
}

export interface AttestorHandlers {
  requestPreClaim(input: { remoteTurnId: string; turnToken: string; attestationNonce: string }): Promise<
    { ok: true; preClaimAttestation: string } | { ok: false; reason: string }
  >;
  deliverLease(input: { remoteTurnId: string; executionLease: string }): Promise<
    { ok: true; startProof: string } | { ok: false; reason: string }
  >;
  terminate(input: { remoteTurnId: string }): Promise<{ ok: true; terminationProof: string } | { ok: false; reason: string }>;
  sandboxState(input: { remoteTurnId: string }): Promise<{
    exists: boolean;
    running: boolean;
    startProofSeen: boolean;
    terminationSeen: boolean;
    egressRevoked: boolean;
    terminationProofDigest: string | null;
  }>;
  reconcileOrphans(): Promise<{ reaped: number }>;
}

export function createAttestor(config: AttestorConfig): AttestorHandlers {
  const now = config.now ?? Date.now;
  const grace = config.preClaimReapGraceMs ?? 30_000;
  const workloadIdentityFor = config.workloadIdentityFor ?? ((remoteTurnId: string) => `wl-${remoteTurnId}`);

  return {
    async requestPreClaim(input) {
      if (await config.store.countPending() >= config.maxPreClaimSandboxes) {
        return { ok: false, reason: "attestor_capacity" };
      }
      const turn = await verifyTurnToken(input.turnToken, config.coreVerificationKeys, {
        aud: config.runtimeAudience,
        remoteTurnId: input.remoteTurnId,
        nowMs: now(),
      });
      if (!turn) return { ok: false, reason: "turn token verification failed" };
      const nonceHash = sha256Hex(input.attestationNonce);
      const existing = await config.store.getPreClaim(input.remoteTurnId);
      if (existing && existing.status !== "terminated" && existing.status !== "reaped") {
        return { ok: false, reason: "pre_claim_already_exists" };
      }
      const sandboxId = sandboxName(input.remoteTurnId);
      const net = networkName(input.remoteTurnId);
      const vol = volumeName(input.remoteTurnId);
      try {
        await config.docker.pullImage(config.releaseImage);
        await config.docker.createNetwork(net, true);
        await config.docker.createVolume(vol);
        await config.docker.createContainer({
          image: config.releaseImage,
          name: sandboxId,
          networkName: net,
          volumeName: vol,
          tokenMountPath: "/run/remote-turn/token",
          capDrop: ["ALL"],
          env: Object.entries(config.executorEnv).map(([k, v]) => `${k}=${v}`),
        });
      } catch (error) {
        await config.docker.removeNetwork(net).catch(() => undefined);
        await config.docker.removeVolume(vol).catch(() => undefined);
        return { ok: false, reason: error instanceof Error ? error.message : "docker failure" };
      }
      const record: PreClaimRecord = {
        remoteTurnId: input.remoteTurnId,
        nonceHash,
        turnJtiHash: sha256Hex(turn.jti),
        sandboxId,
        networkName: net,
        volumeName: vol,
        containerName: sandboxId,
        createdAt: now(),
        status: "pending",
      };
      const inserted = await config.store.insertPreClaim(record);
      if (!inserted) {
        await config.docker.stopAndRemoveContainer(sandboxId).catch(() => undefined);
        await config.docker.removeNetwork(net).catch(() => undefined);
        await config.docker.removeVolume(vol).catch(() => undefined);
        return { ok: false, reason: "pre_claim_already_exists" };
      }
      const nowSec = Math.floor(now() / 1000);
      const preClaimAttestation = await signArtifact(
        {
          artifact: "pre_claim_attestation",
          schemaVersion: 1,
          remoteTurnId: input.remoteTurnId,
          bindingVersion: config.bindingVersion,
          turnJtiHash: record.turnJtiHash,
          attestationNonceHash: nonceHash,
          intendedWorkloadIdentity: workloadIdentityFor(input.remoteTurnId),
          plannedSandboxId: sandboxId,
          releaseDigest: config.releaseDigest,
          isolationMode: config.isolationMode,
          policyDigest: sha256Hex([config.policySnapshotHash, config.networkPolicyId, JSON.stringify(config.endpointAllowlist), config.egressAudience].join("|")),
          networkPolicyId: config.networkPolicyId,
          endpointAllowlist: config.endpointAllowlist,
          egressAudience: config.egressAudience,
          expiry: nowSec + 300,
          singleUse: true,
        },
        config.attestorKey,
      );
      return { ok: true, preClaimAttestation };
    },

    async deliverLease(input) {
      const record = await config.store.getPreClaim(input.remoteTurnId);
      if (!record || record.status !== "pending") return { ok: false, reason: "no_pending_pre_claim" };
      const leaseHash = sha256Hex(input.executionLease);
      const minted = await config.egressGateway.mintToken({
        executionLeaseHash: leaseHash,
        workloadIdentity: input.remoteTurnId,
        endpointAllowlist: config.endpointAllowlist,
        expiryMs: now() + 120_000,
      });
      if (!minted.ok) return { ok: false, reason: `egress mint failed: ${minted.reason}` };
      try {
        await config.docker.writeFileIntoContainer(record.containerName, "/run/remote-turn/token/token", minted.token);
        await config.docker.startContainer(record.containerName);
      } catch (error) {
        await config.egressGateway.revokeToken(minted.tokenId).catch(() => undefined);
        return { ok: false, reason: error instanceof Error ? error.message : "docker start failed" };
      }
      await config.store.updatePreClaim(input.remoteTurnId, {
        status: "started",
        executionLeaseHash: leaseHash,
        egressTokenId: minted.tokenId,
      });
      const nowSec = Math.floor(now() / 1000);
      const startProof = await signArtifact(
        {
          artifact: "start_proof",
          schemaVersion: 1,
          remoteTurnId: input.remoteTurnId,
          bindingVersion: config.bindingVersion,
          turnJtiHash: record.turnJtiHash,
          executionLeaseHash: leaseHash,
          sandboxId: record.sandboxId,
          workloadIdentity: workloadIdentityFor(input.remoteTurnId),
          releaseDigest: config.releaseDigest,
          networkPolicyId: config.networkPolicyId,
          egressTokenId: minted.tokenId,
          startTime: nowSec,
          attestorKid: config.attestorKey.kid,
        },
        config.attestorKey,
      );
      return { ok: true, startProof };
    },

    async terminate(input) {
      const record = await config.store.getPreClaim(input.remoteTurnId);
      if (!record) return { ok: false, reason: "no_pre_claim" };
      let egressRevoked = false;
      if (record.egressTokenId) {
        const revoked = await config.egressGateway.revokeToken(record.egressTokenId);
        egressRevoked = revoked.ok && revoked.ack;
      }
      await config.docker.stopAndRemoveContainer(record.containerName).catch(() => undefined);
      await config.docker.removeNetwork(record.networkName).catch(() => undefined);
      await config.docker.removeVolume(record.volumeName).catch(() => undefined);
      const nowSec = Math.floor(now() / 1000);
      const terminationProof = await signArtifact(
        {
          artifact: "termination_proof",
          schemaVersion: 1,
          remoteTurnId: input.remoteTurnId,
          executionLeaseHash: record.executionLeaseHash ?? "",
          sandboxId: record.sandboxId,
          exitResult: "deleted",
          egressRevocationAck: egressRevoked,
          egressTokenId: record.egressTokenId ?? "",
          timestamp: nowSec,
          attestorKid: config.attestorKey.kid,
        },
        config.attestorKey,
      );
      if (!egressRevoked) return { ok: false, reason: "egress revocation was not acknowledged" };
      const terminationProofDigest = sha256Hex(terminationProof);
      await config.store.updatePreClaim(input.remoteTurnId, { status: "terminated", terminationProofDigest });
      return { ok: true, terminationProof };
    },

    async sandboxState(input) {
      const record = await config.store.getPreClaim(input.remoteTurnId);
      if (!record) return { exists: false, running: false, startProofSeen: false, terminationSeen: false, egressRevoked: false, terminationProofDigest: null };
      const info = await config.docker.inspectContainer(record.containerName);
      return {
        exists: info !== null,
        running: info?.state === "running",
        startProofSeen: record.status === "started",
        terminationSeen: record.status === "terminated",
        egressRevoked: record.status === "terminated",
        terminationProofDigest: record.terminationProofDigest ?? null,
      };
    },

    async reconcileOrphans() {
      const records = await config.store.listPreClaims();
      let reaped = 0;
      for (const record of records) {
        if (record.status !== "pending") continue;
        if (now() - record.createdAt <= grace) continue;
        await config.docker.stopAndRemoveContainer(record.containerName).catch(() => undefined);
        await config.docker.removeNetwork(record.networkName).catch(() => undefined);
        await config.docker.removeVolume(record.volumeName).catch(() => undefined);
        await config.store.updatePreClaim(record.remoteTurnId, { status: "reaped" });
        reaped += 1;
      }
      return { reaped };
    },
  };
}

export function createAttestorServer(handlers: AttestorHandlers): ReturnType<typeof createServer> {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_request" }));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const rid = typeof body.remoteTurnId === "string" ? body.remoteTurnId : "";
    let out: { status: number; body: Record<string, unknown> };
    if (req.method === "POST" && url.pathname === "/attest/pre-claim") {
      const result = await handlers.requestPreClaim({
        remoteTurnId: rid,
        turnToken: typeof body.turnToken === "string" ? body.turnToken : "",
        attestationNonce: typeof body.attestationNonce === "string" ? body.attestationNonce : "",
      });
      out = result.ok
        ? { status: 200, body: { preClaimAttestation: result.preClaimAttestation } }
        : { status: 409, body: { error: "pre_claim_refused", reason: result.reason } };
    } else if (req.method === "POST" && url.pathname === "/lease") {
      const result = await handlers.deliverLease({
        remoteTurnId: rid,
        executionLease: typeof body.executionLease === "string" ? body.executionLease : "",
      });
      out = result.ok
        ? { status: 200, body: { startProof: result.startProof } }
        : { status: 409, body: { error: "lease_refused", reason: result.reason } };
    } else if (req.method === "POST" && url.pathname === "/terminate") {
      const result = await handlers.terminate({ remoteTurnId: rid });
      out = result.ok
        ? { status: 200, body: { terminationProof: result.terminationProof } }
        : { status: 409, body: { error: "terminate_refused", reason: result.reason } };
    } else if (req.method === "GET" && url.pathname === "/sandbox-state") {
      const state = await handlers.sandboxState({ remoteTurnId: url.searchParams.get("remoteTurnId") ?? "" });
      out = { status: 200, body: state as unknown as Record<string, unknown> };
    } else {
      out = { status: 404, body: { error: "not_found" } };
    }
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
}

export { verifyArtifact };
