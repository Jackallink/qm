# Remote Turn v1 Gate 2 — Upstream Generic Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the vendor-neutral Remote Turn extension in upstream QM core: `RemoteTurnStore` (Postgres), turn/abort token minting and JTI consumption, conservative budget reservation/settlement, the `remote_once` run-store guard, and the state machine with reconciliation — all red-test-first against the [Remote Turn v1 spec](../specs/remote-turn-v1/README.md) (walkthrough-approved, Gate 1 closed).

**Architecture:** A new `src/remote-turn/` module owns the durable state machine (versioned `remote_turn` projection + append-only `remote_turn_events`), the binding store, token/attestation verification, budget reservation ledger, and a leader-leased reconciler. It shares one `pg.Pool` per connection string via a memoized registry in `src/persistence/pg-pool.ts` (refcounted close), reuses the existing `lease_token + status` CAS pattern, and gains a test-only `onStep` hook + injectable clock for crash/clock negatives. Existing `RunStore`/`BudgetTracker`/`AuditLog` are untouched; the `runs` table gains `delivery_mode` and every requeue path excludes `remote_once` rows.

**Tech Stack:** Node 24+, TypeScript (type stripping), `pg` (Pool/PoolClient), `jose` (CompactSign/compactVerify, Ed25519), `node:test`, existing `createPgPool`/`withPgTransaction`/`sweeper`/`leader-lease` infra.

## Global Constraints

- Spec: `docs/specs/remote-turn-v1/README.md` (walkthrough-approved), `02-technical-trace.md` (allowed-transitions table is the normative state machine), `04-test-matrix.md` (RTH-05..13 map to Gate 2), `05-protocol-schema.md` (normative JSON Schema).
- RTH-05..RTH-13 all require Postgres; a same-process memory test is not durability evidence. Every new pg test file must be registered in `npm run test:pg` in `package.json` with coordinated DROP statements.
- `SESSION_STORE=postgres` and same-database shared pool are mandatory for admission transactions; Memory SessionStore is never accepted as evidence.
- The `runs` table change is `delivery_mode TEXT NOT NULL DEFAULT 'local'`; every requeue path (`retire` retry branch, `reapExpired`, worker heartbeat-cancel, `releaseInFlight`, drain sweeper, `claim` session guard) excludes `remote_once`.
- Terminal states (`completed`, `rejected`, `failed_pre_dispatch`, `failed`, `cancelled`) are never rewritten. Reconciliation rewrites only `parked` (→ `completed`/`cancelled` with proof, or → `failed` when no sandbox ever started).
- All persisted deadlines use the database clock (`transaction_timestamp()`); app clock only for JWT `nbf`/`exp` with 30s skew on `nbf`/`iat` only.
- `admissionKey` is a partial unique index over non-terminal states; ownership is proven by `runs.lease_token` + version CAS, never by the derivable hash.
- Every persisted deadline, JTI, nonce, lease value: CSPRNG ≥128-bit; only SHA-256 hashes stored.
- No comments in code (AGENTS.md); no new dependencies beyond what the repo already has.
- Gate 2 does NOT include: real runtime, attestor, egress gateway, G0 verifier, binding enablement, canary. Those are Gate 3+.

---

### Task 1: Shared pg pool registry (memoized, refcounted)

**Files:**
- Modify: `src/persistence/pg-pool.ts`
- Test: `test/persistence-pool-registry.test.ts`

**Interfaces:**
- Consumes: existing `createPgPool(connectionString, statements)` and `PgPool` interface.
- Produces: `export function sharedPgPool(connectionString: string, statements: string[]): PgPool` — returns a memoized `PgPool` per connection string (DDL applied once on first creation), with `close()` decrementing a refcount and ending the underlying pool only at zero. `createPgPool` keeps its current behavior for existing callers.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedPgPool } from "../src/persistence/pg-pool.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "requires DATABASE_URL";

