#!/usr/bin/env bash
# Build the prime-agent sandbox image (qm-sandbox-prime:latest).
# Base: qm-sandbox-base:dev (from fly/Dockerfile) → local/Dockerfile.prime
# The prime-agent checkout is passed as an extra build context so its dist
# bundle can be copied in without polluting the qm build context.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_TAG="qm-sandbox-base:dev"
PRIME_TAG="${PRIME_SANDBOX_IMAGE:-qm-sandbox-prime:latest}"
PLATFORM="linux/amd64"
# Prime build context = the installed npm package directory (0.7.2).
PRIME_PKG="${PRIME_AGENT_PKG:-$(dirname "$(which prime-agent)")/../lib/node_modules/prime-agent}"

echo "==> building ${BASE_TAG} from fly/Dockerfile (${PLATFORM})"
docker build --platform "${PLATFORM}" -f fly/Dockerfile -t "${BASE_TAG}" .

echo "==> building ${PRIME_TAG} from local/Dockerfile.prime (prime pkg: ${PRIME_PKG})"
if [ -n "${PRIME_PREWARM_KEY:-}" ]; then
  docker build --platform "${PLATFORM}" -f local/Dockerfile.prime \
    --build-context "prime=${PRIME_PKG}" \
    --build-arg "DEEPSEEK_API_KEY=${PRIME_PREWARM_KEY}" \
    -t "${PRIME_TAG}" .
else
  echo "    (no PRIME_PREWARM_KEY — kernel will cold-bootstrap on first turn)"
  docker build --platform "${PLATFORM}" -f local/Dockerfile.prime \
    --build-context "prime=${PRIME_PKG}" \
    -t "${PRIME_TAG}" .
fi

echo "==> done: ${PRIME_TAG}"
