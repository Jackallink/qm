# Remote Turn v1

## Status

Draft — Gate 1 is not approved. The independent specification audit rejected the earlier draft because the current QM `RunStore`, budget tracker, and audit interfaces do not provide the atomic remote-dispatch, recovery, authorization, or accounting guarantees required here.

- Audit baseline: `2fbfc00549444ac8cc3977d9e5c6ea9f9f50762d` (2026-08-11)
- External research is reference material only; it is not implementation evidence.
- The implementation starts only after the three walkthroughs and the test matrix in this directory are approved, with red tests for the relevant criteria.
- Before formal Gate 1 approval, the program roadmap's D0-T gate must prove that the approved target environment provides the same durable transaction, session-binding, locking, migration, recovery, and cross-instance semantics required here. If it cannot, this draft must be revised to a named, equivalently tested storage design and re-audited; a local, memory, or independently committed substitute is not valid.
- Before formal Gate 1 approval, the program roadmap's G0 and X0 gates must supply the designated-entry/governance contract and the reference runtime's attestation/egress/termination proof. This specification defines neither a private governance protocol nor a vendor runtime implementation.

## Problem

The experimental branch combines a vendor-specific remote harness, Agent Runtime Gateway, admin panel, host launching, messaging, scheduling, and automatic skill import. The audit found fail-open identity, hard-coded tenant data, unverified control-plane access, host and egress boundary gaps, RAM-backed state, and success responses for operations that do not happen.

This restart delivers one narrow vertical slice first: one protected text-only remote turn through the program's designated-entry/governance path and the normal QM surface it verifies. It is not an Agent platform, and no existing experimental implementation is its production baseline.

## Goal

For one explicitly allowlisted scope in QM's configured organization, a G0-verified designated-entry request can use one pinned remote runtime. Normal runtime selection sees a direct QM request without the required designated-entry and governance authorization as non-remote and stays on an already approved non-remote path. If any route explicitly attempts Remote Turn admission without a valid G0 context, it is denied and audited rather than falling back. The runtime receives restricted text, returns one bounded final reply, and can be actually aborted. Streaming, tools, files, persistent kernel state, and background agents are deferred.

Every remote invocation must have server-derived identity and scope, a durable transactional admission record, one-time dispatch authority, trusted runtime/sandbox/egress evidence, conservative budget reservation and settlement, an authenticated receipt, an actual termination proof, and a usable rollback path.

## Architecture decision

The generic QM core work is a new vendor-neutral **Remote Turn extension**, not a reuse of the present `RunStore` as-is. It requires a transaction-capable `RemoteTurnStore` and budget/audit interfaces in one durable transaction domain. PostgreSQL is the initial reference profile because the current QM session primitive is PostgreSQL-based; D0-T must prove the target environment satisfies the same contract or require a revised, separately audited storage design before Gate 1. The extension owns irreversible remote-dispatch state, replay defense, cancellation, receipt verification, and recovery. The existing `RunStore` may carry the surrounding normal-turn job only after it gains an explicit remote-once recovery policy; its current automatic requeue behavior is not valid for remote dispatch.

A vendor runtime implementation belongs in the chosen private deployment repository under its organization layer. Its binary/image, RPC bridge, provider credential handling, network policy, attestation provider, and operating runbook remain there. This upstream checkout contains only the generic contract and tests. No provider, personal-principal, organization, or egress-specific value belongs in `src/`, shared plugins, generic images, or this upstream specification.

QM currently operates with one configured organization ID; v1 therefore supports that one organization and server-authorized scopes only. It must not claim a general multi-organization control plane.

If the upstream generic Remote Turn extension is not accepted, the fallback is a restricted sandbox-tool proof of concept outside the QM runtime selection path. It cannot be presented as a first-class QM harness.

## Scope

Included:

