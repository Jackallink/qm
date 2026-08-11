#!/usr/bin/env bash; set -euo pipefail; cd "$(dirname "$0")/.."; FAIL=0
echo "==> S1 CI: Compliance Engine"
echo "--- 1. typecheck"; npx tsc --noEmit 2>/dev/null && echo "    [PASS]" || { echo "    [FAIL]"; FAIL=1; }
echo "--- 2. unit: compliance snapshot"
node --experimental-strip-types -e '
import { generateComplianceSnapshot } from "./src/agent/compliance-engine.ts";
import { newAgentFromTemplate } from "./src/agent/agent-registry.ts";
const m = newAgentFromTemplate("w", "test", "Test", "modeler", "admin");
// Test 1: clean agent = no gaps
const r1 = generateComplianceSnapshot(m, {}, 0, Date.now());
if (r1.score !== 100) { console.error("FAIL: clean agent should score 100, got", r1.score); process.exit(1); }
// Test 2: unauthorized data access
const r2 = generateComplianceSnapshot(m, { accessedSources: ["secret_docs"] }, 0, Date.now());
if (r2.score >= 100) { console.error("FAIL: unauthorized access should reduce score"); process.exit(1); }
if (r2.gaps.length < 1 || r2.gaps[0].severity !== "critical") { console.error("FAIL: unauthorized access should be critical"); process.exit(1); }
// Test 3: model mismatch
const r3 = generateComplianceSnapshot(m, { modelUsed: "other-model" }, 0, Date.now());
if (!r3.gaps.some(g => g.dimension === "model_usage")) { console.error("FAIL: model mismatch not detected"); process.exit(1); }
// Test 4: idle agent
m.lastActiveAt = Date.now() - 10 * 86400 * 1000;
const r4 = generateComplianceSnapshot(m, {}, 0, Date.now());
if (!r4.gaps.some(g => g.dimension === "lifecycle")) { console.error("FAIL: idle agent not detected"); process.exit(1); }
console.log("all compliance checks PASS (clean:" + r1.score + " breach:" + r2.score + " model:" + r3.score + " idle:" + r4.score + ")");
' 2>/dev/null && echo "    [PASS] unit (4 scenarios)" || { echo "    [FAIL] unit"; FAIL=1; }
echo; [ "${FAIL:-0}" -eq 0 ] && echo "[OK] S1 CI" || echo "[FAIL] S1 CI"; exit ${FAIL:-0}
