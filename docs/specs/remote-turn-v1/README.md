# Remote Turn v1

## Status

**walkthrough-approved** — 2026-08-15, Gate 1 approval conditions closed in [06-gate1-review.md](./06-gate1-review.md). Implementation starts only after the test matrix in this directory is approved, with red tests for the relevant criteria.

**Gate 2: upstream generic extension implemented** — red-test-first; validation in [07-gate2-validation.md](./07-gate2-validation.md). D0-T/G0/X0 evidence still required before Gate 2 completion sign-off and any binding enablement/canary.

- Audit baseline: `2fbfc00549444ac8cc3977d9e5c6ea9f9f50762d` (2026-08-11)
- Storage design revision: the draft's D0-T precondition has been exercised per its own revision clause. The storage design is now the named **PostgreSQL reference profile** (the current QM session primitive is PostgreSQL-based), re-audited through the multi-expert walkthrough and Gate 1 review recorded in [06-gate1-review.md](./06-gate1-review.md). D0-L already provides local Docker/Postgres persistence evidence (`d0-local-docker-baseline-v1/05-validation-and-drift.md`). D0-T's remaining role is to prove that the target environment matches this profile's durable transaction, session-binding, locking, migration, recovery, and cross-instance semantics; a mismatch requires a revised, separately audited storage design before Gate 2 completion. A local, memory, or independently committed substitute is not valid.
- External research is reference material only; it is not implementation evidence.
- Before formal Gate 1 approval, the program roadmap's D0-T gate must prove that the approved target environment provides the same durable transaction, session-binding, locking, migration, recovery, and cross-instance semantics required here. If it cannot, this draft must be revised to a named, equivalently tested storage design and re-audited; a local, memory, or independently committed substitute is not valid.
- Before formal Gate 1 approval, the program roadmap's G0 and X0 gates must supply the designated-entry/governance contract and the reference runtime's attestation/egress/termination proof. This specification defines neither a private governance protocol nor a vendor runtime implementation.

## Problem

The experimental branch combines a vendor-specific remote harness, Agent Runtime Gateway, admin panel, host launching, messaging, scheduling, and automatic skill import. The audit found fail-open identity, hard-coded tenant data, unverified control-plane access, host and egress boundary gaps, RAM-backed state, and success responses for operations that do not happen.

This restart delivers one narrow vertical slice first: one protected text-only remote turn through the program's designated-entry/governance path and the normal QM surface it verifies. It is not an Agent platform, and no existing experimental implementation is its production baseline.

## Goal

The G0-verified designated-entry context is an external contract: the shapes of actor, scope, conversation correlation, governance authorization/decision, and trace correlation are defined by the G0 gate's contract, not invented here. This specification declares only the consumption interface — a server-verified context object with those fields — and fails closed when it is missing, stale, mismatched, or governance-denied. No remote admission, reservation, JTI, or remote request is created without it.

A direct QM request without the required designated-entry and governance authorization stays on an already approved non-remote path; if any route explicitly attempts Remote Turn admission without a valid G0 context, it is denied and audited rather than falling back. The runtime receives restricted text, returns one bounded final reply, and can be actually aborted. Streaming, tools, files, persistent kernel state, and background agents are deferred.

Because v1 carries no tools or side-effecting calls, the governance authorization carried in the G0 context is itself the approval: there is no second-stage human approval gate in v1. This follows procurement requirement #13, whose approval-gate context is tool calls and write operations; a pure-text remote turn does not enter that context. The decision is recorded here so a Gate-1 reviewer does not re-litigate it.

Every remote invocation must have server-derived identity and scope, a durable transactional admission record, one-time dispatch authority, trusted runtime/sandbox/egress evidence, conservative budget reservation and settlement, an authenticated receipt, an actual termination proof, and a usable rollback path.

## Architecture decision