- One immutable remote runtime release with a fixed protocol version, endpoint audience, image digest, receipt key, and trusted deployment-attestation key.
- A G0-verified designated-entry context reaches the normal QM text-turn surface. It carries a server-verified actor, scope, conversation correlation, governance authorization/decision, and trace correlation. Normal runtime selection does not call Remote Turn admission for a direct QM request without this context and cannot select the remote binding; an explicit Remote Turn admission attempt without it is typed-denied and audited. No request can select the remote runtime, model, scope, organization, or runtime release.
- A deployment-controller-managed, durable `RemoteRuntimeBinding` for one configured organization and allowlisted scope. There is no browser/admin UI or dynamic public API in v1.
- A generic `RemoteTurnStore` with atomic admission, binding snapshot, reservation, audit event, token JTI state, receipt state, cancellation state, and reconciliation state.
- Plain UTF-8 input and history only from the actor's authorized visible-session projection; one bounded final text reply and measured usage receipt.
- Separate turn and abort capabilities; short-lived, audience-bound, one-time token claims; source authentication; and receipt signatures pinned by binding version.
- A trusted release and per-sandbox attestation path bound to the exact RemoteTurn/JTI/workload identity that validates immutable image identity, sandbox isolation, and non-bypassable egress before execution authority is issued.
- Actual timeout, abort, teardown, egress credential revocation, durable reconciliation, and rollback proof.
- Adversarial unit, Postgres integration, contract-double, deployment-layer, and one-scope canary tests.

## Explicit non-goals

- Agent Registry, agent templates, lifecycle management, resident/background agents, host child-process launchers, health endpoints, Agent Panel, and Admin proxy.
- Messenger, Event/RPC/Observe, scheduler/cron/replay, SOP/gate engines, device-resident Agents, named external frameworks, or cross-framework protocols.
- Streaming, attachments, files, mounted/persistent workspaces, external tools, cross-turn remote kernels, automatic refinement/import, memory promotion, or side effects.
- Public agents, cross-tenant sharing, model fallback, custom extensions, user-supplied command arguments, and performance/cost claims.
- Browser or capability-token administration of a Remote Runtime binding. A later control plane needs its own specification.
- Any emergency/control endpoint until it performs and proves the action it reports.

## Hard invariants

1. Missing, expired, forged, revoked, replayed, actor/scope/conversation-mismatched, or governance-denied G0 authority fails closed. Cookies, environment defaults, `x-admin-actor`, local bypasses, and personal literals cannot create authority.
2. A remote admission consumes only the server-verified G0 designated-entry context. The configured organization, scope, actor, conversation key, governance decision, trace correlation, and later QM session ID derive only from that context. Normal runtime selection routes a direct QM request without that context only to an already approved non-remote path; any explicit attempt to admit it remotely is typed-denied and audited. Request JSON and request runtime/model selection cannot override them.
3. A remote turn never starts from a legacy experimental adapter, detached host process, arbitrary CLI argument, full core environment, direct provider credential, or shared scope-keyed client.
4. Before execution, a trusted deployment attestor — not the less-trusted runtime — must prove the pinned release/image identity, exact RemoteTurn/JTI/workload identity, isolated sandbox identity, and enforced model-only egress policy. Failure denies dispatch.
5. A remote turn is allowed exactly one execution lease. After a remote boundary outcome is uncertain, it is `parked` for reconciliation; it is never automatically retried or requeued.
6. Turn and abort credentials have distinct capabilities and JTIs. A consumed JTI, wrong audience/scope/conversation/session/run, invalid request digest, invalid signing key, or excessive clock skew is denied.
7. The runtime sees only the bounded text envelope and an egress token. It never receives browser identity, attachments, tool outputs, mounted workspace, full environment, provider key, or QM signing key.
8. A final reply is not delivered and a turn is not `completed` until verified sandbox termination and egress-token revocation. A runtime's self-report alone is insufficient for completion or cancellation.
9. Usage settlement relies on a binding-pinned gateway/provider-metered statement. Missing trusted usage charges the full conservative reservation; it never releases budget based only on a runtime receipt.
10. Every admission, state change, receipt, usage settlement, cancellation, rollback action, and read is durable, versioned, and audited. Audit or reservation failure rolls the admission back before dispatch.
11. No capability is exposed or documented as enabled unless its enforcement, negative tests, and rollback evidence exist.

## Phase order

1. **Gate 0 / F0 — Quarantine legacy paths.** Make every legacy experimental remote-runtime selection/construction route unreachable. This isolated safety work may start immediately and may run in parallel with D0-L local Docker planning; it does not enable a new Remote Turn.
2. **Program prerequisites — D0-L, D0-T, G0, X0.** D0-L first establishes only a reproducible local Docker text baseline. D0-T then completes the target environment contract; G0 completes the designated-entry/governance connection; X0 completes the reference runtime deployment baseline. These gates, together with Gate 0/F0, must all pass before Gate 1 approval, any new Remote Turn implementation, binding enablement, or canary.
3. **Gate 1 — Approve this specification.** Approve the contract, state machine, control procedure, error matrix, threat model, AC-to-test matrix, and the program-prerequisite evidence references.
4. **Gate 2 — Upstream generic extension.** Design and accept the vendor-neutral Remote Turn store/protocol/recovery contract in upstream QM.
5. **Gate 3 — Private deployment runtime.** After D0-T validates the target deployment/storage contract, build the vendor runtime, immutable release, attestor, egress enforcement, and runbook only in the selected private deployment layer.
6. **Gate 4 — Contract and failure proof.** Pass core and deployment-layer tests, including restart/replay/cancel/rollback negatives.
7. **Gate 5 — One-scope canary.** Complete a real controlled canary, a rollback drill, and a fresh-context security/code review.
8. **Later independent work.** Registry, persistent sessions, files/tools, streaming, multi-agent coordination, UI, scheduler, and operations features each need their own specification and gates.

