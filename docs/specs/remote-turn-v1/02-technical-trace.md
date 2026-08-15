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
| 8 | Core claim and attestor | Atomically consumes the turn JTI once. Core verifies binding-pinned single-use attestation for exact turn/JTI/nonce/workload/release/network/egress facts; only then returns one execution lease and causes the gateway to inject a scoped egress token into that workload identity. | `dispatching -> claimed`; repeated claim receives no usable lease. |
| 9 | Runtime sandbox | Starts the fixed vendor RPC command as the attested workload with the one lease and empty ephemeral workspace. It has no provider key or full core environment. | `claimed -> executing`; attested sandbox ID and start time persist. |
| 10 | Runtime receipt | Returns one bounded plaintext reply and signed receipt with run/binding/lease/input/release digests and terminal status. | Valid receipt moves only `executing -> reply_received`; no reply is surfaced yet. |
| 11 | Trusted settlement and teardown | Core validates the receipt, retrieves a binding-pinned gateway/provider usage statement, moves `reply_received -> teardown_pending`, revokes egress, and requests attestor deletion. | Missing trusted usage charges full reservation; invalid metering parks. No final reply is delivered while teardown is pending. |
| 12 | Completion | Core verifies attestor deletion and egress-revocation proof, settles the durable budget/audit chain, then moves `teardown_pending -> completed`. | Only now does the existing QM surface receive one final reply; no reusable process/session state remains. |

## Dispatch and recovery semantics

The network boundary is deliberately asymmetric:

- `created` and `session_bound` have no remote authority. Their five-minute pre-admission deadline rejects the record and releases the remote-session lease if the idempotent admission owner does not finish.
- `admitted` has a reservation but no JTI/nonce/remote authority. Its five-minute pre-dispatch deadline rejects the record and releases reservation/session lease if the same idempotent owner does not run `prepareDispatch`.
- `prepareDispatch` is the sole JTI/nonce issuance point. It atomically persists the exact envelope and moves `admitted -> dispatching`. Before claim, a restarted worker may resend only that same envelope; it may not mint a replacement authority.
- Before the runtime consumes the JTI, a dispatch can expire as `failed_pre_dispatch`; core revokes the JTI and no sandbox may claim it afterwards.
- Once JTI consumption returns an execution lease, loss of network/worker/runtime/receipt certainty moves the RemoteTurn to `parked`. The reaper cannot release/requeue it.
- Reconciliation is an explicitly invoked, audited operation. It queries the trusted attestor and runtime receipt/status channel with the binding's mTLS identity, then records a proven final result or leaves the item parked. It never creates a second lease.
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
| Abort JTI | Separate generated value, hash stored only when an abort is requested | One atomic abort claim; cannot call `/turn`; exact execution lease/run/binding/audience. |
| Execution lease | Core-generated opaque one-time value, hash stored | Returned only after turn JTI and trusted attestation pass; required for receipt and termination proof. |
| Receipt key | Binding-pinned versioned public key set | Signature/key ID/release digest/lease/input digest/status/usage schema/freshness must match. Rotation uses explicit current+overlap key IDs only. |
| Pre-claim attestation key | Binding-pinned public key | Signature must bind turn, binding version, turn-JTI, nonce, intended workload/sandbox, release digest, isolation mode, network-policy ID, endpoint allowlist, egress audience, expiry, and single use. It must not bind an unissued lease. |
| Start/termination attestation key | Binding-pinned public key | Start and termination signatures bind the issued execution lease to the actual workload/sandbox identity, release digest, timestamps, and deletion result. |
| Attestation nonce | Core-generated, hash stored before dispatch | Exact turn, binding version, turn JTI, intended workload identity, expiry, and single use; cannot be replayed for another sandbox/host. |
| Transport service | Deployment-provided static registry | Binding `transportServiceId` resolves only to a pinned private mTLS endpoint/certificate identity; no URL/DNS/user override is permitted. |
| Egress token | Trusted gateway after attestation | Audience/model endpoint/lease/attested workload/expiry scoped; gateway injects only into that workload and revocation acknowledgment is required for completion/cancel/rollback. |
| Usage statement | Binding-pinned gateway/provider-metering key set | Must bind execution lease, workload, endpoint, usage/cost, and timestamp; only it releases unused reservation. |

Core rejects `nbf` in the future or `exp` beyond the binding TTL plus the documented 30-second maximum skew. Keys are identified by `kid`; an unknown, retired, or mismatched key is a permanent rejection.

## State and storage requirements