The generic QM core work is a new vendor-neutral **Remote Turn extension**, not a reuse of the present `RunStore` as-is. It requires a transaction-capable `RemoteTurnStore` and budget/audit interfaces in one durable transaction domain. PostgreSQL is the named initial reference profile; the D0-T gate proves the target environment satisfies the same contract, and a mismatch requires a revised, separately audited storage design before Gate 2 completion. The extension owns irreversible remote-dispatch state, replay defense, cancellation, receipt verification, and recovery. The existing `RunStore` may carry the surrounding normal-turn job only after it gains an explicit remote-once recovery policy; its current automatic requeue behavior is not valid for remote dispatch.

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
4. Before execution, a trusted deployment attestor — not the less-trusted runtime — must prove the pinned release/image identity, exact RemoteTurn/JTI/workload identity, isolated sandbox identity, and enforced model-only egress policy. Failure denies dispatch. The attestor and the egress gateway must sit outside the runtime's trust boundary: separate processes or management-plane components whose signing keys the runtime cannot reach (network isolation, least privilege, key rotation). Without that separation, an attestor-signed termination or deletion result is indistinguishable from a runtime self-report, and this invariant collapses. The attestor is the single authoritative source of sandbox-identity facts — whether it creates the sandbox or only measures it is a private-layer decision; who creates the sandbox is a layer choice, who proves its isolation is the attestor, and who verifies the equality is core.
5. A remote turn is allowed exactly one execution lease. After a remote boundary outcome is uncertain, it is `parked` for reconciliation; it is never automatically retried or requeued.
6. Turn and abort credentials have distinct capabilities and JTIs. A consumed JTI, wrong audience/scope/conversation/session/run, invalid request digest, invalid signing key, or excessive clock skew is denied. The abort JTI binds the turn's `turnJtiHash` (the only stable pre-claim identity), not an execution lease that does not exist yet; the claim transaction mints the lease-bound abort authority only after claim.
7. The runtime sees only the bounded text envelope and an egress token. It never receives browser identity, attachments, tool outputs, mounted workspace, full environment, provider key, or QM signing key.
8. A final reply is not delivered and a turn is not `completed` until verified sandbox termination and egress-token revocation. A runtime's self-report alone is insufficient for completion or cancellation.
9. Usage settlement relies on a binding-pinned gateway/provider-metered statement. Missing trusted usage charges the full conservative reservation; it never releases budget based only on a runtime receipt.
10. Every admission, state change, receipt, usage settlement, cancellation, rollback action, and read is durable, versioned, and audited. Audit or reservation failure rolls the admission back before dispatch.
11. No capability is exposed or documented as enabled unless its enforcement, negative tests, and rollback evidence exist.

## Phase order

1. **Gate 0 / F0 — Quarantine legacy paths.** Make every legacy experimental remote-runtime selection/construction route unreachable. This isolated safety work may start immediately and may run in parallel with D0-L local Docker planning; it does not enable a new Remote Turn.
2. **Program prerequisites — D0-L, D0-T, G0, X0.** D0-L first establishes only a reproducible local Docker text baseline and is complete. D0-T then completes the target environment contract (proving the target matches the PostgreSQL reference profile named in this specification); G0 completes the designated-entry/governance connection; X0 completes the reference runtime deployment baseline. D0-L has passed; D0-T, G0, and X0 evidence is required before Gate 2 completion, any new Remote Turn implementation, binding enablement, or canary.
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

`RemoteTurn` is a new generic transaction-owned record, linked one-to-one to the ordinary core run. `RemoteTurn.coreRunId` is `NOT NULL UNIQUE REFERENCES runs(id) ON DELETE RESTRICT`, and `RemoteTurn.qmSessionId` references `sessions(id) ON DELETE RESTRICT`; the ordinary `runs` table gains a `delivery_mode` column with `'remote_once'` for these rows, and every requeue path (`retire()`, `reapExpired()`, heartbeat-cancel, `releaseInFlight`, drain) must exclude `remote_once` rows. The admission ordering is enqueue-run-first: the ordinary run row (with `delivery_mode='remote_once'`) is created before the admission transaction, which then binds the session and the RemoteTurn row. Required fields include:

