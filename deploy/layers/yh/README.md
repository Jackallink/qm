# yh layer — private deployment material

Everything under `deploy/layers/yh/` is organization-specific and never travels
upstream. Per `deploy/layers/README.md`: the config, the sandbox tools, the
infrastructure coordinates, and the names of systems or people inside are
private. Secrets never enter Git — they belong in the provider's encrypted
secret store, with local values only in the gitignored `.env`.

## Contents

- `d0t-coverage.md` — D0-T per-requirement coverage table for the declared
  single-host Docker target profile (roadmap D0-T exit gate; Gate 3
  implementation starts only when this table is closed).
- `d0t-deploy-gate.md` — target-host deployment acceptance checklist. It
  turns the remaining DEPLOY-GATE rows into a single fresh-checkout drill;
  only its completed evidence can support a target-host claim.
- `qm.config.jsonc` — deployment config (committed, no secret values).
- `.env.example` — computed secret names, never values.
- `deployment.md` — operator runbook (Gate 3 §8; includes deploy order, key
  ceremony, binding procedure, rotation, parked-turn procedure, rollback).
- `plugins/remote-runtime/`, `plugins/attestor/`, `plugins/egress-gw/` —
  Gate 3 service images (`docs/specs/remote-turn-v1/08-gate3-runtime-spec.md`
  §3).
- `sandbox/` — org tools and skills for agent computers.

## Status

D0-T: **agent-closed, target-host acceptance pending** — every A/B row
carries a component owner and a machine-verifiable acceptance path (test
suites, live e2e, review sign-off; see `d0t-coverage.md` §C). The remaining
DEPLOY-GATE rows (A13, B1, B3, B5, B6, B7, B8) are on-site confirmations
executed by the deployment agent at deployment time. They do not block code
development, which is complete (core 190/190, layer 15/15, G3-01 parity,
G3-10 live full-loop e2e against real Docker + Postgres + deepseek), but they
do block a target-host or production acceptance claim. Use
`d0t-deploy-gate.md` with `deployment.md` for that drill.
