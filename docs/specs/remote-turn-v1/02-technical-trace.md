# Round 2 — Technical Trace and Data Contract

## Ownership boundary

| Component | Owner | V1 responsibility |
| --- | --- | --- |
| Generic Remote Turn extension | Upstream QM core | Verified context, binding store, RemoteTurn transaction/state, budget reservation, audit evidence, token/JTI/lease validation, receipt validation, reconciliation policy. |
| Existing normal-turn queue/session | Upstream QM core | Uses a Postgres SessionStore in the same transaction domain to create/resolve/bind the real QM Session before remote dispatch, retains a remote-specific lease, blocks deletion while nonterminal, and delivers a final reply only after verified teardown. It must not let generic reaper retry remote-once execution. |
| Remote runtime release | Selected private deployment layer | Fixed protocol endpoint, immutable image release, private source-auth/mTLS channel, text-only vendor bridge. |
| Deployment attestor and egress gateway | Selected private deployment layer | Produce signed release/sandbox/network evidence, enforce model-only egress, issue/revoke scoped egress access, prove sandbox deletion. |
| Deployment controller | Selected private deployment layer | Authenticated binding release/disable/rotation procedure and operational report. |

No vendor-specific implementation enters upstream core. No generic core secret is passed to the runtime.

## V1 bounded envelope

The core constructs `RemoteTurnInput` from verified QM state. It contains only `remoteTurnId`, `conversationKey`, `scopeId`, bound `qmSessionId`, binding/version, plain UTF-8 current user text, up to eight prior plaintext user/assistant messages selected from the current actor's authorized visible-session projection, an input digest, fixed protocol version, and the turn token. Participant-window, scope, privacy, and concurrent-conversation checks apply before each history item is selected. It never includes raw browser identity/cookies, attachments, files, tool calls/results, filesystem paths, full session tape, arbitrary system text, provider credentials, or environment variables.

The binding rejects input above 32 KiB, output above 16 KiB, runtime over 60 seconds, and token lifetime over 90 seconds. The runtime has an ephemeral empty workspace and returns exactly one final plaintext reply plus receipt.

## Happy-path trace

| Step | Component | Action | Durable evidence / user outcome |
| --- | --- | --- | --- |
| 1 | Existing QM surface | Accepts a normal authenticated text turn. Any request-level harness/model choice is ignored/rejected for Remote Turn selection. | Normal QM refusal on invalid identity/input; no RemoteTurn exists on refusal. |
| 2 | G0 context verifier and QM context resolver | Normal runtime selection keeps a direct QM request without G0 context non-remote. For a candidate remote turn, verifies the designated-entry server context and current governance authorization/decision for the exact actor, configured-org scope, and conversation correlation; then derives canonical target scope, actor, and server-authorized `conversationKey`, and produces history only from the actor-visible participant window. | Governance authorization digest/decision ID, correlation and context/history digests record after policy accepts them. An explicit Remote Turn admission attempt without valid G0 context returns a typed denial and audit event. |
| 3 | Binding resolver | Locks the enabled `RemoteRuntimeBinding` version for the configured organization/scope and validates bounds and non-legacy selection. | Binding/version/policy/release hashes are snapshotted. |
| 4 | Postgres session and turn binder | In one transaction domain, resolves/creates `Session.id`, creates `RemoteTurn(created)`, atomically binds `qmSessionId`, and adds a restrict-delete reference for the nonterminal turn. | `session_bound`; a thread reference is never treated as session ID. A crash leaves no authority or an unclaimed bindable record. |
| 5 | Admission transaction | Locks the binding; writes `RemoteTurn(session_bound -> admitted)`, immutable audit evidence, and conservative scoped budget reservation in one transaction. It creates no turn token, nonce, or remote authority. | If any write fails, transaction rolls back and the user receives typed `remote_unavailable`; no dispatch occurs. |
| 6 | Dispatch coordinator | Moves `admitted -> dispatching`, issues a turn token/JTI and attestation nonce with input digest and expiry, then sends the fixed private `POST /turn` envelope through the binding-pinned transport resolver. | Dispatch time, token-JTI hash, nonce hash, request digest, correlation ID, and service identity persist before the network call. |
| 7 | Remote runtime | Verifies source-auth/mTLS, pinned transport identity, envelope schema, token claims, and bounds. Before it creates a sandbox, it presents the turn token and attestation nonce to core `claim`. | Invalid request is rejected with no sandbox. |
| 8 | Core claim and attestor | Atomically consumes the turn JTI once, with the claim guard `status='dispatching' AND turn_jti_hash=$2 AND abort_requested_at IS NULL AND version=$v`. Core verifies binding-pinned single-use attestation for exact turn/JTI/nonce/workload/release/network/egress facts and that the attestor verified the core-signed envelope (persisting (nonce, JTI) single-use state) before attesting; only then returns one execution lease and notifies the attestor of the issued lease directly over its mTLS interface, and the gateway injects a scoped egress token into that workload identity. | `dispatching -> claimed`; repeated claim receives no usable lease. |
| 9 | Runtime sandbox | Starts the fixed vendor RPC command as the attested workload with the one lease and empty ephemeral workspace. It has no provider key or full core environment. | `claimed -> executing`; attested sandbox ID and start time persist. |
| 10 | Runtime receipt | Returns one bounded plaintext reply and signed receipt bound to `remoteTurnId` with binding/lease/input/release digests and `status: "completed"`. A runtime that cannot produce a valid completed receipt is treated as having produced none: the sweeper enforces the 60-second ceiling and the turn parks or cancels. There is no separate runtime-failure artifact in v1. | Valid receipt moves only `executing -> reply_received`; no reply is surfaced yet. |
| 11 | Trusted settlement and teardown | Core validates the receipt, retrieves a binding-pinned gateway/provider usage statement, moves `reply_received -> teardown_pending`, revokes egress, and requests attestor deletion. | Missing trusted usage charges full reservation; invalid metering parks. No final reply is delivered while teardown is pending. |
| 12 | Completion | Core verifies attestor deletion and egress-revocation proof, settles the durable budget/audit chain, then moves `teardown_pending -> completed`. | Only now does the existing QM surface receive one final reply; no reusable process/session state remains. |