`remoteTurnId`, `coreRunId`, `admissionKey`, `conversationKey`, `scopeId`, `actorId`, `qmSessionId`, `governanceAuthorizationDigest`, `governanceDecisionId`, `bindingId`, `bindingVersion`, `policySnapshotHash`, `releaseDigest`, `inputDigest`, `envelopeDigest`, `turnJtiHash`, `abortJtiHash`, `executionLeaseHash`, `attestationNonceHash`, `workloadIdentity`, `budgetReservationId`, `status`, `version`, `dispatchOwner`, `dispatchAttempt`, `preAdmissionExpiresAt`, `preClaimExpiresAt`, `dispatchStartedAt`, `claimExpiresAt`, `claimedAt`, `parkedAt`, `reconciledFromState`, `reconciliationEvidenceRef`, `receiptDigest`, `trustedUsageDigest`, `usageSettlementId`, `terminationProofDigest`, `correlationId`, timestamps, and references to the append-only `remote_turn_events` audit chain. The `remote_turn` row is a versioned mutable projection; the audit chain is a separate append-only table, so state-machine transitions and audit immutability never conflict.

The ordinary queue currently uses `conversation.threadRef` before `Session.id` exists. v1 records that server-authorized value as `conversationKey` at admission. Before a dispatch token can be issued, `SESSION_STORE=postgres` in the same database is mandatory: a transaction-capable session-binding primitive resolves/creates the QM `Session`, atomically binds its immutable `qmSessionId`, and enforces a foreign-key/restrict-delete relationship while the RemoteTurn is nonterminal. Memory SessionStore and an independently committed bind are invalid. A thread reference is never mislabeled as a QM session ID.

### Remote-turn state machine

`created -> session_bound -> admitted -> dispatching -> claimed -> executing -> reply_received -> teardown_pending -> completed`

`created|session_bound|admitted -> rejected` on their deadline before dispatch, with reservation/session-lease release and no remote request.

`dispatching -> cancel_requested` on an authorized abort arriving before claim; core writes a durable abort request and revokes the turn JTI so the pending claim is atomically refused. The claim transaction guards with `status='dispatching' AND turn_jti_hash=$2 AND abort_requested_at IS NULL AND version=$v`; zero rows matched means no lease. Without this transition, a user abort in the 90-second pre-claim window is silently dropped and the runtime still executes.

`dispatching -> failed_pre_dispatch` only after the turn token expires unclaimed and core has revoked its JTI.

`dispatching|claimed|executing|reply_received|teardown_pending -> cancel_requested -> cancelled` only after trusted termination and egress-revocation proof.

`claimed|executing|reply_received|teardown_pending|cancel_requested -> parked` whenever dispatch, receipt, termination, or core/runtime recovery is uncertain.

`parked -> failed` only when reconciliation proves the sandbox never started and no lease was consumed (attestor query empty, no start proof); the reservation is released in full and the audit records the proof digest. `parked -> completed|cancelled` is likewise reachable only through the audited reconciliation procedure with a version-guarded CAS and evidence digest.

`completed`, `rejected`, `failed_pre_dispatch`, `failed`, and `cancelled` are terminal and are never rewritten. `parked` is terminal until an explicitly audited reconciliation procedure records a new final result. The `remote_turn` row is a versioned mutable projection (every transition bumps `version` with a CAS); the audit chain is a separate append-only `remote_turn_events` table, so reconciliation rewriting `parked` never conflicts with audit immutability. A valid receipt moves `executing -> reply_received`; core then begins teardown and delivers the reply only after `teardown_pending -> completed` receives trusted deletion/revocation proof. Duplicate receipts after `reply_received`, `completed`, or `cancelled` are durably audited and ignored; invalid/late receipts can park only an active state and never rewrite a terminal state. No generic worker/reaper may redeliver a `dispatching`, `claimed`, `executing`, `reply_received`, `teardown_pending`, `cancel_requested`, or `parked` remote turn. The implementation must add a generic `remote_once` recovery policy to the surrounding queue or use a dedicated generic Remote Turn worker; `RunStore.reapExpired()` cannot be used unchanged.

### Atomic admission and accounting

Every persisted deadline (`preAdmissionExpiresAt`, `preClaimExpiresAt`, `claimExpiresAt`, `parkedAt`) is written and evaluated with the database clock (`transaction_timestamp()` in SQL), never the application clock, so multi-instance drift cannot extend or shrink authority windows. The 60-second runtime ceiling is enforced by a leader-leased sweeper that transitions `executing -> cancel_requested` with `now() >= claimed_at + maxRuntimeMs` under CAS. The application clock is used only for JWT `nbf`/`exp` validation, and the documented 30-second maximum skew applies only to `nbf`/`iat` acceptance, never extends `exp`.

