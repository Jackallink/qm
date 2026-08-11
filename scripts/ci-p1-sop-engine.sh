#!/usr/bin/env bash
set -euo pipefail; cd "$(dirname "$0")/.."; FAIL=0
echo "==> P1 CI: SOP Engine"
echo "--- 1. typecheck"
npx tsc --noEmit 2>/dev/null && echo "    [PASS]" || { echo "    [FAIL]"; FAIL=1; }
echo "--- 2. unit: gate logic"
node --experimental-strip-types -e '
import { nextGate, canRollbackTo, newSopRun, isStale } from "./src/agent/sop-engine.ts";
let ok = true;
if (nextGate(0) !== 1) { console.error("nextGate(0) != 1"); ok = false; }
if (nextGate(5) !== null) { console.error("nextGate(5) != null"); ok = false; }
if (!canRollbackTo(3, 0)) { console.error("canRollbackTo(3,0) should be true"); ok = false; }
if (canRollbackTo(0, 3)) { console.error("canRollbackTo(0,3) should be false"); ok = false; }
const run = newSopRun("t","m","w","a");
if (run.gates.length !== 1) { console.error("new SopRun should have 1 gate"); ok = false; }
if (!ok) process.exit(1);
console.log("next/rollback/new OK");
' 2>/dev/null && echo "    [PASS] unit" || { echo "    [FAIL] unit"; FAIL=1; }
echo "--- 3. API smoke"
if curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:8081/ 2>/dev/null | grep -q 401; then
  RID="ci-sop-$(date +%s)"
  C=$(ADMIN_ACTOR="jakeliu@acme" node scripts/dev/api.mjs POST "/v1/admin/workspaces/org:acme/sop-runs" "{\"modelId\":\"ci-test\",\"agentId\":\"tester\",\"id\":\"$RID\"}" 2>/dev/null)
  if echo "$C" | grep -q '"run"'; then
    echo "    [PASS] sop create"
    ADMIN_ACTOR="jakeliu@acme" node scripts/dev/api.mjs POST "/v1/sop-runs/$RID/gates/0/sign" '{"productHash":"ci"}' >/dev/null 2>&1
    H=$(ADMIN_ACTOR="jakeliu@acme" node scripts/dev/api.mjs GET "/v1/sop-runs/$RID/history" 2>/dev/null)
    if echo "$H" | grep -q '"done"'; then echo "    [PASS] sop sign + history"; else echo "    [FAIL] sop sign"; FAIL=1; fi
  else echo "    [FAIL] sop create"; FAIL=1; fi
else echo "    [SKIP] core not running"; fi
echo; [ $FAIL -eq 0 ] && echo "[OK] P1 CI" || echo "[FAIL] P1 CI"; exit $FAIL
