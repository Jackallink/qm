import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { exportKeyToPem, signArtifact, verifyArtifact, type KeySetEntry } from "../../shared/src/protocol.ts";
import { createAttestor, createMemoryAttestorStore, type AttestorConfig, type DockerClient, type EgressGatewayClient } from "../src/index.ts";

const UUID = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);

function keys(kid = "k1"): { privateKeyPem: string; keySet: KeySetEntry[]; now: number } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const now = Date.now();
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    keySet: [{ kid, publicKeyPem: exportKeyToPem(publicKey), state: "current", activatedAt: now - 1000, retiresAt: now + 100_000 }],
    now,
  };
}

interface FakeDocker {
  pulls: string[];
  networks: string[];
  volumes: string[];
  containers: Map<string, { state: string; files: Map<string, string> }>;
  docker: DockerClient;
}

function fakeDocker(): FakeDocker {
  const state: FakeDocker = {
    pulls: [],
    networks: [],
    volumes: [],
    containers: new Map(),
    docker: {} as DockerClient,
  };
  state.docker = {
    pullImage: async (image) => { state.pulls.push(image); },
    createNetwork: async (name) => { state.networks.push(name); },
    createVolume: async (name) => { state.volumes.push(name); },
    createContainer: async (spec) => {
      state.containers.set(spec.name, { state: "created", files: new Map() });
      return spec.name;
    },
    startContainer: async (id) => { state.containers.get(id)!.state = "running"; },
    stopAndRemoveContainer: async (id) => { state.containers.delete(id); },
    removeNetwork: async (name) => { state.networks = state.networks.filter((n) => n !== name); },
    removeVolume: async (name) => { state.volumes = state.volumes.filter((v) => v !== name); },
    inspectContainer: async (name) => {
      const c = state.containers.get(name);
      return c ? { id: name, name, state: c.state } : null;
    },
    listContainersByLabel: async () => [],
    writeFileInContainer: async (id, path, content) => {
      const c = state.containers.get(id);
      if (c) c.files.set(path, content);
    },
  };
  return state;
}

function fakeEgress(): { client: EgressGatewayClient; state: { mints: number; revokes: string[] } } {
  const state = { mints: 0, revokes: [] as string[] };
  return {
    client: {
      mintToken: async () => { state.mints += 1; return { ok: true, token: `egress-token-${state.mints}`, tokenId: `egt-${state.mints}` }; },
      revokeToken: async (tokenId) => { state.revokes.push(tokenId); return { ok: true, ack: true }; },
    },
    state,
  };
}

function config(overrides: Partial<AttestorConfig> = {}): { config: AttestorConfig; core: ReturnType<typeof keys>; attestorKeys: KeySetEntry[]; docker: FakeDocker; egress: ReturnType<typeof fakeEgress> } {
  const core = keys();
  const attestor = keys("attestor-k1");
  const docker = fakeDocker();
  const egress = fakeEgress();
  const cfg: AttestorConfig = {
    attestorKey: { kid: "attestor-k1", privateKeyPem: attestor.privateKeyPem },
    coreVerificationKeys: core.keySet,
    runtimeAudience: "urn:qm:v1:runtime:test",
    releaseDigest: HASH,
    releaseImage: "ghcr.io/yh/executor:v1",
    networkPolicyId: "net-pol-1",
    endpointAllowlist: ["https://api.deepseek.com"],
    egressAudience: "urn:qm:egress:1",
    isolationMode: "container",
    maxPreClaimSandboxes: 2,
    preClaimReapGraceMs: 1000,
    egressGateway: egress.client,
    docker: docker.docker,
    store: createMemoryAttestorStore(),
    bindingVersion: 1,
    ...overrides,
  };
  return { config: cfg, core, attestorKeys: attestor.keySet, docker, egress };
}

async function signedTurnToken(core: ReturnType<typeof keys>, aud: string, remoteTurnId = UUID): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return signArtifact(
    {
      kid: "k1", iss: "urn:qm:core", aud, iat: nowSec, nbf: nowSec, exp: nowSec + 90,
      jti: "jti-1234567890abcdef", capability: "turn", remoteTurnId, bindingVersion: 1,
      conversationKey: "ck", scopeId: "s1", qmSessionId: "22222222-2222-4222-8222-222222222222",
      coreRunId: "33333333-3333-4333-8333-333333333333",
      inputDigest: HASH, envelopeDigest: HASH, protocolVersion: 1,
    },
    { kid: "k1", privateKeyPem: core.privateKeyPem },
  );
}

