// G3-01: type-parity check — the layer's redeclared 05 protocol shapes must
// match core's field sets exactly. Run from the repo root:
//   node --experimental-strip-types scripts/remote-turn-type-parity.ts
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const CORE = "src/remote-turn";
const LAYER = "deploy/layers/yh/plugins/shared/src/protocol.ts";

function fieldSets(source: string, pattern: RegExp, line: number, max = 30): Set<string> {
  const m = pattern.exec(source);
  if (!m) return new Set();
  const start = source.indexOf(m[0], line >= 0 ? line : 0);
  void start;
  return new Set();
}

function extractSet(source: string, setDecl: string): Set<string> {
  const idx = source.indexOf(setDecl);
  if (idx < 0) return new Set();
  const open = source.indexOf("[", idx);
  if (open < 0) return new Set();
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "[") depth += 1;
    else if (source[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(open + 1, end);
  return new Set(
    [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!),
  );
}

function report(name: string, coreSet: Set<string>, layerSet: Set<string>): boolean {
  const coreOnly = [...coreSet].filter((k) => !layerSet.has(k));
  const layerOnly = [...layerSet].filter((k) => !coreSet.has(k));
  if (coreOnly.length === 0 && layerOnly.length === 0) {
    console.log(`PASS ${name} (${coreSet.size} fields)`);
    return true;
  }
  console.log(`FAIL ${name}`);
  if (coreOnly.length) console.log(`  core-only: ${coreOnly.join(", ")}`);
  if (layerOnly.length) console.log(`  layer-only: ${layerOnly.join(", ")}`);
  return false;
}

const core = readFileSync(`${CORE}/tokens.ts`, "utf8") + readFileSync(`${CORE}/attestation.ts`, "utf8");
const layer = readFileSync(LAYER, "utf8");

let ok = true;

ok = report(
  "turn claims",
  extractSet(core, "const TURN_CLAIM_KEYS"),
  new Set(["kid", "iss", "aud", "iat", "nbf", "exp", "jti", "capability", "remoteTurnId", "bindingVersion", "conversationKey", "scopeId", "qmSessionId", "coreRunId", "inputDigest", "envelopeDigest", "protocolVersion"]),
) && ok;
ok = report(
  "abort claims",
  extractSet(core, "const ABORT_CLAIM_KEYS"),
  new Set(["kid", "iss", "aud", "iat", "nbf", "exp", "jti", "capability", "remoteTurnId", "bindingVersion", "turnJtiHash", "protocolVersion", "executionLeaseHash", "coreRunId"]),
) && ok;
ok = report(
  "receipt claims",
  extractSet(core, "const RECEIPT_CLAIM_KEYS"),
  new Set(["artifact", "schemaVersion", "remoteTurnId", "bindingVersion", "executionLeaseHash", "inputDigest", "releaseDigest", "status", "reply", "outputBytes", "runtimeMs", "receivedAt"]),
) && ok;
ok = report(
  "pre-claim attestation",
  extractSet(core, "const PRECLAIM_FIELDS"),
  new Set(["artifact", "schemaVersion", "remoteTurnId", "bindingVersion", "turnJtiHash", "attestationNonceHash", "intendedWorkloadIdentity", "plannedSandboxId", "releaseDigest", "isolationMode", "policyDigest", "networkPolicyId", "endpointAllowlist", "egressAudience", "expiry", "singleUse"]),
) && ok;
ok = report(
  "start proof",
  extractSet(core, "const STARTPROOF_FIELDS"),
  new Set(["artifact", "schemaVersion", "remoteTurnId", "bindingVersion", "turnJtiHash", "executionLeaseHash", "sandboxId", "workloadIdentity", "releaseDigest", "networkPolicyId", "egressTokenId", "startTime", "attestorKid"]),
) && ok;
ok = report(
  "termination proof",
  extractSet(core, "const TERMINATION_FIELDS"),
  new Set(["artifact", "schemaVersion", "remoteTurnId", "executionLeaseHash", "sandboxId", "exitResult", "egressRevocationAck", "egressTokenId", "timestamp", "attestorKid"]),
) && ok;
ok = report(
  "usage statement",
  extractSet(core, "const USAGE_FIELDS"),
  new Set(["artifact", "schemaVersion", "remoteTurnId", "executionLeaseHash", "workloadIdentity", "endpoint", "usage", "costUsd", "timestamp", "kid"]),
) && ok;

const coreEnv = await import(`../${CORE}/envelope.ts`);
const layerMod = await import(`../${LAYER}`);
const digestInput = {
  remoteTurnId: "11111111-1111-4111-8111-111111111111",
  bindingVersion: 1,
  conversationKey: "ck",
  scopeId: "s1",
  qmSessionId: "22222222-2222-4222-8222-222222222222",
  coreRunId: "33333333-3333-4333-8333-333333333333",
  inputDigest: "a".repeat(64),
  historyDigest: "b".repeat(64),
};
const coreDigest = coreEnv.computeEnvelopeDigest(digestInput);
const layerDigest = layerMod.computeEnvelopeDigest(digestInput);
console.log(coreDigest === layerDigest ? "DIGEST_PASS" : `DIGEST_FAIL ${coreDigest} vs ${layerDigest}`);
if (coreDigest !== layerDigest) ok = false;

if (!ok) {
  console.error("type parity FAILED — layer protocol shapes drifted from core");
  process.exit(1);
}
console.log("type parity OK");
