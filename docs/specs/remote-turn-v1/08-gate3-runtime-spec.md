# Gate 3 — Private Deployment Runtime Spec

Status: **draft for walkthrough** — 2026-08-16. Implements the Gate 3 half of
[README.md](./README.md) phase order: vendor runtime, immutable release, attestor,
egress enforcement, and runbook in the private deployment layer. All protocol
contracts (envelope, tokens, attestation artifacts, receipt, usage statement)
are defined by [05-protocol-schema.md](./05-protocol-schema.md) and are **not
redefined here**; this spec pins the deployment-layer decisions that 05 leaves
open ("private-layer decision" points) and the core-side wiring that Gate 2
explicitly deferred ([07-gate2-validation.md](./07-gate2-validation.md)
"偏差与部分覆盖" items 4–8).

## 1. Scope and prerequisites

### 1.1 D0-T target profile declaration

D0-T target profile for this branch: **single-host Docker** deployment
(docker-compose shape) on the customer's private host, with PostgreSQL in a
pinned container on the same host. Evidence basis:

- D0-L already proves the full control plane on this shape: all-container
  deployment on loopback, real model turns, restart and non-purge persistence
  (`d0-local-docker-baseline-v1/05-validation-and-drift.md`).
- Gate 2's pg suites prove the durable transaction, locking, migration,
  recovery, and cross-instance semantics of the PostgreSQL reference profile
  against this same shape (`07-gate2-validation.md`).
- Delta D0-L → D0-T: D0-L is a QA baseline on a developer machine; D0-T
  declares the same Docker+PostgreSQL shape as the production target for this
  deployment. The remaining D0-T evidence (per-requirement coverage table,
  host hardening, time sync, HA waiver) is tracked in the roadmap's coverage
  table and is **not** a Gate 3 implementation blocker: Gate 3's components
  make no durability or isolation demand beyond what the declared profile
  already proves.

A future move to multi-host, VM, ECS, or Kubernetes targets requires a revised
D0-T and re-audit; nothing in this spec may be cited as evidence for those
profiles.