test("sharedPgPool memoizes one pool per connection string and refcounts close", { skip }, async () => {
  const a = sharedPgPool(URL!, ["SELECT 1"]);
  const b = sharedPgPool(URL!, ["SELECT 1"]);
  assert.equal(a, b, "same connection string returns the same PgPool");
  const c = sharedPgPool("postgres://other.invalid/x", []);
  assert.notEqual(a, c);
  await a.close(); // refcount 2 -> 1: underlying pool still usable
  await b.query("SELECT 1");
  await b.close(); // refcount 1 -> 0: pool ends
  await assert.rejects(() => b.query("SELECT 1"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `RUNTIME_NODE=/Users/jakeliu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node "$RUNTIME_NODE" --test --test-concurrency=1 test/persistence-pool-registry.test.ts`
Expected: FAIL — `sharedPgPool is not exported`.

- [ ] **Step 3: Implement the registry**

In `src/persistence/pg-pool.ts`, add a module-level `Map<string, { pool: PgPool; refs: number }>`; `sharedPgPool` returns the existing entry or creates one via the existing `createPgPool`; `close()` on the shared wrapper decrements refs and ends the pool at zero. Ensure DDL statements are applied once (the memoized entry owns them).

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2.
Expected: PASS.

- [ ] **Step 5: Run existing pg suite for regressions**

Run: `cd /Users/jakeliu/Workspace/qm && RUNTIME_NODE=... "$RUNTIME_NODE" --test --test-concurrency=1 test/postgres-store.test.ts test/persistence-init-retry.test.ts`
Expected: PASS (existing behavior unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/persistence/pg-pool.ts test/persistence-pool-registry.test.ts package.json
git commit -m "feat(remote-turn): shared pg pool registry with refcounted close"
```

---

### Task 2: `runs.delivery_mode` + remote-once requeue guards

**Files:**
- Modify: `src/runs/postgres-run-store.ts` (DDL, `retire`, `reapExpired`, `claim`, `claimById`, `releaseLease`), `src/runs/run-store.ts` (Run type + `RunStore` interface), `src/runs/worker.ts` (heartbeat-cancel, `releaseInFlight`), `src/runs/drain.ts`
- Test: `test/run-store-remote-once.test.ts` (pg) + extend `test/run-store.test.ts` if memory store needs the column

**Interfaces:**
- Consumes: `Run["deliveryMode"]` on the Run type.
- Produces: `Run["deliveryMode"]: "local" | "remote_once"`, `EnqueueInput.deliveryMode?: "local" | "remote_once"`, and all requeue paths excluding `remote_once` rows.

- [ ] **Step 1: Write failing tests**

```ts
// test/run-store-remote-once.test.ts (pg, skip without DATABASE_URL)
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
// enqueue a remote_once run, claim it, then simulate lease expiry and reap:
// expect requeued=0 for the remote_once row (it must NOT come back as pending),
// while a local run with an expired lease still requeues.
```

Test asserts: after `reapExpired()`, the `remote_once` row stays `running` (not requeued, not failed); a `local` row with expired lease returns to `pending`. Second test: `claim()` must not return a `remote_once` row (session guard excludes them), and `claimById` on a `remote_once` row returns null.

- [ ] **Step 2: Run tests to verify they fail**

Run: `"$RUNTIME_NODE" --test --test-concurrency=1 test/run-store-remote-once.test.ts`
Expected: FAIL — `deliveryMode` not on type / remote rows requeue.

- [ ] **Step 3: Implement**

Add `delivery_mode TEXT NOT NULL DEFAULT 'local'` to the runs DDL (with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). Thread `deliveryMode` through `EnqueueInput`, `rowToRun`, `Run`. In `retire()`: requeue branch adds `AND delivery_mode='local'`; in `reapExpired()`: the requeue UPDATE adds the same guard (remote rows are left `running`); `claim`/`claimById` session guard excludes `session_id` rows whose runs include `delivery_mode='remote_once'`; `releaseLease` no-ops for `remote_once`; `worker.ts` heartbeat-cancel and `releaseInFlight` skip `remote_once`; `drain.ts` likewise.

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2.
Expected: PASS.

- [ ] **Step 5: Run existing run-store suites**

Run: `"$RUNTIME_NODE" --test --test-concurrency=1 test/run-store.test.ts test/postgres-store.test.ts test/cron-queue.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runs/ test/run-store-remote-once.test.ts
git commit -m "feat(remote-turn): runs.delivery_mode remote-once requeue guards"
```

---

### Task 3: `remote_turn` + `remote_turn_events` schema and binding store

**Files:**
- Create: `src/remote-turn/schema.ts`, `src/remote-turn/binding-store.ts`
- Test: `test/remote-turn-binding.test.ts` (pg)

**Interfaces:**
- Produces: `RemoteRuntimeBinding` type (per spec README field list + `receiptKeySet`/`meteringKeySet` ordered entries), `createRemoteBindingStore(connectionString: string): RemoteBindingStore` with `createBinding(input): Promise<BindingRecord>`, `getBinding(bindingId): Promise<BindingRecord | null>`, `setEnabled(bindingId, enabled, actor): Promise<{ version: number }>` (versioned, CAS on current version), `listBindings(): Promise<BindingRecord[]>`.
- DDL: `remote_runtime_binding(id TEXT PK, version INT, enabled BOOL, configured_org_id TEXT, allowed_scope_id TEXT, protocol_version INT, runtime_audience TEXT, transport_service_id TEXT, transport_certificate_pin TEXT, release_digest TEXT, release_attestation_key_id TEXT, receipt_key_set_version INT, metering_key_set_version INT, max_input_bytes INT, max_history_messages INT, max_output_bytes INT, max_runtime_ms INT, token_ttl_ms INT, budget_ceiling_usd NUMERIC, key_sets JSONB, policy_snapshot_hash TEXT, created_by TEXT, created_at BIGINT, disabled_by TEXT, disabled_at BIGINT)`; `remote_turn_events(id BIGSERIAL, remote_turn_id TEXT, seq INT, event_type TEXT, payload JSONB, created_at BIGINT)`.

- [ ] **Step 1: Write failing tests** (create → get → versioned enable → disable race: two concurrent `setEnabled` calls, one wins via version CAS)

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement schema.ts + binding-store.ts** following the inline-DDL convention (`createPgPool(connectionString, ddl)`), version CAS `UPDATE ... SET version=version+1, enabled=$2 WHERE id=$1 AND version=$3`.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/remote-turn/ test/remote-turn-binding.test.ts package.json
git commit -m "feat(remote-turn): binding store with versioned enable/disable CAS"
```

---

### Task 4: `remote_turn` projection + state machine transitions (pure logic first)

**Files:**
- Create: `src/remote-turn/state-machine.ts` (pure), `src/remote-turn/store.ts` (pg projection)
- Test: `test/remote-turn-state-machine.test.ts` (pure, table-driven)

**Interfaces:**
- Produces (pure): `type RemoteTurnStatus = "created" | "session_bound" | "admitted" | "dispatching" | "claimed" | "executing" | "reply_received" | "teardown_pending" | "cancel_requested" | "parked" | "completed" | "rejected" | "failed_pre_dispatch" | "failed" | "cancelled"`; `canTransition(from: RemoteTurnStatus, event: RemoteTurnEvent): boolean`; `nextState(from, event): RemoteTurnStatus`; the full allowed-transitions table from spec 02 as data; illegal (state × event) pairs rejected.
- Events include: `session_bind`, `admit`, `prepare_dispatch`, `abort_pre_claim`, `claim`, `start`, `receipt`, `teardown`, `complete`, `abort`, `timeout`, `park`, `reconcile_completed`, `reconcile_cancelled`, `reconcile_failed`, `reject_deadline`, `expire_pre_dispatch`, `duplicate_receipt`.

- [ ] **Step 1: Write failing table-driven tests** — every legal transition from spec 02's allowed-transitions table (assert `canTransition` true), plus every illegal pair (assert false). Include the four terminal states' immutability: `completed`/`rejected`/`failed_pre_dispatch`/`failed`/`cancelled` accept no events.

- [ ] **Step 2: Run tests to verify they fail** (module missing)

- [ ] **Step 3: Implement `state-machine.ts`** — encode the table as data, `canTransition`/`nextState` as pure functions.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/remote-turn/state-machine.ts test/remote-turn-state-machine.test.ts
git commit -m "feat(remote-turn): pure state machine with full transition matrix"
```

---

### Task 5: Admission transaction (session bind + RemoteTurn + audit + reservation)

**Files:**
- Modify: `src/remote-turn/store.ts`
- Test: `test/remote-turn-store-pg.test.ts` (pg)

**Interfaces:**
- Consumes: `sharedPgPool`, `withPgTransaction`, `createRemoteBindingStore`, session store's transaction-bound `getOrCreateByThreadOn(client, ...)` (add this variant to `src/sessions/postgres-session-store.ts`), `state-machine.ts`.
- Produces: `admit(input: AdmitInput): Promise<AdmitResult>` — locks enabled binding, validates G0 context (interface placeholder `G0Context`), bounds, resolves/creates session (ON CONFLICT DO NOTHING + FOR UPDATE re-select), INSERTs `remote_turn(created→session_bound→admitted)` with version CAS, writes `remote_turn_events`, reserves budget (Task 7), returns `{ status: "admitted", remoteTurnId }` with no JTI. Denials return `{ status: "refused", reason: "governance_authorization_required" | ... }` with durable denial event and no reservation.
- `AdmitInput`: `{ bindingId, g0: G0Context, conversationKey, scopeId, actorId, text, history }`; `G0Context` is a minimal interface `{ actorId, scopeId, conversationKey, governanceDecisionId, governanceAuthorizationDigest, traceId }` — the real verifier is Gate 3, this is the consumption contract.

- [ ] **Step 1: Write failing tests** — happy path commits all four artifacts in one transaction (assert session row, remote_turn row, events row, reservation row); missing/denied G0 leaves no rows and records denial; concurrent admission for the same thread_ref serializes via `thread_ref UNIQUE` (one wins, other waits and gets the same session); crash at each `onStep` (session-bound / remote-turn-insert / reservation+audit / pre-commit) leaves no dispatchable row — implement via the store's test-only `onStep(label)` hook terminated with `SELECT pg_terminate_backend(pg_backend_pid())`.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement** — `src/remote-turn/store.ts` with `admit()`, `onStep` hook, `opts.now`, shared-pool transaction with fixed lock order session → RemoteTurn → reservation → audit.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Register in `npm run test:pg`** in `package.json` and run the full pg suite once.

- [ ] **Step 6: Commit**

```bash
git add src/remote-turn/store.ts src/sessions/postgres-session-store.ts test/remote-turn-store-pg.test.ts package.json
git commit -m "feat(remote-turn): atomic admission transaction with session bind and audit"
```

---

### Task 6: Budget reservation/settlement ledger

**Files:**
- Create: `src/remote-turn/budget-ledger.ts`
- Test: `test/remote-turn-budget-pg.test.ts` (pg)

**Interfaces:**
- Produces: `reserveBudget(tx, { scopeId, bindingId, remoteTurnId, ceilingUsd }): Promise<{ reservationId, reservedUsd }>` — single guarded `UPDATE budget_balances SET available_usd = available_usd - $x WHERE scope_id=$1 AND window_anchor_ms=$2 AND available_usd >= $x`, inserts `budget_reservations(status='reserved')`; `settleReservation(tx, { reservationId, trustedUsageUsd | null, invalidMetering: boolean }): Promise<"released" | "charged" | "parked">` — trusted usage releases `(ceiling - trusted)`; missing usage → `charged` (full); invalid metering → stays `reserved` (park).

- [ ] **Step 1: Write failing tests** — reservation insufficient balance refuses admission typed; concurrent reservations both pass a guard (single statement, no check-then-insert); settlement three-way outcomes; full-charge on missing usage; release on trusted usage; invalid metering leaves reservation held.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement** `src/remote-turn/budget-ledger.ts` with the two-table model from spec 02/README (`budget_reservations`, `budget_balances`).

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/remote-turn/budget-ledger.ts test/remote-turn-budget-pg.test.ts package.json
git commit -m "feat(remote-turn): guarded budget reservation and settlement ledger"
```

---

### Task 7: Turn/abort token minting + JTI consumption (claim)

**Files:**
- Create: `src/remote-turn/tokens.ts`
- Test: `test/remote-turn-token-abort.test.ts` (pg)

**Interfaces:**
- Produces: `mintTurnToken(payload: TurnClaims, keys: CoreTokenKeySet): Promise<string>` and `verifyTurnToken(token, keys, now): Promise<TurnClaims | null>` (jose CompactSign/compactVerify, Ed25519, kid from the binding's pinned set); `mintAbortToken(abortClaims, keys)`, `verifyAbortToken`; `claim(tx, { remoteTurnId, turnJtiHash, attestationNonceHash, now }): Promise<LeaseResult>` — atomic JTI consumption with the CAS guard `UPDATE remote_turn SET status='claimed', execution_lease_hash=$2, version=version+1 WHERE id=$1 AND status='dispatching' AND turn_jti_hash=$3 AND abort_requested_at IS NULL AND version=$4`; zero rows → `{ ok: false, reason: "no_lease" }`; on success mints the lease-bound abort authority (post-claim abort token with `executionLeaseHash` + `coreRunId`).
- `CoreTokenKeySet` per spec 05: `{ kid, publicKeyPem, state: "current" | "overlap", activatedAt, retiresAt }[]`.

- [ ] **Step 1: Write failing tests** — valid turn token verifies; forged/expired/early/wrong-audience/wrong-capability/wrong-kid/unknown-kid/retired-kid rejected; claim consumes JTI once (second claim → no lease); abort-before-claim revokes turn JTI and pending claim refused; post-claim abort token carries `executionLeaseHash` + `coreRunId`; skew applies to nbf/iat only (exp never extended); duplicate claim with regenerated JTI fails; excess clock skew (>30s) rejected.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement** `tokens.ts` per `05-protocol-schema.md` (canonical claim serialization, envelopeDigest over the 8-field tuple).

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/remote-turn/tokens.ts test/remote-turn-token-abort.test.ts package.json
git commit -m "feat(remote-turn): turn/abort token minting, verification, and atomic claim"
```

---

### Task 8: `prepareDispatch` idempotency + pre-claim expiry

**Files:**
- Modify: `src/remote-turn/store.ts`
- Test: `test/remote-turn-recovery-pg.test.ts` (pg)

**Interfaces:**
- Produces: `prepareDispatch(tx, { remoteTurnId, leaseToken, envelope, now }): Promise<DispatchResult>` — partial unique index on `admission_key` over non-terminal states; writes turn JTI hash, attestation nonce hash, dispatch owner/attempt, `preClaimExpiresAt` (DB clock) before any network call; only the lease-owner (runs.lease_token + version CAS) may resume pre-claim states; `expirePreClaim(remoteTurnId, now)` → `failed_pre_dispatch` with JTI revoked, reservation/lease released; restart resends only the persisted envelope (no new JTI/nonce).

- [ ] **Step 1: Write failing tests** — pre-claim restart resends same envelope (assert persisted JTI/nonce unchanged); regenerated JTI/nonce rejected; `admission_key` partial unique allows identical re-send after terminal; five-minute pre-admission and pre-dispatch deadlines (injectable clock) → `rejected`/`failed_pre_dispatch` with reservation/session-lease release; cross-instance via two independent pools on the same DB — instance A's prepareDispatch is visible to instance B and B cannot mint a second JTI.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement** in `store.ts` using `transaction_timestamp()` for persisted deadlines; the partial unique index in DDL.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/remote-turn/store.ts test/remote-turn-recovery-pg.test.ts
git commit -m "feat(remote-turn): prepareDispatch idempotency and pre-claim expiry"
```

---

### Task 9: Receipt verification + settlement + teardown completion

**Files:**
- Modify: `src/remote-turn/tokens.ts` (receipt verify), `src/remote-turn/store.ts` (transitions)
- Test: `test/remote-turn-receipt-budget-teardown.test.ts` (pg)

**Interfaces:**
- Produces: `verifyReceipt(token, receiptKeySetSnapshot, expected: {...}): Promise<ReceiptClaims | null>` (schema per 05, `status: "completed"` const, key-set snapshot at admission, `current ∪ overlap`); store transitions `executing → reply_received` (valid receipt), `reply_received → teardown_pending` (trusted usage), `teardown_pending → completed` (attestor deletion + egress revocation proof — Gate 3 provides real proofs, here the store accepts a `TerminationEvidence` interface double); `reply_received → parked` (invalid metering).

- [ ] **Step 1: Write failing tests** — valid receipt moves executing→reply_received; wrong/retired key, bad signature, wrong lease/input/release digest, schema violation (unknown field, >16 KiB reply byte-bound), duplicate completed receipt (ignored + audit), late post-cancel receipt (ignored), missing trusted usage → full charge; invalid metering → parked; teardown with deletion+revocation proof → completed; without proof → parked.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement** per spec 05.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/remote-turn/tokens.ts src/remote-turn/store.ts test/remote-turn-receipt-budget-teardown.test.ts
git commit -m "feat(remote-turn): receipt verification, settlement, and teardown completion"
```

---

### Task 10: Reconciliation worker (leader-leased) + abort/disable

**Files:**
- Create: `src/remote-turn/reconciler.ts`
- Modify: `src/remote-turn/store.ts` (abort, disable, park)
- Test: `test/remote-turn-reconciler-pg.test.ts` (pg)

**Interfaces:**
- Produces: `createRemoteTurnReconciler({ store, attestor, clock? }): { sweep(): Promise<ReconcileResult> }` — leader-leased via existing `leader-lease.ts` (`remote-turn:reconcile` key), queries `parked`/`dispatching` timeout rows, uses the binding mTLS identity to query the attestor channel (interface `AttestorGateway` with `querySandboxState(remoteTurnId): Promise<SandboxState>`), transitions `parked → completed|cancelled|failed` with version CAS + evidence digest; parked >24h → operator alert (no auto-charge, no lease release); `abort(remoteTurnId, actor)` and `disable(bindingId, actor)` with durable abort request/JTI and enumerate-active-turns listing `cancelled|parked|failed` per target.

- [ ] **Step 1: Write failing tests** — sweep reconciles parked with attestor proof (no second lease); reconciliation cannot rewrite a terminal record; `parked → failed` when attestor shows no sandbox ever started (full reservation release); 24h alert threshold (injectable clock); abort during dispatching revokes JTI and refuses claim; disable enumerates and parks/cancels targets with typed per-target results; concurrent reconciliation CAS (two sweepers, one wins).

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement** `reconciler.ts` + store abort/disable.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/remote-turn/reconciler.ts src/remote-turn/store.ts test/remote-turn-reconciler-pg.test.ts
git commit -m "feat(remote-turn): leader-leased reconciliation and abort/disable"
```

---

### Task 11: Error contract + audit read + wire-up

**Files:**
- Modify: `src/remote-turn/store.ts` (typed errors), `src/api/server.ts` (register nothing user-facing; only the audit-read contract), `src/wiring.ts` (construct the store when `SESSION_STORE=postgres` and a remote-turn binding is configured)
- Test: `test/remote-turn-error-contract.test.ts`, `test/remote-turn-audit-read-pg.test.ts`

**Interfaces:**
- Produces: typed error outcomes from spec 03 (`remote_refused: governance_authorization_required`, `remote_refused: runtime_not_enabled`, `remote_unavailable: admission_not_committed`, `remote_parked: execution_uncertain`, `remote_parked: receipt_unverified`, `remote_refused: receipt_ignored`, `remote_partial_rollback`, `remote_refused: invocation_denied`); `readAuditChain(scopeId, operatorId): Promise<RemoteTurnEvent[]>` enforcing scope authority and recording the read.

- [ ] **Step 1: Write failing tests** — every error-table row maps to its typed outcome with durable evidence; audit read authorized returns only that scope's chain after restart; cross-scope read gets `not_found` with no ID leak and records denied read.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement** — error mapping in store; audit read with scope check; wiring constructs RemoteTurnStore from the shared pool when postgres session store is active.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Run the full pg suite** (`npm run test:pg`) and `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add src/remote-turn/ src/wiring.ts test/remote-turn-error-contract.test.ts test/remote-turn-audit-read-pg.test.ts
git commit -m "feat(remote-turn): typed error contract, audit read, and wiring"
```

---

### Task 12: Gate 2 validation record

**Files:**
- Create: `docs/specs/remote-turn-v1/07-gate2-validation.md`
- Modify: `docs/specs/remote-turn-v1/README.md` (Status: add Gate 2 line)

**Interfaces:**
- Produces: a validation record mapping every RTH-05..RTH-13 acceptance to its test file and result, the full pg suite result, typecheck result, and any drift notes (per D0-L `05-validation-and-drift.md` precedent).

- [ ] **Step 1: Write the validation record** — table of RTH → test file → status; record the pg suite + typecheck outputs verbatim.

- [ ] **Step 2: Update README Status** — add `Gate 2: upstream generic extension implemented, red-test-first; validation in 07-gate2-validation.md. D0-T/G0/X0 evidence still required before Gate 2 completion sign-off and any binding enablement/canary.`

- [ ] **Step 3: Commit**

```bash
git add docs/specs/remote-turn-v1/
git commit -m "docs(spec): record Gate 2 validation for Remote Turn v1"
```

---

## Self-Review Checklist

- [ ] **Spec coverage:** RTH-05 (Task 5), RTH-06 (Task 5), RTH-07 (Task 7), RTH-08 (Task 7 + attestation contract via TerminationEvidence double; layer egress in Gate 3), RTH-09 (Task 8 + Task 10), RTH-10 (Task 9), RTH-11 (Task 10), RTH-12 (Task 11), RTH-13 (Task 11). RTH-01..04 and RTH-14 are Gate 0/1/layer-scope, not Gate 2.
- [ ] **Placeholder scan:** every task has concrete test code or a concrete implementation description; no "TBD".
- [ ] **Type consistency:** `deliveryMode` (Task 2) is consumed by Tasks 5/8/10 via `remote_once` run rows; `admit()` returns `{ status: "admitted", remoteTurnId }` (Task 5) consumed by `prepareDispatch` (Task 8); `budget-ledger` functions (Task 6) consumed by Task 5 admission and Task 9 settlement; `tokens.ts` claim (Task 7) consumed by Task 10 abort. All names match.
- [ ] **D0-T note:** Task 12 records that D0-T/G0/X0 evidence is still outstanding; Gate 2 sign-off is deferred per spec README Status until those pass.