`RemoteTurnStore` owns the remote state machine and immutable event log. It requires PostgreSQL and performs admission/disable/claim/receipt/abort/reconcile through row locks or compare-and-set version checks. `RemoteTurn`, binding, Postgres session bind/restrict-delete reference, budget reservation/settlement, token consumption, and audit records share one transaction boundary for each state change. `SESSION_STORE=postgres` in the same database is a startup requirement; a nonterminal RemoteTurn blocks session deletion and has a remote-specific session lease/second-input policy.

The existing `RunStore` remains useful for normal turn orchestration but is insufficient: it lacks remote state, actor/scope/binding/receipt facts, cancellation, durable token consumption, and remote-once recovery. Its memory implementation and current requeue semantics are never accepted as V1 evidence.

Only disposable HTTP connections, in-flight stream-free request buffers, and attestor client caches may live in process memory. All authorization, scope/session binding, state, reservation, receipt, termination, retry/park decision, and audit facts remain durable.

### Allowed transitions

| Current state | Event | Next state | Required guard |
| --- | --- | --- | --- |
| `created` | Postgres session bind | `session_bound` | Canonical conversation/scope, actual session ID, and restrict-delete reference commit atomically. |
| `created` or `session_bound` | Five-minute pre-admission deadline | `rejected` | No JTI/nonce/remote request; release remote-session lease. |
| `session_bound` | Admission | `admitted` | Binding lock, audit write, and budget reservation commit atomically. |
| `admitted` | Five-minute pre-dispatch deadline | `rejected` | No JTI/nonce/remote request; release reservation and remote-session lease. |
| `admitted` | `prepareDispatch` | `dispatching` | Unique admission owner records turn JTI, attestation nonce, transport service identity, request digest, and 90-second pre-claim deadline first. |
| `dispatching` | Valid single claim | `claimed` | One JTI consumption plus exact attestation/transport/workload proof. |
| `dispatching` | Restart before claim | unchanged | Only resend the exact persisted envelope; do not issue another JTI/nonce. |
| `dispatching` | Unclaimed token expires | `failed_pre_dispatch` | JTI revoked; release reservation/session lease; no sandbox can subsequently claim it. |
| `claimed` | Attested workload starts | `executing` | Exact execution lease and sandbox ID persist. |
| `claimed` or `executing` | Uncertain recovery/invalid active proof | `parked` | No automatic retry or second lease. |
| `executing` | Valid receipt | `reply_received` | Receipt matches key, lease, input/release digest, and bound output. |
| `reply_received` | Trusted usage and teardown begin | `teardown_pending` | Gateway/provider statement valid or full reservation retained; egress revocation/deletion requested. |
| `teardown_pending` | Trusted deletion/revocation proof | `completed` | Reply becomes deliverable only in this transition. |
| `claimed`, `executing`, `reply_received`, or `teardown_pending` | Authorized abort/disable/timeout | `cancel_requested` | Durable abort request/JTI; browser never receives capability. |
| `cancel_requested` | Trusted deletion/revocation proof | `cancelled` | No final reply delivery. |
| `cancel_requested` or `teardown_pending` | Missing/uncertain termination proof | `parked` | Rollback reports partial failure. |
| `completed` or `cancelled` | Duplicate/late receipt | unchanged | Record an immutable ignored-receipt audit event; do not rewrite terminal state. |
| `parked` | Explicit audited reconciliation with proof | `completed` or `cancelled` | Never creates a second execution lease; records previous state and evidence. |

### Session lease and second input policy

A nonterminal RemoteTurn owns an explicit durable remote-session lease from `session_bound` until `completed`, `cancelled`, `failed_pre_dispatch`, or `parked`. A second user input for that QM session receives `remote_refused: remote_turn_active`; it is not queued behind or merged into the active remote execution. Restart restoration derives this lease from the RemoteTurn transaction, not an in-memory map. The nonterminal RemoteTurn foreign-key/restrict-delete relationship prevents session deletion until a terminal/reconciled outcome is recorded.

### Pre-dispatch idempotency and recovery

`admissionKey = SHA-256(coreRunId || bindingVersion || scopeId || conversationKey || inputDigest)` has a unique constraint and identifies the sole core dispatch owner. `created`, `session_bound`, and `admitted` have no usable remote credential and are safe to resume only through that key before their five-minute deadline. `prepareDispatch` writes exactly one JTI/nonce/envelope under the same row lock. If the dispatch sender crashes before claim, any replacement worker may resend that persisted envelope until `preClaimExpiresAt`; because claim consumes the original JTI once, this does not create a second execution. It may never regenerate credentials. Cleanup of an expired pre-claim record writes the typed terminal outcome, releases session lease and budget reservation, and records audit evidence. Post-claim recovery follows the separate `parked` policy.

## Round-2 approval condition

This trace is approved only when the upstream generic extension owner agrees to the transaction/state design, the selected private deployment owner agrees to the attestation/egress/termination contract, and every transition/error has a test in Round 4.