## Gate 0 inventory

Gate 0 is complete only when an inventory test proves that all of the following are unreachable in production:

- No legacy remote runtime is selectable through harness identifiers, approved-harness state, runtime-selection configuration, environment, or a normal turn request.
- Core wiring does not construct a legacy remote adapter, consume legacy runtime options, pass direct provider credentials, or run automatic refinement/import.
- The legacy Agent Gateway, Agent Panel, host launcher, messenger, scheduler, emergency controls, and PC script are not registered as a production capability.
- Existing stored configuration that names a legacy remote runtime is rejected or migrated to a safe non-remote selection; it cannot silently reactivate an old adapter.

The implementation records the complete route/config/wiring inventory in its Gate 0 PR and tests both positive unavailability and a normal-turn attempt to select a legacy runtime.

## Proposed durable model

### Remote runtime binding

`RemoteRuntimeBinding` is a generic durable record controlled only by a deployment-controller identity authenticated with mTLS/signed deployment credentials. It is not mutable by a browser request in v1. Required fields are:

`bindingId`, `version`, `enabled`, `configuredOrgId`, `allowedScopeId`, `protocolVersion`, `runtimeAudience`, `transportServiceId`, `transportCertificatePin`, `releaseDigest`, `releaseAttestationKeyId`, `receiptKeySetVersion`, `meteringKeySetVersion`, `maxInputBytes`, `maxHistoryMessages`, `maxOutputBytes`, `maxRuntimeMs`, `tokenTtlMs`, `budgetCeilingUsd`, `createdBy`, `createdAt`, `disabledBy`, `disabledAt`, and a policy snapshot hash.

Enable/disable serializes with admission: both lock the binding version in the same database transaction. Disable first prevents new admission, then enumerates active remote turns for that binding and begins verified termination. The deployment controller receives a structured result listing every stopped, parked, or failed target; it must not receive a generic success response.

### Remote turn

`RemoteTurn` is a new generic transaction-owned record, linked one-to-one to the ordinary core run where applicable. It is not an Agent Registry and not a replacement for the existing RunStore. Required fields include:

`remoteTurnId`, `coreRunId`, `admissionKey`, `conversationKey`, `scopeId`, `actorId`, `qmSessionId` (initially null), `governanceAuthorizationDigest`, `governanceDecisionId`, `bindingId`, `bindingVersion`, `policySnapshotHash`, `releaseDigest`, `inputDigest`, `turnJtiHash`, `abortJtiHash`, `executionLeaseHash`, `attestationNonceHash`, `workloadIdentity`, `budgetReservationId`, `status`, `version`, `dispatchOwner`, `dispatchAttempt`, `preAdmissionExpiresAt`, `preClaimExpiresAt`, `dispatchStartedAt`, `claimExpiresAt`, `receiptDigest`, `trustedUsageDigest`, `usageSettlementId`, `terminationProofDigest`, `correlationId`, timestamps, and immutable audit-event references.

The ordinary queue currently uses `conversation.threadRef` before `Session.id` exists. v1 records that server-authorized value as `conversationKey` at admission. Before a dispatch token can be issued, `SESSION_STORE=postgres` in the same database is mandatory: a transaction-capable session-binding primitive resolves/creates the QM `Session`, atomically binds its immutable `qmSessionId`, and enforces a foreign-key/restrict-delete relationship while the RemoteTurn is nonterminal. Memory SessionStore and an independently committed bind are invalid. A thread reference is never mislabeled as a QM session ID.

### Remote-turn state machine

`created -> session_bound -> admitted -> dispatching -> claimed -> executing -> reply_received -> teardown_pending -> completed`

`created|session_bound|admitted -> rejected` on their deadline before dispatch, with reservation/session-lease release and no remote request.

