#!/usr/bin/env bash
# Local CI pipeline for qm-sandbox-prime image.
# Usage: bash scripts/ci-build-prime-image.sh [--push]
#
# Without --push: build + tag locally only.
# With --push: also push to a registry (set PRIME_REGISTRY env, e.g.
#   docker.io/yourorg or localhost:5000).
#
# Prerequisites:
#   - PRIME_PREWARM_KEY (provider API key for kernel bootstrap at build time)
#   - Docker daemon running
#   - prime-agent checkout at ../prime-agent (or set PRIME_AGENT_CHECKOUT)
#
# Idempotent: skips rebuild if the prime dist hash hasn't changed since the
# last tagged build (compare against docker inspect label).

set -euo pipefail
cd "$(dirname "$0")/.."

PRIME_CHECKOUT="${PRIME_AGENT_CHECKOUT:-../prime-agent}"
PRIME_REGISTRY="${PRIME_REGISTRY:-}"
IMAGE_BASE="${PRIME_SANDBOX_IMAGE_BASE:-qm-sandbox-prime}"
PLATFORM="linux/amd64"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
GIT_REF="$(git -C "$PRIME_CHECKOUT" rev-parse --short HEAD 2>/dev/null || echo "unknown")"

# ── 1. Compute source fingerprint ──
DIST_HASH="$(find "$PRIME_CHECKOUT/packages/coding-agent/dist" -type f -exec sha256sum {} \; 2>/dev/null | sort | sha256sum | cut -c1-16 || echo "unknown")"
echo "==> dist hash: $DIST_HASH (git: $GIT_REF)"

# ── 2. Check if rebuild is needed ──
LATEST_TAG="${IMAGE_BASE}:latest"
if docker image inspect "$LATEST_TAG" >/dev/null 2>&1; then
  EXISTING_HASH="$(docker image inspect -f '{{index .Config.Labels "prime.dist-hash"}}' "$LATEST_TAG" 2>/dev/null || echo "")"
  if [ "$EXISTING_HASH" = "$DIST_HASH" ]; then
    echo "==> image $LATEST_TAG is current (hash $DIST_HASH). Skip rebuild."
    exit 0
  fi
  echo "==> existing hash: $EXISTING_HASH → rebuilding"
else
  echo "==> no existing image → building"
fi

# ── 3. Build ──
IMAGE_TAG="${IMAGE_BASE}:${TIMESTAMP}-${GIT_REF}"
echo "==> building $IMAGE_TAG (platform $PLATFORM)"

docker build --platform "$PLATFORM" \
  -f local/Dockerfile.prime \
  --build-context "prime=${PRIME_CHECKOUT}" \
  --build-arg "DEEPSEEK_API_KEY=${PRIME_PREWARM_KEY:-}" \
  --label "prime.dist-hash=${DIST_HASH}" \
  --label "prime.git-ref=${GIT_REF}" \
  --label "prime.built-at=${TIMESTAMP}" \
  -t "$IMAGE_TAG" \
  -t "$LATEST_TAG" \
  .

echo "==> built: $IMAGE_TAG"

# ── 4. Quick smoke test ──
echo "==> smoke test: prime RPC get_state in container..."
CONTAINER_ID=$(docker run -d --rm "$IMAGE_TAG" 2>/dev/null)
sleep 3
SMOKE_OK=$(docker exec "$CONTAINER_ID" bash -c 'echo "{\"type\":\"get_state\"}" | timeout 30 node /opt/prime-agent/dist/bundle/cli.js --mode rpc --no-session 2>/dev/null | grep -c "success.*true" || echo 0' 2>/dev/null)
docker rm -f "$CONTAINER_ID" >/dev/null 2>&1
if [ "$SMOKE_OK" -gt 0 ]; then
  echo "==> smoke test: PASS"
else
  echo "==> smoke test: FAIL (image may still be usable; check logs)"
fi

# ── 5. Push (optional) ──
if [ "${1:-}" = "--push" ] && [ -n "$PRIME_REGISTRY" ]; then
  REGISTRY_TAG="${PRIME_REGISTRY}/${IMAGE_TAG}"
  REGISTRY_LATEST="${PRIME_REGISTRY}/${IMAGE_BASE}:latest"
  echo "==> pushing to $REGISTRY_TAG"
  docker tag "$IMAGE_TAG" "$REGISTRY_TAG"
  docker tag "$IMAGE_TAG" "$REGISTRY_LATEST"
  docker push "$REGISTRY_TAG"
  docker push "$REGISTRY_LATEST"
  echo "==> pushed: $REGISTRY_TAG"
fi

echo "==> done: $IMAGE_TAG"
