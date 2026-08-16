# yh layer runbook (Gate 3 §8) — outline

Status: draft. Each section is filled during Gate 3 Phase B implementation
and exercised once against a fresh layer checkout before acceptance
(08 §9). D0-T rows A13/B1/B5 carry the drill evidence links.

## Deploy order

1. postgres (pinned image, named volumes, non-purge) → verify `pg_isready`
2. egress-gw (`plugins/egress-gw`) → attestor (`plugins/attestor`, Docker
   socket + attestor DB) → remote-runtime (`plugins/remote-runtime`)
3. executor image build → digest pin → `ATTESTOR_RELEASE_IMAGE` +
   `ATTESTOR_RELEASE_DIGEST`
4. core env update (`REMOTE_TURN_*`, mTLS, `G0_CONTEXT_VERIFIER=static-keys`,
   `REMOTE_TURN_TRANSPORTS={"<service-id>":"<runtime-url>"}`)
5. binding creation (see below) → enable → canary turn (G3-10)

### Service env (secret names in `.env.example`)

- egress-gw: `METERING_KEY`, `EGRESS_TOKEN_SIGNING_KEY`, proxy listens on
  the per-turn internal networks (decision service at `/authorize`,
  `/usage`, `/egress-tokens`, `/usage-statement`).
- attestor: `ATTESTOR_KEY`, `ATTESTOR_PG_URL` (durable nonce/JTI + proof
  log), `ATTESTOR_RELEASE_IMAGE`, `ATTESTOR_MAX_PRECLAIM_SANDBOXES`,
  Docker socket mounted read-write (the attestor owns sandbox lifecycle).
- remote-runtime: `RUNTIME_RECEIPT_KEY`, core base URL + source-auth key
  id/secret, executor base URL (via the proxy's per-turn listener),
  attestor base URL.
- executor: `MODEL_ENDPOINT`, `MODEL_NAME`, `EGRESS_PROXY_URL`,
  `EGRESS_TOKEN_FILE=/run/remote-turn/token/token`.

## Key ceremony

- Generate each Ed25519 key (core signing, attestor, receipt, metering) and
  mTLS certs; private keys only into gitignored `.env` (0600) or the secret
  store. See `.env.example`.
- Binding: `coreVerificationKeys`, `attestorKeys`, `receiptKeys`,
  `meteringKeys` key sets with `current`/`overlap` states per 05; rotate via
  the binding rotation API (version CAS) — old keys retire after the overlap
  window.

## Binding procedure

1. Compute release digest (reproducible build, two builds equal digests)
2. Create binding (`createBinding`, version 1) with the pinned key sets
3. Enable; verify admission refuses with wrong org/scope; G3-10 canary

## Rotation

- Keys: new `overlap` entry + new binding version → old key `retiresAt`.
- Image: build → digest → sign release attestation → new binding version →
  rollback = re-enable previous version.

## Parked-turn operator procedure

1. Reconciler alert (`parkedAlertMs`) fires with turn id
2. Query attestor `sandbox-state`; if sandbox running, evaluate
3. Manual terminate via attestor `POST /terminate` (produces evidence)
4. Confirm core settles the turn; audit chain shows the full trace

## Rollback drill

- Restart each service, verify recovery (B1)
- Rotate one key and roll back (B5)
- Full A13 drill: execute once on a fresh layer checkout before acceptance