## Dispatch and recovery semantics

The network boundary is deliberately asymmetric:

- `created` and `session_bound` have no remote authority. Their five-minute pre-admission deadline rejects the record and releases the remote-session lease if the idempotent admission owner does not finish.
- `admitted` has a reservation but no JTI/nonce/remote authority. Its five-minute pre-dispatch deadline rejects the record and releases reservation/session lease if the same idempotent owner does not run `prepareDispatch`.
- `prepareDispatch` is the sole JTI/nonce issuance point. It atomically persists the exact envelope and moves `admitted -> dispatching`. Before claim, a restarted worker may resend only that same envelope; it may not mint a replacement authority.
- Before the runtime consumes the JTI, a dispatch can expire as `failed_pre_dispatch`; core revokes the JTI and no sandbox may claim it afterwards.
- Once JTI consumption returns an execution lease, loss of network/worker/runtime/receipt certainty moves the RemoteTurn to `parked`. The reaper cannot release/requeue it.
- Reconciliation is an explicitly invoked, audited operation performed by a leader-leased reconciliation worker or a deployment controller with mTLS identity. It queries the trusted attestor and runtime receipt/status channel with the binding's mTLS identity, then records a proven final result or leaves the item parked. It never creates a second lease. A `parked` turn older than 24 hours produces an operator alert and appears in the parked-age report; it never auto-charges the reservation or releases the session lease on a timer, because a parked turn may still be executing and releasing the lease would permit a concurrent second dispatch. The reservation is released only after reconciliation establishes the truth: no sandbox/lease consumption proves `failed` with full release; missing usage statement after proven execution keeps the full conservative charge (hard invariant 9).
- The generic queue must gain a `remote_once` recovery policy that delegates to this state machine, or the RemoteTurn extension must use a dedicated generic worker. Current `RunStore.reapExpired()` retry behavior is incompatible and may not be applied to remote work.

## Binding lifecycle trace

### Enable

The deployment controller authenticates with the configured deployment credential. In one transaction it writes or versions an immutable binding, records a durable audit event, and marks it `enabled`. It returns `bindingId`, version, scope, release digest, and a structured status. It has no browser/API fallback.

### Disable / rollback

The deployment controller locks the binding and marks it disabled before it lists active RemoteTurns. Competing admissions lock the same version, so they either finish before disable or are rejected after it; none start from an unlocked binding. The coordinator issues separate abort authority for each active turn, asks the attestor to terminate sandbox IDs, revokes egress credentials, and persists per-turn proof. The outcome lists `cancelled`, `parked`, and `failed` IDs separately. Only an empty failed/parked set yields full rollback success.

### User abort

