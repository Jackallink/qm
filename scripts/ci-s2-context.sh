#!/usr/bin/env bash; set -euo pipefail; cd "$(dirname "$0")/.."; FAIL=0
echo "==> S2 CI: Context Exchange Protocol"
echo "--- 1. typecheck"; npx tsc --noEmit 2>/dev/null && echo "    [PASS]" || { echo "    [FAIL]"; FAIL=1; }
echo "--- 2. unit"
node --experimental-strip-types -e '
import { createContextExchange, validateContextExchange, primeContextAdapter, PROTOCOL_VERSION } from "./src/agent/context-exchange.ts";
// Test 1: create + validate
const ex = createContextExchange("a", "b", "model_reference", { model_id: "test" });
if (!validateContextExchange(ex)) { console.error("FAIL: valid exchange rejected"); process.exit(1); }
// Test 2: version check
if (ex.protocolVersion !== PROTOCOL_VERSION) { console.error("FAIL: wrong version"); process.exit(1); }
// Test 3: reject invalid
if (validateContextExchange(null) || validateContextExchange({}) || validateContextExchange({protocolVersion:"wrong"})) {
  console.error("FAIL: invalid data accepted"); process.exit(1);
}
// Test 4: Prime adapter
const packed = primeContextAdapter.pack("model_reference", { model_id: "m1", health_score: 99 });
const unpacked = primeContextAdapter.unpack(packed) as Record<string,unknown>;
if (unpacked.type !== "model_reference" || unpacked.from !== "prime-agent") { console.error("FAIL: adapter roundtrip"); process.exit(1); }
console.log("create/validate/adapter OK (v" + PROTOCOL_VERSION + ")");
' 2>/dev/null && echo "    [PASS] unit" || { echo "    [FAIL] unit"; FAIL=1; }
echo; [ "${FAIL:-0}" -eq 0 ] && echo "[OK] S2 CI" || echo "[FAIL] S2 CI"; exit ${FAIL:-0}
