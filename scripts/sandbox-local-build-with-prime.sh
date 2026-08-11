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
PRIME_CHECKOUT="${PRIME_AGENT_CHECKOUT:-../prime-agent}"

echo "==> building ${BASE_TAG} from fly/Dockerfile (${PLATFORM})"
docker build --platform "${PLATFORM}" -f fly/Dockerfile -t "${BASE_TAG}" .

echo "==> building ${PRIME_TAG} from local/Dockerfile.prime (prime checkout: ${PRIME_CHECKOUT})"
# PRIME_PREWARM_KEY: set to a provider API key to bootstrap the kernel venv
# at build time (eliminates first-turn cold start).
if [ -n "${PRIME_PREWARM_KEY:-}" ]; then
  docker build --platform "${PLATFORM}" -f local/Dockerfile.prime \
    --build-context "prime=${PRIME_CHECKOUT}" \
    --build-arg "DEEPSEEK_API_KEY=${PRIME_PREWARM_KEY}" \
    -t "${PRIME_TAG}" .
else
  echo "    (no PRIME_PREWARM_KEY — kernel will cold-bootstrap on first turn)"
  docker build --platform "${PLATFORM}" -f local/Dockerfile.prime \
    --build-context "prime=${PRIME_CHECKOUT}" \
    -t "${PRIME_TAG}" .
fi

echo "==> done: ${PRIME_TAG}"