A verified QM user invokes the existing normal-run abort action using the visible run ID. Before any runtime request, the RemoteTurn signal adapter verifies the same run/session visibility and canonical scope checks used for the normal turn. It writes a durable abort request, atomically creates an abort JTI, and transitions an active RemoteTurn to `cancel_requested`; core alone sends the abort capability to the runtime. The action returns `accepted` only after this durable transition, while final status remains pending until trusted termination proof. An unauthorized, cross-scope, terminal, duplicate, or stale abort returns the typed result without a runtime call. A browser/client disconnect creates no abort request.

### Audit read

V1 has no browser admin route. A deployment-controlled read-only operational procedure accepts a canonical scope and authenticated audit-operator identity, verifies that authority outside the Remote Runtime, and returns only that scope's durable RemoteTurn/audit chain. It records the audit read. Cross-scope requests return no existence information.

## Token, key, and receipt lifecycle

| Item | Source and storage | Validation |
| --- | --- | --- |
| Turn JTI | Generated in admission/dispatch transaction; only hash stored | One atomic core claim, exact `turn` capability, input digest, scope/conversation/session/run/binding/audience, `kid`, and bounded clock skew. |
| Abort JTI | Separate generated value, hash stored only when an abort is requested | One atomic abort claim; cannot call `/turn`; binds the turn's `turnJtiHash` before claim (the only stable pre-claim identity) and the execution lease after claim, exact run/binding/audience. The lease-bound abort authority is minted atomically inside the claim transaction. |
| Execution lease | Core-generated opaque one-time value, hash stored | Returned only after turn JTI and trusted attestation pass; required for receipt and termination proof. |
| Receipt key | Binding-pinned versioned public key set | Signature/key ID/release digest/lease/input digest/status/usage schema/freshness must match. Rotation uses explicit current+overlap key IDs only. |
| Pre-claim attestation key | Binding-pinned public key | Signature must bind turn, binding version, turn-JTI, nonce, intended workload/sandbox, release digest, isolation mode, network-policy ID, endpoint allowlist, egress audience, expiry, and single use. It must not bind an unissued lease. |
| Start/termination attestation key | Binding-pinned public key | Start and termination signatures bind the issued execution lease to the actual workload/sandbox identity, release digest, timestamps, and deletion result. Core verifies `startProof.sandboxId == preClaim.plannedSandboxId` and `startProof.workloadIdentity == preClaim.intendedWorkloadIdentity`; a mismatch parks the turn with `runtime_attestation_invalid`. |
| Attestation nonce | Core-generated, hash stored before dispatch | Exact turn, binding version, turn JTI, intended workload identity, expiry, and single use; cannot be replayed for another sandbox/host. |
| Transport service | Deployment-provided static registry | Binding `transportServiceId` resolves only to a pinned private mTLS endpoint/certificate identity; no URL/DNS/user override is permitted. |
| Egress token | Trusted gateway after attestation | Audience/model endpoint/lease/attested workload/expiry scoped; gateway injects only into that workload and revocation acknowledgment is required for completion/cancel/rollback. |
| Usage statement | Binding-pinned gateway/provider-metering key set | Must bind execution lease, workload, endpoint, usage/cost, and timestamp; only it releases unused reservation. |

Core rejects `nbf` in the future by more than the documented 30-second skew. `exp` is never extended by skew: `exp = iat + tokenTtlMs / 1000` (Unix seconds from millisecond TTL) with the 90-second hard cap. Keys are identified by `kid`; an unknown, retired, or mismatched key is a permanent rejection. Every persisted deadline (pre-admission, pre-dispatch, claim, runtime ceiling) is written and evaluated with the database clock (`transaction_timestamp()`); the application clock is used only for JWT `nbf`/`exp` checks. The receipt key set is snapshotted at admission (`receiptKeySetVersion`); rotation during execution never rejects a legitimate receipt signed under the old key. Rotation uses an explicit ordered key set `[{kid, publicKey, state: current|overlap, activatedAt, retiresAt}]` with at most one overlap entry; the key ID used is recorded in every validation.

## State and storage requirements

`RemoteTurnStore` owns the remote state machine and immutable event log. It requires PostgreSQL and performs admission/disable/claim/receipt/abort/reconcile through row locks or compare-and-set version checks. `RemoteTurn`, binding, Postgres session bind/restrict-delete reference, budget reservation/settlement, token consumption, and audit records share one transaction boundary for each state change.