test("pre-claim creates a stopped sandbox, attests, then lease starts it and revokes on terminate", async () => {
  const { config: cfg, core, attestorKeys, docker, egress } = config();
  const attestor = createAttestor(cfg);
  const token = await signedTurnToken(core, cfg.runtimeAudience);
  const pre = await attestor.requestPreClaim({ remoteTurnId: UUID, turnToken: token, attestationNonce: "nonce-1234567890abcdef" });
  assert.equal(pre.ok, true);
  if (!pre.ok) return;
  assert.equal(docker.pulls.length, 1, "the pinned image is pulled");
  assert.equal(docker.containers.size, 1, "a container exists");
  assert.equal(docker.containers.get(`rt-sb-${UUID.slice(0, 8)}`)!.state, "created", "the sandbox is stopped pre-claim");

  const verifiedPre = await verifyArtifact(pre.preClaimAttestation, attestorKeys, Date.now());
  assert.ok(verifiedPre);
  assert.equal(verifiedPre!.artifact, "pre_claim_attestation");
  assert.equal(verifiedPre!.plannedSandboxId, `rt-sb-${UUID.slice(0, 8)}`);
  assert.equal(verifiedPre!.singleUse, true);
  assert.equal((verifiedPre as Record<string, unknown>).executionLeaseHash, undefined, "no lease in the pre-claim");

  const lease = await attestor.deliverLease({ remoteTurnId: UUID, executionLease: "raw-lease-value" });
  assert.equal(lease.ok, true);
  if (!lease.ok) return;
  assert.equal(docker.containers.get(`rt-sb-${UUID.slice(0, 8)}`)!.state, "running", "the sandbox starts after the lease");
  const tokenFile = docker.containers.get(`rt-sb-${UUID.slice(0, 8)}`)!.files.get("/run/remote-turn/token/token");
  assert.ok(tokenFile?.startsWith("egress-token-"), "the egress token is written to the mounted volume");
  assert.equal(egress.state.mints, 1);

  const startProof = await verifyArtifact(lease.startProof, attestorKeys, Date.now());
  assert.ok(startProof);
  assert.equal(startProof!.artifact, "start_proof");
  assert.equal(startProof!.executionLeaseHash, "020c9698acc1fd1576bddf9d4e0853ab3253b33587c83aee5c9d2008afea448d", "start proof binds the sha256 of the raw lease");

  const term = await attestor.terminate({ remoteTurnId: UUID });
  assert.equal(term.ok, true);
  assert.equal(egress.state.revokes.length, 1, "the egress token is revoked on terminate");
  assert.equal(docker.containers.size, 0, "the sandbox is deleted");
  const termProof = await verifyArtifact(term.terminationProof, attestorKeys, Date.now());
  assert.ok(termProof);
  assert.equal(termProof!.egressRevocationAck, true);
});

test("pre-claim refuses a forged token and enforces the capacity cap", async () => {
  const { config: cfg, core } = config({ maxPreClaimSandboxes: 1 });
  const attestor = createAttestor(cfg);
  const forged = await attestor.requestPreClaim({ remoteTurnId: UUID, turnToken: "forged.jws", attestationNonce: "n" });
  assert.equal(forged.ok, false);
  const token = await signedTurnToken(core, cfg.runtimeAudience);
  const first = await attestor.requestPreClaim({ remoteTurnId: UUID, turnToken: token, attestationNonce: "nonce-1" });
  assert.equal(first.ok, true);
  const secondToken = await signedTurnToken(core, cfg.runtimeAudience, "22222222-2222-4222-8222-222222222222");
  const second = await attestor.requestPreClaim({ remoteTurnId: "22222222-2222-4222-8222-222222222222", turnToken: secondToken, attestationNonce: "nonce-2" });
  assert.equal(second.ok, false, "the capacity cap refuses a second pre-claim");
  assert.equal(second.ok ? "" : second.reason, "attestor_capacity");
});

test("reaper destroys pre-claims that never claim", async () => {
  const { config: cfg, core, docker } = config({ preClaimReapGraceMs: 0 });
  const attestor = createAttestor(cfg);
  const token = await signedTurnToken(core, cfg.runtimeAudience);
  const pre = await attestor.requestPreClaim({ remoteTurnId: UUID, turnToken: token, attestationNonce: "nonce-1" });
  assert.equal(pre.ok, true);
  const result = await attestor.reconcileOrphans();
  assert.equal(result.reaped, 1);
  assert.equal(docker.containers.size, 0);
  const state = await attestor.sandboxState({ remoteTurnId: UUID });
  assert.equal(state.terminationSeen, false, "reaping produces no proof artifact");
  assert.equal(state.exists, false);
});
