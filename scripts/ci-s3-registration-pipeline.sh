#!/usr/bin/env bash; set -euo pipefail; cd "$(dirname "$0")/.."; FAIL=0
echo "==> S3 CI: Registration Pipeline"
echo "--- 1. typecheck"; npx tsc --noEmit 2>/dev/null && echo "    [PASS]" || { echo "    [FAIL]"; FAIL=1; }
echo "--- 2. unit: security gates"
node --experimental-strip-types -e '
import { reviewAgentRegistration } from "./src/agent/registration-pipeline.ts";
import { newAgentFromTemplate } from "./src/agent/agent-registry.ts";

// Test 1: clean modeler agent passes all gates
const m1 = newAgentFromTemplate("w","test","Test","modeler","admin");
const r1 = reviewAgentRegistration(m1);
if (!r1.passed) { console.error("FAIL: clean agent rejected at gate", r1.blockedBy, r1.gates.find(g=>!g.passed)?.reason); process.exit(1); }

// Test 2: deploy+audit conflict
const m2 = newAgentFromTemplate("w","test","Bad","custom","admin",{
  capabilities: {skills:[],tags:[],operations:{deploy:true,audit:true}}
});
const r2 = reviewAgentRegistration(m2);
if (r2.passed) { console.error("FAIL: deploy+audit conflict not detected"); process.exit(1); }

// Test 3: public agent requires review
const m3 = newAgentFromTemplate("w","test","Pub","custom","admin",{
  security:{visibility:"public",acl:{invoke:[],manage:[]}}
});
const r3 = reviewAgentRegistration(m3, { isPlatformAdmin: false });
if (r3.passed) { console.error("FAIL: public agent should require platform admin"); process.exit(1); }

// Test 4: public + admin = OK
const r4 = reviewAgentRegistration(m3, { isPlatformAdmin: true });
if (!r4.passed) { console.error("FAIL: public+admin should pass"); process.exit(1); }

// Test 5: egress domain not in allowlist
const m5 = newAgentFromTemplate("w","test","EG","custom","admin",{
  security:{visibility:"private",acl:{invoke:[],manage:[]},egressPolicy:{allowedDomains:["evil.com"],allowedInternal:[]}}
});
const r5 = reviewAgentRegistration(m5, { platformAllowedDomains: ["api.deepseek.com"] });
if (r5.passed) { console.error("FAIL: evil.com should be blocked"); process.exit(1); }

console.log("all 5 scenarios PASS (clean/conflict/visibility/egress)");
' 2>/dev/null && echo "    [PASS] unit (5 scenarios)" || { echo "    [FAIL] unit"; FAIL=1; }
echo; [ "${FAIL:-0}" -eq 0 ] && echo "[OK] S3 CI" || echo "[FAIL] S3 CI"; exit ${FAIL:-0}