All stores that participate in the admission transaction domain share one `pg.Pool` per connection string through a memoized pool registry in `src/persistence/pg-pool.ts`; the RemoteTurnStore never opens a second pool or reimplements session SQL. The registry's `close()` is reference-counted so one store's shutdown cannot kill the shared connection. The session store gains a transaction-bound variant of `getOrCreateByThread` (reusing its SQL and heal semantics, not rewriting it) used only inside the admission transaction; the audit store gains a same-transaction write variant; the run store, delivery store, and durable map are unchanged. The admission transaction uses `INSERT ... ON CONFLICT (thread_ref) DO NOTHING` then `SELECT ... FOR UPDATE` on the bound session row — the `FOR UPDATE` exists only to fix lock order (session -> RemoteTurn -> reservation -> audit) and prevent deadlocks; it never rewrites existing session attributes (no heal inside admission). `SESSION_STORE=postgres` in the same database is a startup requirement; a nonterminal RemoteTurn blocks session deletion and has a remote-specific session lease/second-input policy.

The RemoteTurnStore exposes a test-only `onStep(label)` hook (constructor-injected, default no-op, never wired in production) so crash-at-`created`/`session_bound`/`admitted` negatives can terminate the real backend mid-transaction with `SELECT pg_terminate_backend(pg_backend_pid())`, faithfully reproducing a process death between BEGIN and COMMIT. It also accepts an injectable clock (`opts.now`) for boundary tests; all persisted deadlines still use the database clock in production.

`RemoteTurnStore` owns an append-only `remote_turn_events` table written inside each state-change transaction; the existing `AuditLog` interface is unchanged and is not used for remote-turn evidence, because its fire-and-forget, independently pooled writes cannot roll back with the admission.

The existing `RunStore` remains useful for normal turn orchestration but is insufficient: it lacks remote state, actor/scope/binding/receipt facts, cancellation, durable token consumption, and remote-once recovery. Its memory implementation and current requeue semantics are never accepted as V1 evidence.

The `runs` table gains a `delivery_mode` column (`'local'` default, `'remote_once'` for remote rows), and every requeue path — `retire()` retry branch, `reapExpired()`, the worker's heartbeat-cancel `fail(retry:true)`, `releaseInFlight()` on drain, and the drain sweeper — must exclude `remote_once` rows. The run row for a remote turn stays `running` with `delivery_mode='remote_once'` for the whole nonterminal RemoteTurn lifetime; terminal outcomes are written by the RemoteTurnStore in the same transaction as the state change using the existing `lease_token + status` CAS (`completed` -> `done`, `cancelled`/`failed`/`failed_pre_dispatch`/`rejected` -> `failed`). The reconciler never writes run rows directly. `claimRun`'s session-running guard (`session_id NOT IN (SELECT session_id FROM runs WHERE status='running')`) must also exclude `remote_once` rows, so a remote-active session's second input receives `remote_refused: remote_turn_active` rather than being silently queued.

Only disposable HTTP connections, in-flight stream-free request buffers, and attestor client caches may live in process memory. All authorization, scope/session binding, state, reservation, receipt, termination, retry/park decision, and audit facts remain durable.

`TEXT_ONLY_MODE` (the D0-L non-remote admission layer) and the Remote Turn restricted-text envelope are separate layers. Remote Turn admission bypasses normal runtime selection entirely: the server chooses the binding directly and never routes a remote turn through `resolveRuntimeChoiceDurable(strictHarness: "pi")`. A non-G0 explicit remote admission attempt gets the Remote Turn typed denial (`remote_refused: governance_authorization_required`) from the Remote Turn layer, not a text-only refusal string. The Remote Turn transport resolver uses its own fetch/agent, not the global `redirect: "manual"` patch.

### Allowed transitions

