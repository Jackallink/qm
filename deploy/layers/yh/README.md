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
- `qm.config.jsonc` — deployment config (committed, no secret values).
- `.env.example` — computed secret names, never values.
- `deployment.md` — operator runbook (Gate 3 §8; includes deploy order, key
  ceremony, binding procedure, rotation, parked-turn procedure, rollback).
- `plugins/remote-runtime/`, `plugins/attestor/`, `plugins/egress-gw/` —
  Gate 3 service images (`docs/specs/remote-turn-v1/08-gate3-runtime-spec.md`
  §3).
- `sandbox/` — org tools and skills for agent computers.

## Status

D0-T: **open** — coverage table drafted (this directory), org fields (owner /
acceptor / host coordinates) pending. Gate 3 implementation is blocked on the
table's closure per the spec's gate discipline (08 §1.1 / §9).
