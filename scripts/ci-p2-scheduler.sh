#!/usr/bin/env bash; set -euo pipefail; cd "$(dirname "$0")/.."; FAIL=0
echo "==> P2 CI: Scheduler"
echo "--- 1. typecheck"; npx tsc --noEmit 2>/dev/null && echo "    [PASS]" || { echo "    [FAIL]"; FAIL=1; }
echo "--- 2. unit"
node --experimental-strip-types -e '
import { DEFAULT_SCHEDULER_CONFIG } from "./src/agent/agent-scheduler.ts";
const c = DEFAULT_SCHEDULER_CONFIG;
const ok = c.maxCatchupRuns === 3 && c.maxConsecutiveFailures === 5 && c.loopThreshold === 5;
console.log(ok ? "config OK" : "FAIL"); process.exit(ok ? 0 : 1);
' 2>/dev/null && echo "    [PASS] unit" || { echo "    [FAIL] unit"; FAIL=1; }
echo; if [ "${FAIL:-0}" -eq 0 ]; then echo "[OK] P2 CI"; exit 0; else echo "[FAIL] P2 CI"; exit 1; fi
