# Round 3 — Integration, Failure Paths, and Threat Model

## Error contract

Every error has an owner, machine result, durable evidence, and a test. `remote_unavailable`, `remote_refused`, `remote_parked`, and `remote_partial_rollback` are typed outcomes; none is rendered as a successful reply or generic `{ ok: true }`.

| Condition | Owner | User/operator result | Durable evidence | Test ID |
| --- | --- | --- | --- | --- |
| Legacy runtime selected/reachable | Core release gate | `remote_refused: legacy_runtime_disabled` before execution | Gate-0 inventory result | RTH-01 |
| Invalid deployment-controller identity | Binding store | `remote_refused: binding_forbidden` | Denied audit event | RTH-02 |
| Binding disabled/unknown/wrong scope | Binding resolver | `remote_refused: runtime_not_enabled` | Binding version and denial event | RTH-02, RTH-03 |
| Explicit Remote Turn admission with missing, expired, denied, replayed, or actor/scope/conversation-mismatched designated-entry/governance context | G0 context verifier | `remote_refused: governance_authorization_required` | Denied authorization audit with correlation and reason, no admission/reservation/JTI/remote request | RTH-03 |
| Caller attempts runtime/model/scope/org override | Context resolver | `remote_refused: server_selection_required` | Sanitized request-rejection event | RTH-03 |
| Input/history/output/time/TTL exceeds bound | Envelope validator | `remote_refused: remote_input_invalid` | Bound that failed and input digest only | RTH-04 |
| Audit/budget/store transaction fails | Admission transaction | `remote_unavailable: admission_not_committed` | Database rollback/no RemoteTurn/no reservation | RTH-05 |
| Created/session-bound/admitted pre-admission or pre-dispatch deadline expires | Dispatch coordinator | `remote_refused: pre_dispatch_expired` | Admission key, deadline, release of session lease/reservation, no remote request/JTI | RTH-05, RTH-09 |
| Conversation/session bind, Postgres-session, delete, or second-input conflict | Session binder | `remote_refused: session_binding_mismatch` or `remote_refused: remote_turn_active` | Binding/lease/delete denial event | RTH-06 |
| Token missing/expired/forged/replayed/confused | Core claim/abort | `remote_refused: invocation_denied` | JTI hash, denial reason, no lease | RTH-07 |
| Attestation/digest/JTI/nonce/workload/transport/network proof invalid, lease-order confused, or `startProof.sandboxId`/`workloadIdentity` mismatching the pre-claim planned identity | Attestor verifier | `remote_refused: runtime_attestation_invalid` | Attestation/transport digest and reason, no lease | RTH-08 |
| Abort arrives while the turn is `dispatching` (pre-claim) | Core claim/abort | `remote_refused: invocation_denied` on the pending claim; abort request recorded | Durable abort request and JTI revocation | RTH-07, RTH-11 |
| Dispatch response uncertain after claim | Reconciliation coordinator | `remote_parked: execution_uncertain` | Dispatch/lease/event timeline | RTH-09 |
| Invalid receipt or invalid trusted usage while execution is active, or a receipt arriving in a pre-claim state (`created`/`session_bound`/`admitted`/`dispatching`) | Receipt settler | `remote_parked: receipt_unverified` | Receipt/metering digest, key ID, schema result, reservation state | RTH-10 |
| Missing trusted usage after valid receipt | Budget settler | Valid path retains/charges the full reservation | Receipt digest and full-reservation settlement | RTH-10 |
| Duplicate completed receipt or late receipt after verified cancellation | Receipt settler | `remote_refused: receipt_ignored` with no state change | Immutable ignored-receipt audit event | RTH-10 |
| Abort/timeout/disable cannot prove termination | Termination coordinator | `remote_parked: termination_unverified` | Sandbox/egress proof status | RTH-11 |
| Disable has mixed target outcomes | Deployment controller | `remote_partial_rollback` with target lists | Binding version and per-turn outcomes | RTH-11, RTH-12 |
| Audit read lacks scope authority | Audit procedure | `not_found` without existence disclosure | Denied read audit event | RTH-13 |
| Private-layer canary fails a drill | Canary owner | Canary is halted; binding remains disabled/rolled back | Test/drill evidence and binding status | RTH-14 |

## Integration obligations

