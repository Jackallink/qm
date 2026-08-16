# yh layer runbook (Gate 3 §8) — outline

Status: draft. Each section is filled during Gate 3 Phase B implementation
and exercised once against a fresh layer checkout before acceptance
(08 §9). D0-T rows A13/B1/B5 carry the drill evidence links.

## Deploy order

1. postgres (pinned image, named volumes, non-purge) → verify `pg_isready`
2. egress-gw → attestor → remote-runtime (each: config check + health)
3. core env update (`REMOTE_TURN_*`, mTLS, `G0_CONTEXT_VERIFIER=static-keys`)
4. binding creation (see below) → enable → canary turn (G3-10)

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
