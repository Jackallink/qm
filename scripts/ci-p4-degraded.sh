#!/usr/bin/env bash; set -euo pipefail; cd "$(dirname "$0")/.."; FAIL=0
echo "==> P4 CI: Degraded Mode"
echo "--- 1. typecheck"; npx tsc --noEmit 2>/dev/null && echo "    [PASS]" || { echo "    [FAIL]"; FAIL=1; }
echo "--- 2. unit: health + degraded logic"
node --experimental-strip-types -e '
import { initAgentHealth, agentHeartbeat, controlPlaneHeartbeat, checkControlPlane, isOperationAllowed, getAgentHealth } from "./src/agent/degraded-mode.ts";
const now = Date.now();
// Test 1: normal flow
initAgentHealth("a");
controlPlaneHeartbeat("a");
if (checkControlPlane("a") !== "normal") { console.error("FAIL: should be normal"); process.exit(1); }
// Test 2: timeout → degraded
const h = getAgentHealth("a")!; h.lastControlPlaneContact = now - 35000; // 35s ago > 30s timeout
if (checkControlPlane("a") !== "degraded") { console.error("FAIL: should be degraded after timeout"); process.exit(1); }
// Test 3: degraded blocks writes
const op = isOperationAllowed("a", "write");
if (op.allowed) { console.error("FAIL: write should be blocked in degraded mode"); process.exit(1); }
// Test 4: read allowed in degraded
const op2 = isOperationAllowed("a", "read");
if (!op2.allowed) { console.error("FAIL: read should be allowed in degraded mode"); process.exit(1); }
// Test 5: recovery
controlPlaneHeartbeat("a");
if (checkControlPlane("a") !== "normal") { console.error("FAIL: should recover after heartbeat"); process.exit(1); }
console.log("all 5 scenarios PASS (normal/degraded/block-write/allow-read/recover)");
' 2>/dev/null && echo "    [PASS] unit (5 scenarios)" || { echo "    [FAIL] unit"; FAIL=1; }
echo; [ "${FAIL:-0}" -eq 0 ] && echo "[OK] P4 CI" || echo "[FAIL] P4 CI"; exit ${FAIL:-0}