| Boundary | Positive proof | Negative proof |
| --- | --- | --- |
| Designated entry, governance, and QM context | Normal runtime selection sends a direct QM request without G0 context only to an approved non-remote path. A current G0-verified server context binds designated-entry actor/scope/conversation, governance decision, and correlation to the QM-visible participant window that derives the remote envelope. | An explicit Remote Turn admission with missing/expired/denied/replayed/mismatched G0 context, header, cookie, env/default identity, capability token, request scope/model/harness, hard-coded principal, invisible participant entry, or concurrent conversation text is typed-denied and audited; none can select/influence remote execution. |
| Binding control | Deployment controller creates/versions a binding, records audit, and serializes with admission. | Browser/API request, non-controller credential, stale binding version, disabled binding, and cross-scope binding use are denied. |
| Session binding | Actual Postgres QM `Session.id` binds atomically before a token exists; one durable remote-session lease controls active input. | Memory session store, crash between bind/token, session deletion, second input, `conversation.threadRef` as session, changed/mismatched conversation/scope cannot dispatch. |
| One-time authority | Exactly one core claim returns execution lease and a distinct abort capability reaches the runtime only from core. An abort before claim revokes the turn JTI and the pending claim is refused. | Replayed or cross-purpose turn/abort token, wrong request digest, bad `kid`, skewed clock, duplicate claim, unauthorized user abort, client disconnect, abort-before-claim with the runtime still claiming, and concurrent abort produce no extra lease/capability. |
| Trusted execution | Binding-pinned attestation and static mTLS transport verify exact release/image/turn/JTI/nonce/workload/sandbox/network policy before lease; the attestor sits outside the runtime trust boundary, and core enforces `startProof.sandboxId == plannedSandboxId` with `workloadIdentity` equality, parking mismatches. | Runtime self-report, attestation replay, nonce/workload/transport mismatch, planned-vs-actual sandbox/workload mismatch, DNS/cert mismatch, host mode, writable mount, direct network, metadata/internal IP, proxy bypass, egress-token copy, or non-model endpoint is denied. |
| Remote-once recovery | Pre-claim expiry fails safely; post-claim uncertainty parks and reconciles. | Worker restart, lease expiry, network timeout, duplicate request, or receipt loss never creates another execution. |
| Accounting and audit | One transaction reserves and records audit; binding-pinned gateway/provider metering settles it. | Race, DB error, duplicate/late receipt, forged/underreported runtime usage, missing trusted usage, audit write error, and cross-instance restart leave no unaudited/unreserved successful execution. |
| Completion, abort, and rollback | Attestor deletion plus egress revocation precedes completed/cancelled delivery. | A response, killed client connection, or runtime self-report without external proof is not success; failed teardown parks. |

## Threat model

### Assets

Protected assets are QM user text, scope boundaries, session history, provider credentials, model budget, runtime release identity, sandbox/egress enforcement, audit evidence, and the ability to stop work.

### Trust boundaries

The user/browser, QM core, binding database, deployment controller, private runtime, deployment attestor, egress gateway, provider endpoint, and database each have distinct trust. The runtime is less trusted than core policy and cannot prove itself trustworthy.

| Threat | Required mitigation | Criteria |
| --- | --- | --- |
| Fail-open identity, governance, or deployment impersonation | G0-verified designated-entry and governance context; deployment-controller mTLS/signed credential; no header/env/cookie fallback. | RTH-02, RTH-03 |
| Cross-scope/session leakage | Server-derived conversation/scope/session, actor-visible history projection, bound input digest and one-time lease, empty per-turn workspace. | RTH-03, RTH-04, RTH-06, RTH-07 |
| Replay or duplicate spend | Atomic JTI consumption, execution lease, durable remote-once state, no auto retry after claim. | RTH-07, RTH-09 |
| Host/secret takeover | No host launch/full environment/provider key; immutable release; private mTLS channel; scoped egress token. | RTH-01, RTH-04, RTH-08 |
| Egress bypass or SSRF | Attestor-verified workload-bound non-bypassable policy, pinned private transport, and gateway allowlist/revocation. | RTH-08, RTH-11 |
| Supply-chain drift | Binding-pinned release digest, attestation key, receipt key set, and verified receipt. | RTH-08, RTH-10 |
| Budget/audit evasion | Transactional reservation/audit and gateway/provider-metered conservative settlement. | RTH-05, RTH-10 |
| Fake cancellation or rollback | Independent attestor deletion and egress revocation evidence; partial results remain partial. | RTH-11, RTH-12 |
| Misleading operational claim | Gate-0 inventory, capability status, error contract, canary evidence, and fresh review. | RTH-01, RTH-12, RTH-14 |

## Release evidence

Gate 5 requires: completed Gate-0/F0 inventory; accepted D0-L local Docker evidence and D0-T target-environment evidence; G0 designated-entry/governance authorization, trace/error/result/audit contract and fail-closed evidence; X0 reference-runtime evidence; accepted upstream generic contract; same-database durable SessionStore/RemoteTurn transaction, deletion, second-input, restart, and cross-instance tests on the D0-T-approved target storage profile; attestation/transport/egress-denial evidence; token/replay/key-rotation tests; trusted-metering/receipt/teardown tests; user-abort/timeout/partial rollback drills; an authorized audit-read test; private-layer canary evidence; current documentation; affected lint/typecheck; and independent fresh-context security/code review. A user-visible surface is out of scope; any later UI must add browser proxy/auth/CSP/XSS tests and Firefox dev-instance screenshot evidence.

## Round-3 approval condition

Round 3 is approved only when every row above has a named implementation owner, a typed outcome, durable evidence, and passing mapped test. Any physical control that is not yet implemented remains a prerequisite failure, not a best-effort claim.
