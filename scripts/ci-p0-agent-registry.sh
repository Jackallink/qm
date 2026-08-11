#!/usr/bin/env bash
# P0 CI — Agent Registry 冒烟测试
# 用法: bash scripts/ci-p0-agent-registry.sh
# cron: 0 */6 * * * cd ~/Workspace/qm && bash scripts/ci-p0-agent-registry.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> P0 CI: Agent Registry"
FAIL=0

# ---- 1. Typecheck ----
echo "--- 1. typecheck"
if npx tsc --noEmit 2>/dev/null; then
  echo "    [PASS] typecheck"
else
  echo "    [FAIL] typecheck"
  FAIL=1
fi

# ---- 2. Unit: template validity ----
echo "--- 2. templates"
TMPL=$(node --experimental-strip-types -e '
import { AGENT_TEMPLATES } from "./src/agent/agent-manifest.ts";
const ids = Object.keys(AGENT_TEMPLATES);
console.log(ids.join(","));
process.exit(ids.length === 3 ? 0 : 1);
' 2>/dev/null)
if [ "$TMPL" = "modeler,auditor,custom" ]; then
  echo "    [PASS] templates: $TMPL"
else
  echo "    [FAIL] templates: got '$TMPL'"
  FAIL=1
fi

# ---- 3. Unit: state transitions ----
echo "--- 3. state machine"
STATES=$(node --experimental-strip-types -e '
import { isValidStatusTransition } from "./src/agent/agent-registry.ts";
const tests = [
  ["draft","deploying"], ["deploying","online"], ["deploying","error"],
  ["online","stopping"], ["online","error"], ["stopping","stopped"],
  ["stopped","deploying"], ["error","deploying"], ["error","stopping"],
];
let ok = true;
for (const [from, to] of tests) {
  if (!isValidStatusTransition(from, to)) { console.error("FAIL:", from, "->", to); ok = false; }
}
// Invalid transitions should be rejected
if (isValidStatusTransition("online", "draft")) { console.error("FAIL: online->draft should be invalid"); ok = false; }
if (!ok) process.exit(1);
console.log(tests.length + " valid + 1 invalid OK");
' 2>/dev/null)
if [ $? -eq 0 ]; then
  echo "    [PASS] state machine"
else
  echo "    [FAIL] state machine"
  FAIL=1
fi

# ---- 4. API smoke (if core running) ----
echo "--- 4. API smoke (if core running)"
if curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:8081/ 2>/dev/null | grep -q "401"; then
  echo "    [PASS] core reachable"
  TEST_ID="ci-smoke-$(date +%s)"
  WS="org:acme"
  CREATE_OUT=$(ADMIN_ACTOR="jakeliu@acme" node scripts/dev/api.mjs POST "/v1/admin/workspaces/$WS/agents" "$(cat <<EOJSON
{"id":"$TEST_ID","name":"CI Smoke Test","template":"custom"}
EOJSON
)" 2>/dev/null)
  if echo "$CREATE_OUT" | grep -q '"agent"'; then
    echo "    [PASS] agent create"
    ADMIN_ACTOR="jakeliu@acme" node scripts/dev/api.mjs PUT "/v1/admin/workspaces/$WS/agents/$TEST_ID" '{"status":"deploying"}' >/dev/null 2>&1
    ADMIN_ACTOR="jakeliu@acme" node scripts/dev/api.mjs PUT "/v1/admin/workspaces/$WS/agents/$TEST_ID" '{"status":"online"}' >/dev/null 2>&1
    VERIFY=$(ADMIN_ACTOR="jakeliu@acme" node scripts/dev/api.mjs GET "/v1/admin/workspaces/$WS/agents/$TEST_ID" 2>/dev/null)
    if echo "$VERIFY" | grep -q '"online"'; then
      echo "    [PASS] agent lifecycle (draft->deploying->online)"
    else
      echo "    [FAIL] agent lifecycle"
      FAIL=1
    fi
    ADMIN_ACTOR="jakeliu@acme" node scripts/dev/api.mjs DELETE "/v1/admin/workspaces/$WS/agents/$TEST_ID" >/dev/null 2>&1
  else
    echo "    [FAIL] agent create (got: $(echo "$CREATE_OUT" | head -1))"
    FAIL=1
  fi
else
  echo "    [SKIP] core not running"
fi

# ---- result ----
echo
if [ "${FAIL:-0}" -eq 0 ]; then
  echo "[OK] P0 CI: all checks passed"
  exit 0
else
  echo "[FAIL] P0 CI: $FAIL check(s) failed"
  exit 1
fi
