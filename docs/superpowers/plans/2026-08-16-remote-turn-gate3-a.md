# Remote Turn Gate 3 — Phase A implementation plan

Scope: the core-side wiring half of `docs/specs/remote-turn-v1/08-gate3-runtime-spec.md` —
everything under its §5 that lives in `src/`. Phase B (layer services under
`deploy/layers/yh/plugins/`) is planned after Phase A lands and is verified
against the frozen spec. D0-T coverage-table closure
(`deploy/layers/yh/d0t-coverage.md`) is the gate before **deployment**, not
before this code work; every task below is testable with the existing pg
suites and contract doubles.

Each task follows red-test-first TDD: red tests land in the task's commit,
then the implementation, then the suite run. No comments in code (AGENTS.md).

## Task A1 — usage-statement verifier (`src/remote-turn/attestation.ts`)

New verifier for the 05 `usage_statement` artifact (05-protocol-schema.md
§usage statement): `additionalProperties:false` schema, EdDSA, `kid` ∈
binding `meteringKeys`, binds `executionLeaseHash` to the turn, positive
integer token fields within bounds.

- Tests: valid statement verifies; wrong kid / bad schema / lease-hash
  mismatch / non-EdDSA alg all rejected.
- Red tests: `test/remote-turn-attestation-transport.test.ts` extension.

## Task A2 — termination-proof verifier (`attestation.ts`)

New verifier for the 05 `termination_proof` artifact: schema-strict, EdDSA,
`kid` ∈ binding `attestorKeys`, requires `exitResult=deleted` and
`egressRevocationAck=true` and matching `egressTokenId`/`executionLeaseHash`.

- Tests: valid proof verifies; missing revocation ack / wrong exit result /
  mismatched lease hash rejected.

## Task A3 — runtime-facing control endpoints (`src/api/routes/remote-turn.ts`)

The five endpoints of 08 §5.4a: claim, start-proof, receipt, usage,
termination-proof. All mTLS + source-auth against the binding's
`transportSourceAuthKeyId` domain; fail closed. Claim binds the attestation
nonce in the CAS (already in store), returns lease to the handler only
(library call), pushes it to the attestor `POST /lease` (attestor client in
wiring), answers the runtime with hash + metadata only.

- Tests: G3-16 equivalents as core integration tests (valid/forged/expired
  JWS, wrong nonce ⇒ no_lease, lease not in HTTP response).

## Task A4 — usage-gated teardown coordinator

Receipt endpoint records (`receiveReceipt`); usage arrival or
`REMOTE_TURN_USAGE_GRACE_MS` (15s) expiry drives `beginTeardown` with the
metered usage or `null` (full charge). Statement before receipt is persisted
and applied on receipt; statement after settlement is a recorded duplicate.
Then core calls the attestor's `POST /terminate`.

- Tests: G3-17 equivalents (receipt→usage partial release; grace expiry full
  charge; usage-before-receipt; late duplicate).

## Task A5 — denial-audit visibility (08 §5.6)

`recordDenial` events gain `scope_id` (populated at admission time); the
audit read unions denial rows by scope. Cross-scope denial read stays
`not_found` + recorded.

- Tests: G3-21 equivalents in `test/remote-turn-audit-read-pg.test.ts`.

## Task A6 — settle-after-commit (08 §5.5)

Terminal listeners fire after COMMIT on the remote completion path (currently
settle inside the open transaction); exactly-once preserved via the RETURNING
row.

- Tests: wiring-level test asserting listeners observe committed state.

## Task A7 — G0 verifier + turn-flow admission entry (08 §5.1)

`G0_CONTEXT_VERIFIER=static-keys` mode verifying a governance-signed context
JWS against configured public keys; `governance_decision_id` single-use
consumption (typed `governance_replay` + audit). `src/api/app-turn.ts` routes
a G0-context request with a matching enabled binding to
`remoteTurnStore.admit`; without a G0 context the local path is unchanged.

- Tests: G3-14/G3-15 equivalents; local-path regression.

## Task A8 — transport resolver + key assembly (08 §5.2/§5.4)

`REMOTE_TURN_TRANSPORTS` env JSON (service id → base URL) resolves
`transportServiceId`; unregistered id ⇒ typed refusal; mTLS + SPKI pin
verified; dispatch failure pre-claim ⇒ reconciler resends persisted envelope
(never parked pre-claim) ⇒ `failed_pre_dispatch` at deadline.
`REMOTE_TURN_SIGNING_KEY` (Ed25519 PEM) → `RemoteTurnKeyProvider` in wiring;
missing/malformed ⇒ remote path disabled with a startup log, local turns
unaffected.

- Tests: transport negatives (unregistered, wrong pin, 5xx) + G3-19;
  signing-key assembly unit tests.

## Task A9 — reconciler production wiring + lease-push recovery (08 §5.3/§5.4a)

Wire `createRemoteTurnReconciler` with Postgres ErrorLog, attestor gateway
client, Postgres leader lease, sweeper start; `stop()` closes reconciler +
remoteTurnStore (pool refcount backlog). Claimed-state sweep retries failed
lease pushes with backoff; `REMOTE_TURN_LEASE_PUSH_DEADLINE_MS` (60s) expiry
⇒ `cancel_requested`.

- Tests: lease-push failure retry + deadline; wiring stop() closes stores.

## Task A10 — Phase A validation

Full remote-turn pg suite + run-store suites + typecheck + lint + a fresh
multi-expert review of the diff (spec-aligned), then push.

## Phase B (after A, separately planned)

Layer services under `deploy/layers/yh/plugins/`: remote-runtime, attestor,
egress-gw, immutable release, runbook, G3-01..22 layer tests, docker e2e.
Blocked on D0-T coverage closure only for deployment, not for development.