Gate discipline (M8 ruling): this spec's walkthrough and approval proceed
now; **Gate 3 implementation starts only when the D0-T per-requirement
coverage table for the declared profile is closed** (delivered under
`deploy/layers/yh/` per the roadmap's D0-T exit gate). The README phase
order ("After D0-T validates…") and Status section stand as written; this
spec does not override them. D0-L evidence is cited as design input only —
per its own stop condition it is never production proof.

### 1.2 Gate 2 seams this spec closes

| Seam (07 items) | Gate 3 owner |
| --- | --- |
| Real turn-flow admission entry (app-turn branch, G0-presence routing) | core wiring (§5.1) |
| `REMOTE_TURN_SIGNING_KEY` env assembly | core wiring (§5.2) |
| Reconciler production wiring (ErrorLog, sweeper start) | core wiring (§5.3) |
| Transport resolver (envelope/abort actually sent to runtime) | core wiring (§5.4) |
| Real attestor behind `AttestorGateway.querySandboxState` | attestor service (§3) |
| Egress token issue/inject/revoke + usage statement | egress gateway (§3.3) |
| 07 item 7: denial-audit visibility (`readAuditChain` misses pre-admission refusals) | core wiring: denial events carry `scope_id` and the audit read joins on it (§5.6) |
| Walkthrough backlog: settle-before-commit race | core wiring (§5.5) |
| Walkthrough backlog: pool refcount / `remoteTurnStore.close()` in wiring `stop()` | core wiring (§5.3) |
| Walkthrough backlog: abort-token `exp` hardcoded to claim window; `attestation_nonce_hash` not bound in the claim CAS | core fixes landed with Gate 2 residual batch (store.ts) |
| Gate 2 residual batch from this walkthrough: reconcile/cancel zero-usage fabrication (A), unfounded egress-revoked assertion (B), binding key-rotation API (C), binding source-auth key id (D) | core fixes (Fix A–D commits) |

### 1.3 Explicit non-goals for Gate 3

- Real G0 governance-center integration. Gate 3 implements the G0-context
  consumption interface and routing (§5.1) with a configuration-driven
  verifier; the governance center itself is the G0 gate's own acceptance.
- Multi-organization bindings, browser/admin binding UI, dynamic binding API.
- Streaming, tools, files, persistent workspaces, multi-turn remote kernels.
- Multi-host orchestration, auto-scaling, HA failover of the runtime layer.
- Any claim of production readiness for profiles beyond §1.1.

## 2. Deployment topology

```text
                 ┌─────────────────────────── single Docker host ───────────────────────────┐
                 │                                                                          │
  browser ──────▶│  core (qm)                postgres (pinned)                              │
  (web/portal)   │    │ remote-turn ext                                                     │
                 │    │  ├─ turn-flow admission entry (G0 context)                          │
                 │    │  ├─ transport resolver ──────────────┐                              │
                 │    │  └─ reconciler ────────────┐         │ mTLS+source-auth             │
                 │    ▼                            │         ▼                              │
                 │  attestor service ◀─────────────┘    remote-runtime service              │
                 │    │ Docker socket (owns sandbox    │  POST /turn  POST /abort           │
                 │    │  lifecycle, mTLS to core,      │  (no Docker socket, no egress       │
                 │    │  Ed25519 attestor key)         │   credential, no host net)         │
                 │    ▼                            │                                       │
                 │  per-turn sandbox container ◀── executes model call ─┐                  │
                 │    (pinned image digest, no network except ──────────┼──▶ egress-proxy  │
                 │     egress-proxy, egress token injected by attestor) │   (envoy+LUA,    │
                 │                                                       │   token verify,  │
                 │                                                       │   allowlist,     │
                 │                                                       │   metering key)  │
                 └───────────────────────────────────────────────────────┼──────────────────┘
                                                                          ▼
                                                                 model endpoint allowlist
                                                                 (e.g. api.deepseek.com)
```

Trust boundaries (hard invariant 4):

- **Attestor owns the Docker socket.** It creates, measures, and destroys every
  per-turn sandbox. The runtime never holds Docker credentials and cannot
  create a container the attestor did not measure.
- **Egress credential lives only in the egress-proxy.** The scoped egress token
  is minted by the egress gateway, injected into the sandbox by the attestor at
  creation, and revoked by the gateway on teardown. The runtime never sees a
  provider API key.
- **Runtime is the least-trusted component.** It receives only the bounded
  envelope and turn token; it cannot reach the model endpoint except through
  the egress proxy inside its attested sandbox; its self-report alone never
  completes or cancels a turn.
- Core delivers the execution lease to the attestor over mTLS directly, never
  relayed through the runtime.
- The runtime↔attestor link (abort signal, executor readiness) is its own
  mTLS channel — the runtime may ask the attestor to terminate, but the
  attestor's proofs remain its own signed observations, never runtime
  assertions.

## 3. Component specs

All three services live under `deploy/layers/yh/` as org-specific service
images (`plugins/remote-runtime/`, `plugins/attestor/`, `plugins/egress-gw/`),
each with its own Dockerfile, config, and tests. They redeclare the 05
protocol types locally (layers never import core `src/`), with a generated
type-parity check in CI (§7).

### 3.1 remote-runtime service

Thin receiver + executor client. Endpoints (mTLS + source-auth, private
network only):

- `POST /turn` — verifies envelope schema, turn token (pinned `aud`, EdDSA,
  `kid` ∈ binding `coreVerificationKeys`, digest equality per 05 §turn token),
  input/history bounds. Relays the core-issued attestation nonce (generated by
  core at `prepareDispatch`, which persists `attestation_nonce_hash`; the
  dispatch payload carries it) plus the attestor's pre-claim attestation JWS
  to core's claim endpoint (§5.4a). On `no_lease`/refusal: typed error, no
  retry. On success: core delivers the execution lease to the attestor, the
  attestor starts the pre-created sandbox (§3.2), and the runtime performs
  the executor exchange: the bounded text is written to the sandbox's
  loopback-only executor listener over the per-turn internal network
  (§3.3's only route), the final reply is read back on the same hop. The
  runtime then signs the receipt with the runtime receipt key (Ed25519,
  `kid` ∈ binding `receiptKeys`) and posts it to core's receipt endpoint
  (§5.4a). The reply reaches the user only through core's normal delivery
  path after teardown completes (Gate 2 walkthrough fix 2) — the runtime
  never replies to the original caller directly.
- `POST /abort` — verifies abort token (capability `abort`, `turnJtiHash`
  match; post-claim also `executionLeaseHash`+`coreRunId`). Signals the
  attestor to terminate the sandbox. Returns the abort acknowledgement. Abort
  never grants `/turn`.

The runtime holds **no** Docker socket, **no** provider credential, **no**
egress token, and **no** network route to the model endpoint except via the
sandbox it does not control. Its only durable state is in-flight request
memory; a restart mid-turn surfaces as `parked` in core and is reconciled.

### 3.2 attestor service

Holds the Docker socket and the Ed25519 attestor key (`kid` ∈ binding
`attestorKeys`). Endpoints (mTLS only):

- `POST /attest/pre-claim` — input: the core-issued attestation nonce plus
  the complete core-signed turn token JWS, relayed from the runtime's claim
  flow (the nonce is generated by core at `prepareDispatch`; the runtime
  relays it). The attestor **verifies the full token JWS itself** (pinned
  `aud`, EdDSA, `kid` ∈ binding `coreVerificationKeys`) — relayed "facts"
  without the signature are not accepted. **Creates
  the sandbox now, in stopped state**: pulls the pinned `releaseDigest`
  image, creates the per-turn internal network (§3.3), creates (does not
  start) the container with `cap-drop: ALL` and no published ports, measures
  image identity, network attachment, and capability set, persists
  (nonce, JTI) single-use state, then signs and returns the
  `pre_claim_attestation` artifact with `plannedSandboxId` equal to the
  already-created sandbox id (05's normative "sandbox must already exist
  with its isolation verified before this attestation is signed"). Contains
  no execution lease.
- `POST /lease` — core delivers the raw execution lease here (never via
  runtime; the claim response carries it exactly once and core persists only
  its hash, per 05). On receipt: the attestor hashes the lease and verifies
  it against the claim, mints the scoped egress token with the egress
  gateway (the token binds `executionLeaseHash`, which only exists now),
  writes the token into the sandbox's **mounted token volume** (created with
  the container at pre-claim: a per-turn tmpfs/scope-limited volume mounted
  at `/run/remote-turn/token`; Docker cannot mutate a created container's
  env, so the token travels by file, never by env — the env shape is fixed
  at creation), **starts** the container, verifies running state, signs and
  returns `start_proof` (`sandboxId` must equal the pre-claim
  `plannedSandboxId`; core enforces the equality — already implemented in
  `attestation.ts`). If mint or start fails, the just-minted token is
  revoked immediately (N8) and the sandbox destroyed via the terminate
  path.
- `POST /terminate` — deletes the sandbox and its per-turn network, calls
  egress-gateway revoke, waits for `egressRevocationAck`, signs and returns
  `termination_proof`. Also serves the reaper path: a stopped sandbox whose
  turn never claims (pre-claim deadline passed, `failed_pre_dispatch`, or
  `rejected`) is destroyed by the attestor's own sweeper without a proof
  artifact — it never executed, so there is nothing to prove — and the
  reaping is logged durably. The sweeper's grace is the binding's pre-claim
  deadline **plus a 30s margin**, so a lease delivery racing the deadline
  always wins over the reaper (N5).
- `GET /sandbox-state?remoteTurnId=` — production implementation of
  `AttestorGateway.querySandboxState`: `{ exists, running, startProofSeen,
  terminationSeen, egressRevoked, terminationProofDigest }` from Docker state
  + its own proof log. Consumed by the core reconciler; the cancel path
  requires `terminationSeen && egressRevoked && terminationProofDigest`
  (Gate 2 residual fix B).

Single-use nonce/JTI state and the proof log are durable in the same
PostgreSQL cluster, separate `attestor` database — not SQLite: the declared
D0-T profile already operates PostgreSQL, and a second durable technology
would widen the runbook without adding assurance. An attestor restart must
not reuse a nonce or lose a proof.

Startup reconciliation (N6): every sandbox the attestor creates is labelled
(`remote-turn-id`, `attestor-managed`). At boot the attestor lists labelled
containers and networks, diffs against its durable log, and destroys any
labelled resource with no open record — a crash between "created" and
"recorded" can therefore never leave an invisible orphan.

Pre-claim resource cap (N7): the attestor admits at most
`ATTESTOR_MAX_PRECLAIM_SANDBOXES` (default 8) concurrent stopped sandboxes;
beyond that it refuses new pre-claim requests with a typed
`attestor_capacity` error, which core surfaces as a retryable admission
refusal (the turn never enters dispatching).

### 3.3 egress gateway

Extends the upstream `deploy/egress-proxy/` fail-closed envoy skeleton with a
decision service:

- **Per-turn network isolation**: every turn gets its own Docker network,
  created `internal: true` (no host route, no outbound default route). The
  sandbox attaches only to that network; the egress proxy joins it as the
  second member, so the proxy is the sandbox's sole reachable peer. The
  sandbox starts with `cap-drop: ALL` (no `NET_RAW` — sibling-spoof and
  metadata-forgery classes closed by construction, not by inspection).
  Token-to-sandbox binding therefore does not depend on source-IP checks on
  a shared bridge: the proxy listener serving that per-turn network serves
  exactly one sandbox and exactly one scoped token. The same hop carries the
  executor exchange (§3.1): the runtime reaches the sandbox's executor
  listener through the proxy's per-turn listener, so "sandbox can only reach
  the proxy" and "runtime can deliver text to the executor" hold
  simultaneously.
- **Token mint**: `POST /egress-tokens` (mTLS from attestor, after lease
  delivery) — mints a scoped token: { audience, endpoint allowlist,
  `executionLeaseHash`, workload identity, expiry, per-turn network id }.
- **Data plane**: envoy with the per-connection LUA decision (upstream
  skeleton) extended to require the turn's scoped token and enforce the
  endpoint allowlist; fail closed when the decision service is down.
  Sandbox-to-proxy traffic is plain HTTP on the per-turn internal network
  (the proxy is the trust boundary); proxy-to-endpoint is TLS. The proxy
  therefore sees full request/response bodies and extracts real usage
  fields — v1 has no CONNECT-tunnel blindness and no byte-estimate fallback.
- **Revoke**: `POST /egress-tokens/:id/revoke` (mTLS from core/attestor) —
  immediate deny + ack. Ack is a precondition of `termination_proof`.
- **Metering**: the decision service extracts `usage` from the model
  endpoint's response bodies per egress token and signs the
  `usage_statement` artifact with the metering key (`kid` ∈ binding
  `meteringKeys`). If the response carried no usable usage fields, no
  statement is signed and core settles the full reservation (hard
  invariant 9).

## 4. Immutable release

- One sandbox executor image, pinned by digest (`releaseDigest` in the
  binding). The image contains only the executor (bounded text in → model call
  via injected egress endpoint → bounded text out) and its runtime; no shell,
  no tools, no extra credentials.
- Release process: build → record digest → sign release attestation with
  `releaseAttestationKeyId` → update binding (new binding version) → deploy.
  Rollback = re-enable the previous binding version; core refuses turns whose
  `bindingVersion` no longer matches.
- The executor image is rebuilt reproducibly; two builds of the same source
  must produce the same digest, or the release process fails.

## 5. Core-side wiring (this branch, `src/`)

### 5.1 Turn-flow admission entry

`src/api/app-turn.ts`: when the request carries a server-verified G0 context
object (shape declared by the G0 contract: actor, scope, conversation
correlation, governance authorization/decision, trace id) **and** an enabled
binding matches (configured org + allowlisted scope), the turn calls
`remoteTurnStore.admit()` with the full request (incl. `deliveryTarget` /
`surface`, Gate 2 walkthrough fix) instead of the local enqueue. Absence of a
G0 context → unchanged local path. An explicit remote attempt without a valid
G0 context → typed denial + audit (already implemented in `admit`).

The G0 verifier is configuration-driven in Gate 3: a
`G0_CONTEXT_VERIFIER=static-keys` mode verifying a governance-signed context
JWS against configured public keys. The real governance-center trust
establishment is G0's own acceptance; this mode exists so the remote path is
end-to-end testable and fails closed on any malformed/expired/denied context.

Replay defense (M7 ruling): `governance_decision_id` is single-use. The
admission transaction consumes the decision id into a durable
`remote_turn_governance_consumption` table (unique key); a replayed decision
id is typed-denied `governance_replay` and audited. Presence/match checks
alone (Gate 2's current admit behavior) are not sufficient against a
replayed but otherwise valid governance grant.

### 5.2 Key assembly

`REMOTE_TURN_SIGNING_KEY` (Ed25519 private key PEM) →
`RemoteTurnKeyProvider` in wiring; missing/malformed ⇒ remote path disabled
with a startup log, local turns unaffected (fail closed for remote only).

### 5.3 Reconciler production wiring

`createRemoteTurnReconciler` wired in `src/wiring.ts` with the Postgres
ErrorLog, the attestor gateway client (§3.2), a Postgres leader lease, and
`sweeper.start()`. `stop()` closes the reconciler and `remoteTurnStore`
(Gate 2 backlog: pool refcount).

### 5.4 Transport resolver

`binding.transportServiceId` resolves to a service URL from a deployment
registry map (`REMOTE_TURN_TRANSPORTS` env JSON: service id → base URL);
unregistered id ⇒ typed refusal (no dispatch). mTLS client identity +
`transportCertificatePin` (SPKI pin) verified on connect; DNS/PKI mismatch ⇒
dispatch fails with `transport_invalid`. Dispatch sends the envelope + turn
token + attestation nonce to `POST /turn`; abort goes to `POST /abort`.

Failure semantics follow the state machine (M10 fix): while the turn is
`dispatching` (pre-claim), transport failure is **not** a park — the
reconciler resends the persisted envelope (dispatch_attempt+1) until the
pre-claim deadline, then `expirePreClaim` finalizes `failed_pre_dispatch`
with full reservation release. `parked` is only reachable post-claim, when
the remote boundary outcome is genuinely uncertain (hard invariant 5: never
auto-retried, never requeued).

### 5.4a Runtime-facing core control endpoints (B2 fix)

Gate 2 implemented the store transitions but no HTTP ingestion for the
runtime/attestor/egress callbacks. Gate 3 adds them under
`src/api/routes/remote-turn.ts`, all mTLS + source-auth against the
binding's `transportSourceAuthKeyId` domain (Gate 2 residual fix D), all
fail-closed:

- `POST /v1/remote-turn/claim` (runtime→core): { turn token, attestation
  nonce, pre-claim attestation JWS } → verifies the attestation via the
  existing `attestation.ts` verifier against binding `attestorKeys` →
  `store.claim(...)` (the nonce is bound in the claim CAS). On success the
  claim response carries the raw execution lease exactly once; core
  immediately pushes it to the attestor's `POST /lease` (§3.2) itself — the
  lease never transits the runtime and is never persisted or logged. If the
  lease push fails (attestor unreachable), the claimed turn is retried by
  the reconciler's claimed-state sweep with backoff; after
  `REMOTE_TURN_LEASE_PUSH_DEADLINE_MS` (default 60000) without delivery the
  turn moves to `cancel_requested` so the sandbox the attestor already
  created is torn down with evidence (N5).
- `POST /v1/remote-turn/start-proof` (attestor→core): start proof JWS →
  `store.startExecution(...)`.
- `POST /v1/remote-turn/receipt` (runtime→core): receipt JWS →
  `store.receiveReceipt(...)` only. It does **not** drive `beginTeardown`
  (N3 ruling): settlement consumes the trusted usage statement, which
  arrives asynchronously from the egress gateway, so tearing down
  immediately on receipt would settle every turn at full charge and make
  partial release unreachable.
- `POST /v1/remote-turn/usage` (egress-gw→core): usage statement JWS →
  **new verifier** (05 usage schema, `kid` ∈ binding `meteringKeys`, lease
  hash binding) → the statement is persisted against the turn.
- Teardown coordination (N3): after `receiveReceipt` succeeds, core's
  teardown coordinator waits up to `REMOTE_TURN_USAGE_GRACE_MS` (default
  15000) for the persisted usage statement, then calls
  `store.beginTeardown({ trustedUsageUsd })` with the statement's metered
  usage, or `null` on grace expiry (full charge, invariant 9). A statement
  arriving before the receipt is persisted and picked up when the receipt
  lands; a statement arriving after settlement is a recorded duplicate.
  Only after `beginTeardown` does core call the attestor's
  `POST /terminate`.
- `POST /v1/remote-turn/termination-proof` (attestor→core): termination
  proof JWS → **new verifier** (05 termination schema, `attestorKid` ∈
  binding `attestorKeys`, `egressRevocationAck` required) →
  `store.completeTeardown(...)`.

The two new verifiers live in `src/remote-turn/attestation.ts` beside the
existing pre-claim/start-proof verifier, with the same strictness
(`additionalProperties: false` shapes, key-set window semantics).

### 5.5 Settle-after-commit

Gate 2 backlog item: terminal listeners must fire after COMMIT on the remote
completion path. `completeOn`/`failOn` currently settle inside the admission
client's open transaction (`postgres-run-store.ts` settle call sites); the
fix defers listener dispatch until after commit while keeping exactly-once
via the RETURNING row. Covered by a wiring test asserting listeners observe
committed state.

### 5.6 Denial-audit visibility (07 item 7)

`recordDenial` events are persisted under the run id with no `remote_turn`
row, so `readAuditChain`'s JOIN never returns them. Fix: denial events gain a
`scope_id` column populated at admission time, and the audit read unions
denial rows by scope. A cross-scope denial read stays `not_found` and is
itself recorded, per the existing audit-read contract.

## 6. Key and certificate inventory

| Key/cert | Held by | Purpose | Rotation |
| --- | --- | --- | --- |
| `REMOTE_TURN_SIGNING_KEY` (Ed25519) | core env | turn/abort token signing | new binding version + `coreVerificationKeys` overlap window |
| attestor key (Ed25519) | attestor env | attestation artifact signing | `attestorKeys` overlap window |
| receipt key (Ed25519) | runtime env | receipt signing | `receiptKeys` overlap window |
| metering key (Ed25519) | egress-gw env | usage statement signing | `meteringKeys` overlap window |
| transport source-auth key id | binding row (`transport_source_auth_key_id`, fix D); secret value in the layer secret store | HMAC source-auth on runtime-facing endpoints, key domain independent of `CORE_SIGNING_SECRET` | binding key rotation (fix C) + secret-store re-key |
| mTLS certs ×5 links (core↔runtime, core↔attestor, core↔egress-gw, runtime↔attestor, attestor↔egress-gw) | each service | transport identity | deployment procedure, cert expiry monitored |
| egress token (scoped, opaque) | egress-gw mints, sandbox consumes | model egress authorization | per-turn, revoked at teardown |

All private keys enter the host via gitignored `.env` (0600) or the provider
secret store; none are committed. Overlap windows follow the binding key-set
semantics exactly as Gate 2 implemented them (`current`/`overlap` +
`activatedAt`/`retiresAt`).

## 7. Test matrix (Gate 3 layer)

| ID | Test | Layer |
| --- | --- | --- |
| G3-01 | type-parity: layer's redeclared 05 types vs a generated schema dump of core's | CI script |
| G3-02 | runtime `/turn` negatives: bad schema, wrong aud, expired token, wrong digest, oversize input/history | runtime unit |
| G3-03 | claim once: two concurrent claims → one lease, one `no_lease` | integration (core+runtime) |
| G3-04 | attestor nonce single-use across restart | attestor integration |
| G3-05 | planned-vs-actual sandboxId mismatch ⇒ core parks `runtime_attestation_invalid` | integration |
| G3-06 | egress bypass attempts from sandbox (direct IP, metadata, non-allowlisted host, foreign token) all denied | egress integration |
| G3-07 | revoke-before-complete ⇒ no completion; termination without `egressRevocationAck` ⇒ stays parked | integration |
| G3-08 | missing usage statement ⇒ full reservation settled; metered statement ⇒ partial release | integration |
| G3-09 | runtime restart mid-turn ⇒ parked ⇒ reconciled via attestor `sandbox-state` | integration |
| G3-10 | end-to-end: G0-context turn → admit → dispatch → claim → attested sandbox → reply delivered via normal delivery path → receipt → settlement → termination proof → audit chain complete | docker e2e |
| G3-11 | abort mid-execution ⇒ sandbox terminated, egress revoked, turn cancelled with evidence | docker e2e |
| G3-12 | core crash between admit and dispatch ⇒ orphan sweep; no double lease after restart | docker e2e |
| G3-13 | transport negatives: unregistered service id, wrong cert pin, runtime 5xx ⇒ typed refusal/park, never requeue | integration |
| G3-14 | G0 verifier negatives: missing/expired/forged/denied context ⇒ typed denial + audit; local path untouched without context | core integration |
| G3-15 | G0 replay: same `governance_decision_id` twice ⇒ second typed-denied `governance_replay` + audit | core integration |
| G3-16 | claim endpoint (§5.4a): valid pre-claim JWS → lease (raw value in the claim response exactly once, hash-only in DB/events); forged/expired/wrong-kid JWS → typed refusal; wrong attestation nonce ⇒ no_lease; lease pushed to attestor, never to runtime; lease-push failure ⇒ reconciler retries, deadline ⇒ cancel_requested | core integration |
| G3-17 | usage-gated teardown: receipt then usage ⇒ partial release; receipt without usage within grace ⇒ full charge; usage before receipt ⇒ applied when receipt lands; statement after settlement ⇒ recorded duplicate, no state change | core integration |
| G3-18 | termination-proof verifier: missing `egressRevocationAck` ⇒ no completion; forged proof ⇒ typed refusal | core integration |
| G3-19 | pre-claim transport failure ⇒ reconciler resends persisted envelope ⇒ deadline ⇒ `failed_pre_dispatch` + full release; never parked pre-claim | core integration |
| G3-20 | settle-after-commit: terminal listeners observe committed state (§5.5) | core integration |
| G3-21 | denial-audit visibility: cross-scope denial read ⇒ `not_found` + recorded; same-scope read includes the denial row (§5.6) | core integration |
| G3-22 | pre-claim sandbox created-but-never-claimed ⇒ attestor sweeper destroys it; no proof artifact; durable reap log | attestor integration |

## 8. Runbook outline (delivered as `deploy/layers/yh/deployment.md`)

Deploy order (postgres → egress-gw → attestor → runtime → core env update),
key generation/ceremony, binding creation/update procedure, rotation
procedures, parked-turn operator procedure (reconciler alerts → attestor
state → manual terminate), rollback drill, and the D0-T coverage-table
pointer. No capability is documented as enabled without its negative test and
rollback evidence (hard invariant 11).

## 9. Acceptance

Gate 3 implementation starts only after the D0-T per-requirement coverage
table for the declared single-host Docker profile is closed under
`deploy/layers/yh/` (roadmap D0-T exit gate). Gate 3 completes when:
G3-01…22 pass on the declared profile; a full
remote-turn lifecycle runs against the real layer services with the real
model endpoint; every 05 artifact exchanged is schema-verified on both ends;
and the runbook's deploy/rotate/rollback procedures have been executed once
against a fresh layer checkout.