`dispatching -> failed_pre_dispatch` only after the turn token expires unclaimed and core has revoked its JTI.

`claimed|executing|reply_received|teardown_pending -> cancel_requested -> cancelled` only after trusted termination and egress-revocation proof.

`claimed|executing|reply_received|teardown_pending|cancel_requested -> parked` whenever dispatch, receipt, termination, or core/runtime recovery is uncertain.

`completed`, `rejected`, `failed_pre_dispatch`, `cancelled`, and `parked` are terminal until an explicitly audited reconciliation procedure records a new final result. A valid receipt moves `executing -> reply_received`; core then begins teardown and delivers the reply only after `teardown_pending -> completed` receives trusted deletion/revocation proof. Duplicate receipts after `reply_received`, `completed`, or `cancelled` are durably audited and ignored; invalid/late receipts can park only an active state and never rewrite a terminal state. No generic worker/reaper may redeliver a `dispatching`, `claimed`, `executing`, `reply_received`, `teardown_pending`, `cancel_requested`, or `parked` remote turn. The implementation must add a generic `remote_once` recovery policy to the surrounding queue or use a dedicated generic Remote Turn worker; `RunStore.reapExpired()` cannot be used unchanged.

### Atomic admission and accounting

The `admit` transaction locks the enabled binding, validates the current G0 server-verified designated-entry actor/scope/conversation correlation and governance authorization/decision, validates input bounds, creates/binds the Postgres QM session where necessary, creates the RemoteTurn record and immutable audit event, reserves a conservative maximum budget, and returns an `admitted` record with no turn JTI, nonce, or remote authority. A missing, expired, denied, replayed, or actor/scope/conversation-mismatched G0 context records a durable denial and returns `remote_refused: governance_authorization_required`; it creates no admission, reservation, JTI, or remote request. If a binding, session bind, audit, budget reservation, or durable store operation fails, the transaction rolls back and no remote request is sent.

The core dispatch coordinator owns a unique `admissionKey = SHA-256(coreRunId || bindingVersion || scopeId || conversationKey || inputDigest)` and a unique `coreRunId` RemoteTurn row. Only its idempotent `prepareDispatch` transaction may change `admitted -> dispatching`; that transaction records the one turn-JTI hash, attestation-nonce hash, dispatch owner/attempt, and `preClaimExpiresAt` before any network call. `created`/`session_bound` records expire after five minutes without admission and release their remote-session lease; `admitted` records expire after five minutes without `prepareDispatch` and release the reservation/lease. These pre-claim states may be resumed only by the same `admissionKey` owner before expiry. A `dispatching` worker may resend the exact already-persisted envelope until its 90-second token deadline, but may not mint a replacement JTI/nonce. After expiry it revokes the JTI, releases reservation/lease, and records `failed_pre_dispatch`. Only a state after successful claim can become `parked`.

The present `BudgetTracker.check()`/`record()` and best-effort audit helper do not meet this contract. The upstream extension must supply a transaction-capable scoped reservation/settlement ledger and durable audit write. A binding-pinned egress gateway or provider-metering adapter signs the usage statement for the exact execution lease; only that statement can release unused reservation. Missing trusted usage charges the full reservation, while invalid/mismatched metering evidence parks the active turn for reconciliation.

## Protocol and trust contract

`POST /turn` and `POST /abort` are contract names, not currently registered APIs. They are reachable only over a private/mTLS deployment channel plus source authentication.