| Current state | Event | Next state | Required guard |
| --- | --- | --- | --- |
| `created` | Postgres session bind | `session_bound` | Canonical conversation/scope, actual session ID, and restrict-delete reference commit atomically. |
| `created` or `session_bound` | Five-minute pre-admission deadline | `rejected` | No JTI/nonce/remote request; release remote-session lease. |
| `session_bound` | Admission | `admitted` | Binding lock, audit write, and budget reservation commit atomically. |
| `admitted` | Five-minute pre-dispatch deadline | `rejected` | No JTI/nonce/remote request; release reservation and remote-session lease. |
| `admitted` | `prepareDispatch` | `dispatching` | Unique admission owner records turn JTI, attestation nonce, transport service identity, request digest, and 90-second pre-claim deadline first. |
| `dispatching` | Authorized abort before claim | `cancel_requested` | Durable abort request/JTI persisted; turn JTI revoked so the pending claim is atomically refused. |
| `dispatching` | Valid single claim | `claimed` | One JTI consumption plus exact attestation/transport/workload proof; claim guard is `status='dispatching' AND turn_jti_hash=$2 AND abort_requested_at IS NULL AND version=$v`, zero rows matched means no lease. |
| `dispatching` | Restart before claim | unchanged | Only resend the exact persisted envelope; do not issue another JTI/nonce. |
| `dispatching` | Unclaimed token expires | `failed_pre_dispatch` | JTI revoked; release reservation/session lease; no sandbox can subsequently claim it. |
| `claimed` | Attested workload starts | `executing` | Exact execution lease and sandbox ID persist. |
| `claimed` or `executing` | Uncertain recovery/invalid active proof | `parked` | No automatic retry or second lease. |
| `executing` | Valid receipt | `reply_received` | Receipt matches key, lease, input/release digest, and bound output. |
| `reply_received` | Invalid metering or uncertain receipt evidence | `parked` | Receipt valid but trusted usage missing/mismatched; reservation held; no retry or second lease. |
| `reply_received` | Trusted usage and teardown begin | `teardown_pending` | Gateway/provider statement valid or full reservation retained; egress revocation/deletion requested. |
| `teardown_pending` | Trusted deletion/revocation proof | `completed` | Reply becomes deliverable only in this transition. |
| `claimed`, `executing`, `reply_received`, or `teardown_pending` | Authorized abort/disable/timeout | `cancel_requested` | Durable abort request/JTI; browser never receives capability. |
| `cancel_requested` | Trusted deletion/revocation proof | `cancelled` | No final reply delivery. |
| `cancel_requested` or `teardown_pending` | Missing/uncertain termination proof | `parked` | Rollback reports partial failure. |
| `completed` or `cancelled` | Duplicate/late receipt | unchanged | Record an immutable ignored-receipt audit event; do not rewrite terminal state. |
| `parked` | Explicit audited reconciliation with proof | `completed` or `cancelled` | Never creates a second execution lease; records previous state and evidence. |
| `parked` | Reconciliation proves no sandbox ever started, no lease consumed | `failed` | Attestor query empty and no start proof; reservation released in full; audit records the proof digest. |

### Session lease and second input policy

A nonterminal RemoteTurn owns an explicit durable remote-session lease from `session_bound` until `completed`, `cancelled`, `failed_pre_dispatch`, `failed`, `rejected`, or `parked`, held under holder identity `remote_turn:<id>` in the existing `session_leases` table. The reaper's `releaseStrandedSessionLeases` and the worker's `forceReleaseLease` must skip `remote_turn:` holders, or a parked remote turn would silently lose its lease and admit a second input. A second user input for that QM session receives `remote_refused: remote_turn_active`; it is not queued behind or merged into the active remote execution. Restart restoration derives this lease from the RemoteTurn transaction, not an in-memory map. The nonterminal RemoteTurn foreign-key/restrict-delete relationship prevents session deletion until a terminal/reconciled outcome is recorded; `sessions.deleteSession()` must reject deletion while a nonterminal RemoteTurn references the session, and terminal rows must be cleared or detached before session deletion proceeds.

### Pre-dispatch idempotency and recovery

`admissionKey = SHA-256(coreRunId || bindingVersion || scopeId || conversationKey || inputDigest)` has a partial unique constraint over non-terminal states only, so a legitimate identical re-send after a terminal outcome is not permanently blocked. It is a content-addressed idempotency key, not an authorization credential: every input to the hash is derivable from the row, so ownership is proven by the ordinary run's `lease_token` plus a version CAS, the same pattern `postgres-run-store.ts` uses for `claimRun`. `created`, `session_bound`, and `admitted` have no usable remote credential and are safe to resume only through that lease-owner before their five-minute deadline. `prepareDispatch` writes exactly one JTI/nonce/envelope under the same row lock. If the dispatch sender crashes before claim, any replacement worker may resend that persisted envelope until `preClaimExpiresAt`; because claim consumes the original JTI once, this does not create a second execution. It may never regenerate credentials. Cleanup of an expired pre-claim record writes the typed terminal outcome, releases session lease and budget reservation, and records audit evidence. Post-claim recovery follows the separate `parked` policy.

## Round-2 approval condition

This trace is approved only when the upstream generic extension owner agrees to the transaction/state design, the selected private deployment owner agrees to the attestation/egress/termination contract, and every transition/error has a test in Round 4.