The `admit` transaction locks the enabled binding, validates the current G0 server-verified designated-entry actor/scope/conversation correlation and governance authorization/decision, validates input bounds, creates/binds the Postgres QM session where necessary (resolving or creating the `Session` in the same transaction, then `SELECT ... FOR UPDATE` on the bound row), creates the RemoteTurn record, writes the append-only audit event, reserves a conservative maximum budget, and returns an `admitted` record with no turn JTI, nonce, or remote authority. Lock order is fixed: session -> RemoteTurn -> reservation -> audit. A missing, expired, denied, replayed, or actor/scope/conversation-mismatched G0 context records a durable denial and returns `remote_refused: governance_authorization_required`; it creates no admission, reservation, JTI, or remote request. If a binding, session bind, audit, budget reservation, or durable store operation fails, the transaction rolls back and no remote request is sent.

The core dispatch coordinator owns a unique `admissionKey = SHA-256(coreRunId || bindingVersion || scopeId || conversationKey || inputDigest)` and a unique `coreRunId` RemoteTurn row. `admissionKey` is a content-addressed idempotency key, not an authorization credential: its inputs are all derivable from the row, so it cannot prove dispatch ownership. Ownership and pre-claim resume are proven by the ordinary run's `lease_token` plus a version CAS, the same pattern `postgres-run-store.ts` already uses for `claimRun`. The unique constraint on `admissionKey` is a partial index over non-terminal states only, so a legitimate identical re-send after a terminal outcome is not permanently blocked. Only the idempotent `prepareDispatch` transaction may change `admitted -> dispatching`; that transaction records the one turn-JTI hash, attestation-nonce hash, dispatch owner/attempt, and `preClaimExpiresAt` before any network call. `created`/`session_bound` records expire after five minutes without admission and release their remote-session lease; `admitted` records expire after five minutes without `prepareDispatch` and release the reservation/lease. These pre-claim states may be resumed only by the same lease-owner before expiry. A `dispatching` worker may resend the exact already-persisted envelope until its 90-second token deadline, but may not mint a replacement JTI/nonce. After expiry it revokes the JTI, releases reservation/lease, and records `failed_pre_dispatch`. Only a state after successful claim can become `parked`.

The present `BudgetTracker.check()`/`record()` and best-effort audit helper do not meet this contract. The upstream extension must supply a transaction-capable scoped reservation/settlement ledger and durable audit write, as two new tables in the same Postgres domain: `budget_reservations(id, remote_turn_id UNIQUE, scope_id, binding_id, usd, window_anchor_ms, status['reserved'|'settled'|'released'|'charged'], created_at)` and `budget_balances(scope_id, window_anchor_ms, available_usd)`. Every reservation is a single guarded statement — `UPDATE budget_balances SET available_usd = available_usd - $x WHERE scope_id=$1 AND window_anchor_ms=$2 AND available_usd >= $x` — never check-then-insert. The reservation amount is `min(bindingCeilingUsd, budget_balances.available)`; an insufficient balance refuses admission with a typed `remote_refused`. Settlement accepts exactly three outcomes: trusted usage releases `(ceiling - trustedUsage)` back to its window; missing trusted usage marks the reservation `charged` in full; invalid/mismatched metering parks the active turn with the reservation held. A binding-pinned egress gateway or provider-metering adapter signs the usage statement for the exact execution lease; only that statement can release unused reservation.

## Protocol and trust contract

`POST /turn` and `POST /abort` are contract names, not currently registered APIs. They are reachable only over a private/mTLS deployment channel **and** source authentication; either alone is insufficient — mTLS proves the transport peer, source-auth proves the request was not forged, altered, or replayed. The remote-turn channel uses a source-auth signing key domain separate from `CORE_SIGNING_SECRET` (which in this codebase is also the browser/plugin surface master key); the separate key is provisioned by the deployment layer, and the binding stores only the key ID and verification material.