- A turn token has `kid`, `iss`, `aud`, `iat`, `nbf`, `exp`, `jti`, `capability=turn`, `remoteTurnId`, `bindingVersion`, `conversationKey`, `scopeId`, `qmSessionId`, `inputDigest`, and protocol version. It is accepted only within a documented skew window and only once.
- An abort token has a different `jti` and `capability=abort`; it contains no authority to invoke a turn.
- The runtime must present the turn token to an authenticated core `claim` operation before sandbox creation. The claim atomically consumes the turn JTI and returns one execution lease. A repeated request receives no usable lease and cannot start a second sandbox.
- Core pins the binding's receipt key set and validates key ID, signature, release digest, execution lease, input digest, status, output/usage schema, and freshness. Signing key rotation accepts only the binding's explicit current/overlap key set and records the key ID used.
- `runtimeAudience` is an identity, not a URL. A deployment-provided static transport registry resolves `transportServiceId` to a private HTTPS endpoint with pinned mTLS server identity/certificate; no request, binding payload, or DNS response can choose a destination. Resolver tests cover unregistered service, certificate/SAN mismatch, DNS rebinding, and non-private destination denial.
- Before claim success, a deployment attestor signed by the binding's pinned attestation key produces a **pre-claim attestation** for the exact `remoteTurnId`, binding version, turn-JTI hash, attestation nonce, intended workload identity, expiry/single use, planned sandbox ID, immutable release digest, isolation mode, non-bypassable network-policy ID, exact model endpoint allowlist, and egress-token audience. It contains no execution lease, because core has not issued one. Core verifies this evidence; the runtime's own configuration claim is not evidence. After claim, the attestor produces a **start proof** bound to the issued execution lease and actual workload/sandbox identity. The gateway injects the egress token only into that attested workload identity and rejects it from another sandbox or host.
- A binding-pinned gateway/provider-metering statement binds the execution lease, workload identity, model endpoint, usage, cost, and timestamp. Core uses it for settlement rather than trusting runtime-reported usage.
- Termination proof contains the execution lease, sandbox ID, attestor-signed exit/deletion result, egress-token revocation acknowledgment, and timestamp. Core independently verifies it before `completed`, `cancelled`, or rollback success.

## V1 input and output limits

The binding uses these hard upper bounds: current user plain text plus at most eight prior plaintext user/assistant messages from the actor's authorized visible-session projection; at most 32 KiB total UTF-8 input; at most 16 KiB final UTF-8 output; a 60-second runtime ceiling; and a 90-second token TTL. It rejects attachments, tool calls/results, browser metadata, user credentials, filesystem paths, binary data, arbitrary system prompts, participant-window-invisible history, cross-conversation history, and any input that exceeds a bound. The runtime has no mounted or persistent workspace.

## Acceptance criteria

The authoritative positive and negative test mapping is [04-test-matrix.md](./04-test-matrix.md). In brief:

| ID | Required result |
| --- | --- |
| RTH-01 | Gate 0 removes every legacy runtime reachability path. |
| RTH-02 | Only a deployment-controller identity can atomically enable/disable a binding; no browser/capability/admin-header fallback exists. |
| RTH-03 | Context, governance authorization, binding, and input derive server-side; normal direct QM requests without a current G0 context remain non-remote, while any explicit Remote Turn admission attempt without valid G0 context and all request runtime/model/scope/organization overrides are denied and audited. |
| RTH-04 | Text/history/output/time/token bounds are enforced before dispatch. |
| RTH-05 | Session binding, admission, budget reservation, audit evidence, and pre-claim expiry/release commit or recover atomically; no work starts otherwise. |
| RTH-06 | Actual QM session binding is transactional/durable before dispatch, cannot cross a conversation/scope, and prevents deletion while active. |
| RTH-07 | Turn/abort token JTI, request digest, capability, key rotation, and clock checks defeat replay/confusion. |
| RTH-08 | Pinned private transport plus pre-claim attestation and post-claim start proof bind the exact turn/JTI/nonce/workload/lease before execution. |
| RTH-09 | Remote-once state never requeues an uncertain dispatch; restart reconciles or parks it. |
| RTH-10 | Receipt, trusted usage settlement, normal teardown, and reply delivery are authenticated, bounded, correlated, durable, and idempotent. |
| RTH-11 | A verified QM user or deployment controller can request abort/disable; authority revocation and independently verified termination precede success. |
| RTH-12 | Every error has a typed result, durable evidence, ownership, and no false success. |
| RTH-13 | Authorized operational audit reads expose the complete durable chain without cross-scope disclosure. |
| RTH-14 | One private-layer canary completes success, denial, restart, cancel, and rollback drills. |

## Risks and rollback

Principal risks are identity compromise, cross-scope leakage, replay, duplicate spend, sandbox escape, egress bypass, supply-chain drift, budget overrun, uncertain cancellation, and mixing private vendor code into upstream core.

Rollback is a transactional operator procedure: disable the binding; reject new admissions; enumerate and issue aborts for active turns; obtain attestor termination and egress-revocation proof; park any target lacking proof; preserve all evidence; and route future normal turns to the already approved non-remote runtime. The rollback report distinguishes completed, parked, and failed targets. It is tested before canary.

## Required review records

- [Round 1: user stories and acceptance criteria](./01-user-stories.md)
- [Round 2: technical trace and data contract](./02-technical-trace.md)
- [Round 3: integration, failure paths, and threat model](./03-integration-errors.md)
- [Acceptance criteria to test matrix](./04-test-matrix.md)
