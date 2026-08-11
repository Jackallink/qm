#!/usr/bin/env bash
# Gateway 全量 CI — 依次运行所有模块测试
# 用法: bash scripts/ci-gateway.sh
# cron: 0 */6 * * * cd ~/Workspace/qm && bash scripts/ci-gateway.sh
set -euo pipefail; cd "$(dirname "$0")/.."
TOTAL=0; PASSED=0; FAILED=0
for ci in scripts/ci-p0-agent-registry.sh scripts/ci-p1-sop-engine.sh scripts/ci-p2-messenger.sh scripts/ci-p2-scheduler.sh; do
  TOTAL=$((TOTAL + 1))
  echo "=== $(basename $ci) ==="
  if bash "$ci" 2>&1 | tail -3; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "    [SKIP/FATAL] continuing..."
  fi
  echo
done
echo "==> Gateway CI: $PASSED/$TOTAL passed, $FAILED failed"
exit $FAILED
