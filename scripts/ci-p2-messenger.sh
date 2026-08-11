#!/usr/bin/env bash
set -euo pipefail; cd "$(dirname "$0")/.."; FAIL=0
echo "==> P2 CI: Messenger"
echo "--- 1. typecheck"
npx tsc --noEmit 2>/dev/null && echo "    [PASS]" || { echo "    [FAIL]"; FAIL=1; }
echo "--- 2. unit"
node --experimental-strip-types -e '
import { DEFAULT_MESSENGER_CONFIG } from "./src/agent/agent-messenger.ts";
const c = DEFAULT_MESSENGER_CONFIG;
const ok = c.timeWindowMs > 0 && c.maxRetries === 3 && c.loopThreshold === 5;
console.log(ok ? "config OK" : "FAIL");
process.exit(ok ? 0 : 1);
' 2>/dev/null && echo "    [PASS] unit" || { echo "    [FAIL] unit"; FAIL=1; }
echo; [ $FAIL -eq 0 ] && echo "[OK] P2 CI" || echo "[FAIL] P2 CI"; exit $FAIL