- A turn token has `kid`, `iss`, `aud`, `iat`, `nbf`, `exp`, `jti`, `capability=turn`, `remoteTurnId`, `bindingVersion`, `conversationKey`, `scopeId`, `qmSessionId`, `coreRunId`, `inputDigest`, `envelopeDigest` (covering `remoteTurnId || bindingVersion || conversationKey || scopeId || qmSessionId || coreRunId || inputDigest || historyDigest`), and protocol version. Claims use a canonical serialization defined in [05-protocol-schema.md](./05-protocol-schema.md) to defeat JSON ambiguity attacks. A token is accepted only within the documented 30-second skew window (skew applies to `nbf`/`iat` only, never extends `exp = iat + tokenTtlMs` with the 90-second hard cap) and only once.
- An abort token has a different `jti` and `capability=abort`; it contains no authority to invoke a turn. It binds the turn's `turnJtiHash` before claim; the lease-bound abort authority is minted atomically inside the claim transaction once a lease exists.
- The runtime must present the turn token to an authenticated core `claim` operation before sandbox creation. The claim atomically consumes the turn JTI and returns one execution lease. A repeated request receives no usable lease and cannot start a second sandbox.
- Core pins the binding's receipt key set and validates key ID, signature, release digest, execution lease, input digest, status, output/usage schema, and freshness. The receipt key set is snapshotted at admission (`receiptKeySetVersion`), so a rotation during execution never rejects a legitimate receipt signed under the old key. Signing key rotation uses an explicit ordered key set `[{kid, publicKey, state: current|overlap, activatedAt, retiresAt}]` with at most one overlap entry, and records the key ID used.
- `runtimeAudience` is an identity, not a URL (an opaque URN such as `urn:qm:v1:runtime:<configuredOrgId>:<name>`; it is never equal to an endpoint URL or the egress audience). A deployment-provided static transport registry resolves `transportServiceId` to a private HTTPS endpoint with pinned mTLS server identity/certificate. The destination is chosen only by the deployment-controller-written `binding.transportServiceId` through that static registry; no request, dispatch envelope, token claim, or DNS response can override or replace the resolved endpoint or the `transportCertificatePin` (the pin is carried by the binding, not by the registry). Resolver tests cover unregistered service, certificate/SAN mismatch, DNS rebinding, and non-private destination denial.
- Before claim success, a deployment attestor signed by the binding's pinned attestation key produces a **pre-claim attestation** for the exact `remoteTurnId`, binding version, turn-JTI hash, attestation nonce, intended workload identity, expiry/single use, planned sandbox ID, immutable release digest, isolation mode, non-bypassable network-policy ID, exact model endpoint allowlist, and egress-token audience. It contains no execution lease, because core has not issued one. Core verifies this evidence; the runtime's own configuration claim is not evidence. After claim, the attestor produces a **start proof** bound to the issued execution lease and actual workload/sandbox identity; core must verify `startProof.sandboxId == preClaim.plannedSandboxId` and `startProof.workloadIdentity == preClaim.intendedWorkloadIdentity`, and a mismatch parks the turn with an `runtime_attestation_invalid` audit record. The attestor must verify the core-signed envelope and persist (nonce, JTI) single-use state before attesting; core notifies the attestor of the issued lease directly (mTLS attestor interface), never through runtime relay. The gateway injects the egress token only into that attested workload identity and rejects it from another sandbox or host; egress-token copy resistance binds the token to the sandbox's network-layer identity, not to a bearer string in its environment.
- A binding-pinned gateway/provider-metering statement binds the execution lease, workload identity, model endpoint, usage, cost, and timestamp. Core uses it for settlement rather than trusting runtime-reported usage. The two metering modes are explicit trust statements: gateway mode trusts the deployment-owned non-bypassable egress enforcement path; provider mode trusts the third-party billing record's authenticity and correlation.
- Termination proof contains the execution lease, sandbox ID, attestor-signed exit/deletion result, egress-token revocation acknowledgment, and timestamp. Core independently verifies it before `completed`, `cancelled`, or rollback success. The attestor-signed report is trusted only because of the trust-domain separation in hard invariant 4; a report signed by a component inside the runtime's trust boundary is treated as a runtime self-report.

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
- [Protocol schema (normative)](./05-protocol-schema.md)
- [Gate 1 walkthrough approval record](./06-gate1-review.md)
