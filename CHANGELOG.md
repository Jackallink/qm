# Changelog

## v0.2.0 — Remote Turn + multi-engine runtime (2026-08-16)

Checkpoint release of the `yh/qm-integration` branch. 151 commits past
`main` (v0.1.4).

### Remote Turn (F1) — private deployment runtime

- Full Gate 1–3: atomic admission, token/attestation chain, receipt and
  settlement, teardown with termination + egress-revocation proof,
  durable reconciliation, orphan recovery, denial audit, settle-after-
  commit. Core suite 214 tests, live e2e against real Docker + Postgres +
  deepseek, deploy/rotate/rollback drill executed.
- D0-T coverage table closed (agent-model: component owners +
  machine-verifiable acceptance); remaining rows are on-site deployment
  confirmations.
- `deploy/layers/yh/`: attestor (owns Docker socket, stopped-sandbox
  pre-claim, PG-durable proof log), remote-runtime (envelope/claim/
  receipt), egress-gw (per-turn tokens, usage metering, TLS OpenAI
  endpoint, agent proxy), executor image, compose, runbook.

### Engines (7 first-class)

- `prime` re-enabled (local child + sandbox modes, approval bridge,
  budget metering, soul-driven system prompt, autoRefine skill loop,
  sandbox image rebuilt to prime-agent 0.7.2).
- `hermes` re-enabled via a rewritten ACP (Agent Client Protocol) stdio
  client — the old REST assumption never matched Hermes v0.19.
- `claw` remains quarantined (F0); OpenClaw gateway integration is a
  separate program.

### Network-layer forced egress

- Internal per-scope sandbox networks with the egress gateway as the
  only peer; TLS transparent redirection (hosts + CA + NODE_EXTRA_CA_CERTS)
  keeps proxy-unaware runtimes (prime's Node fetch) working inside the
  enforced network.

### Notes

- `mock.module` usage removed from the F0 isolation test (removed in the
  pinned node >= 24.15).
- Test PG container (`qm-test-pg-tmp`) may need `docker start` after host
  disk pressure.
