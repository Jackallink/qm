# Gate 3 — Executor Capability, Claim Recovery, Usage/Teardown Closure

Status: **draft for Gate-1 re-review** — 2026-08-31. Amendment to
[08-gate3-runtime-spec.md](./08-gate3-runtime-spec.md) closing the three
Round-2 blockers recorded in `deploy/layers/yh/d0t-coverage.md` §C
(2026-08-31 revalidation, which invalidated the 8-16 G3-10 evidence).
Design ruling: O1-1R (attestor mints, core relays, runtime never derives).

Signed artifact schemas in [05-protocol-schema.md](./05-protocol-schema.md)
are **unchanged**: the executor capability is a transport-level bearer
credential carried outside every JWS. No `protocolVersion` bump.

Sections: §1 executor capability contract, §2 claim-response loss recovery,
§3 usage and teardown closure, §4 master trace, §5 failure matrix,
§6 AC→test map, §7 implementation surface.

## 1. Executor capability contract

Amends 08 §3.1 (executor exchange), §3.3 (per-turn listener), §5.4a (claim
response).

### 1.1 Claim response shape

`POST /v1/remote-turn/claim` success response changes from
`{status: "claimed", executionLeaseHash, abortToken}` to:

```ts
{
  status: "executing";              // startProof committed before 200, §4 step 5-6
  executionLeaseHash: string;
  abortToken: string;
  executor: {
    routeId: string;                // "exr-<base64url>", CSPRNG ≥128 bits, not derived from any id
    capability: string;             // "exc.<base64url>", CSPRNG ≥128 bits, bearer credential
    expiresAt: number;              // Unix ms; lease-delivery time + executionWindowMs
  }
}
```

No URL and no container name ever appears in the claim response. The
runtime's gateway base URL is fixed deployment configuration
(`EXECUTOR_BASE_URL`, the egress-gw origin), unchanged from today.

### 1.2 Capability secrecy

Plaintext capability exists only in: the attestor→core `/lease` (or
`/lease-recovery`) mTLS response body, the core claim handler's memory, the
claim 200 response body, and runtime memory. It is never persisted in
plaintext, never logged, never written to any event or audit row. Egress-gw
persists only `SHA-256(capability)`. Core persists nothing about the
capability (audit references `routeId` only).

### 1.3 Runtime request shape

```
POST ${EXECUTOR_BASE_URL}/remote-turn/execute
x-executor-route-id: <routeId>
x-executor-capability: <capability>
body: { remoteTurnId, text, history }        // unchanged executor input
```

The runtime builds no path from turn ids or sandbox names. The old
hardcoded `${EXECUTOR_BASE_URL}/execute` and any container-name
derivation are removed.

### 1.4 Gateway durable route store

Egress-gw gains a PostgreSQL store (same cluster, separate `egress`
database, mirroring the attestor's `ATTESTOR_PG_URL` pattern; env
`EGRESS_PG_URL`). Its current in-memory token map moves into the same
store; a gateway restart mid-turn must not lose token or route state
(repo rule: in-flight work is durable).

Table `executor_route`: `route_id` PK, `capability_hash`, `remote_turn_id`,
`sandbox_id`, `execution_lease_hash`, `expires_at`, `status`
(`active` | `revoked`), `rotation_of` (nullable route_id), `created_at`,
`revoked_at`.

Registration: `POST /executor-routes` (mTLS from attestor only):

```ts
{ routeId, capability, remoteTurnId, sandboxId, executionLeaseHash,
  expiresAt, rotateFrom?: string }
```

One transaction: if `rotateFrom` names a route of the same
`remote_turn_id`, mark it `revoked`; insert the new row `active`. The
gateway hashes `capability` and discards the plaintext. Response:
`{ routeId, expiresAt }`.

### 1.5 Execute enforcement

`POST /remote-turn/execute` resolves `x-executor-route-id`, then requires
all of: row exists, `status = active`, `now < expires_at`,
`sha256(x-executor-capability) = capability_hash`. Only then it proxies the
verbatim body to `http://<sandbox_id-from-record>:8080/execute` on the
per-turn network and relays the response. Any failure: typed 401/404, no
proxying, audit-logged. The route grants exactly one action (execute) on
exactly one sandbox (from the record, never from the request). Expired
rows are lazily treated as revoked and periodically reaped.

Revocation: `POST /executor-routes/revoke-by-turn` (mTLS from attestor)
revokes every active route of a `remote_turn_id`; the attestor calls it
inside its terminate flow (§3). Revoke is immediate deny.

The pre-existing `/agent/<sandbox>/` route is out of scope for the remote
turn executor path. It serves the prime local-sandbox path
(`LOCAL_SANDBOX_AGENT_PROXY_URL`, `deployment.md`) and is unchanged by
this spec.

## 2. Claim-response loss recovery

Amends 08 §5.4a (claim endpoint) and §3.1 (runtime `no_lease` handling).

### 2.1 Failure mode

Attestor has started the sandbox, core has committed `claimed → executing`,
but the claim 200 (carrying the executor capability) never reaches the
runtime. Today's behavior: retry returns `no_lease`, the turn parks
permanently. That is unacceptable: the sandbox is running and the lease is
live.

### 2.2 Same-JTI recovery branch

The runtime retries `POST /v1/remote-turn/claim` with the **identical**
request body (same turn token JWS, hence same JTI). After the existing
checks (transport auth, token signature + `exp`, persisted
`turn_jti_hash` equality), the handler branches on persisted turn status:

| Turn status | Handler behavior |
| --- | --- |
| `dispatching` | Normal claim path (§4 steps 2-6). |
| `claimed` | Core calls attestor `POST /lease-recovery` (§2.3). On success: verify returned startProof, commit `startExecution` (`claimed → executing`), return 200 with the rotated executor block. |
| `executing` | Core calls attestor `POST /lease-recovery`. On success: return 200 with the rotated executor block. `startExecution` is not re-run. |
| `reply_received`, `teardown_pending`, terminal | `409 claim_refused` (execution window is over). |

Recovery is authenticated by the same token signature, unexpired token, and
JTI-hash equality with the dispatched turn. A different JTI for the same
turn stays a typed refusal. The claim CAS is unchanged: exactly one
transition out of `dispatching`; retries only re-enter the recovery branch.

### 2.3 Attestor `POST /lease-recovery`

Request `{ remoteTurnId, executionLeaseHash }` (mTLS from core only). The
attestor requires that it holds that lease (its durable record shows the
sandbox started for this turn). Then:

1. Rotates the executor capability at the gateway: `POST /executor-routes`
   with `rotateFrom` = the turn's previous route id. The gateway's single
   transaction revokes the old route and activates the new one; the old
   capability is dead immediately, so a leaked earlier claim 200 is
   useless.
2. Returns `{ startProof, executor: { routeId, capability, expiresAt } }`.
   The startProof is the persisted original (attestor proof log), not a
   re-signed artifact.

If the attestor holds **no** lease for the turn (the lease push never
arrived): `{ ok: false }`. Core then drives cancel with evidence (attestor
`/terminate` reaps the stopped sandbox per 08 §3.2 sweeper semantics) and
answers the runtime `503 lease_delivery_failed`. The execution lease is
**never re-minted**: 05's exactly-once invariant stands. Rotation is
bounded: at most `ATTESTOR_MAX_ROUTE_ROTATIONS` (default 3) per turn; the
counter is durable in the attestor store; overflow is a typed refusal and
the turn is left for the operator via the parked path.

### 2.4 `/lease` idempotency

The attestor `/lease` handler becomes idempotent on `executionLeaseHash`:
a re-push of the same lease (core crash between push and response, or the
§2.2 `claimed` branch arriving after a partial first attempt) must not
re-mint the egress token and must not restart the sandbox. It rotates the
capability as in §2.3 and returns the persisted startProof plus the new
route. First delivery persists the signed startProof in the attestor's
proof log so recovery can return it.

## 3. Usage and teardown closure

Amends 08 §3.1 (runtime duties), §3.2 (terminate), §3.3 (usage statement),
§5.4a (N3 teardown coordination). Confirms the spec's original
responsibility split: **runtime executes and submits the receipt; core
fetches and verifies usage; core drives terminate; core verifies the
termination proof and settles. The runtime forwards no termination proof on
any path.**

### 3.1 Runtime amendments

- After receipt submission the runtime does nothing further for the turn.
- Runtime failure paths (executor error, timeout) stop calling attestor
  `/terminate`. The runtime reports nothing extra; core's watchdog
  (`maxRuntimeMs`) parks the turn and the reconciler drives terminate
  (§3.4). This removes the runtime→attestor terminate dependency entirely.
- `POST /abort` handling: the runtime aborts its own in-flight executor
  request (local `AbortController`) and returns the acknowledgement. Core
  drives the sandbox terminate. (08 §3.1's "signals the attestor to
  terminate" is withdrawn.)

### 3.2 Usage statement: core pull

Egress-gw persists every signed `usage_statement` in its durable store,
keyed by `remote_turn_id`, at metering time. It does not call core.

Core fetches: the teardown driver (§3.3) calls the gateway's existing
`POST /usage-statement` route with `{ remoteTurnId }` over the
core↔egress-gw mTLS link (already in the 08 §6 key inventory). The route's
semantics change from sign-on-demand to serve-the-persisted-statement: it
returns the durable statement for the turn, which core verifies with the
existing `verifyUsageStatement` and persists via the existing
`recordUsageStatement`. Pulls retry within `REMOTE_TURN_USAGE_GRACE_MS`
(default 15000) of receipt; grace expiry settles the full reservation
(hard invariant 9). A statement that never verifies (`invalidMetering`)
parks the turn per the existing `advanceTeardown` contract.

Rationale for pull over push: "core fetches and verifies" keeps egress-gw
free of core credentials and removes a whole outbound-client failure class
from the least-rest boundary; the gateway's only new duty is durable
storage of what it already signs.

### 3.3 Core teardown driver (restart-safe)

The reconciler (08 §5.3) gains a teardown sweep in addition to the parked
sweep:

1. Turns in `reply_received`: pull usage (§3.2) or observe grace expiry,
   then `beginTeardown({ trustedUsageUsd })`. The synchronous
   `advanceTeardown` calls in the receipt/usage routes stay as the fast
   path; the sweep is the restart-safe backstop.
2. Turns in `teardown_pending`: call attestor `POST /terminate`, verify
   the returned termination proof with the existing
   `verifyTerminationProof`, then `completeTeardown`. Success-path proof
   delivery is this synchronous attestor→core response on the existing
   mTLS channel. The `POST /v1/remote-turn/termination-proof` HTTP route
   stays for reconciliation/manual flows only.

### 3.4 Attestor `/terminate` hardening

- Executor-route revocation joins the flow: revoke-by-turn (§1.5) runs
  alongside the egress-token revoke, before sandbox destruction.
- Fail-closed ordering: revoke acks first; on any revoke failure the
  sandbox is **retained**, no proof is signed, the call fails typed, and
  the turn parks for the operator. (Today the sandbox is destroyed first
  and the store left un-updated — withdrawn.)
- Docker errors are no longer swallowed anywhere in the terminate flow;
  destruction is verified by a post-remove inspect returning NotFound.
- `/terminate` is idempotent: an already-terminated turn returns the
  persisted proof from the attestor proof log (proof JWS is persisted, not
  just its digest).

### 3.5 Pre-claim network verification (feeds §4 step 1)

`connectNetwork` swallowing errors is withdrawn (P1 finding). The attestor
pre-claim flow becomes: create stopped sandbox → create per-turn internal
network → connect gateway container → **inspect the network and assert
exactly the sandbox and gateway are members** → only then sign the
pre-claim attestation. Any connect or inspect failure refuses the
pre-claim with a typed error and reaps the partial sandbox; no attestation
is signed over an unverified network.

## 4. Master trace

One bounded turn, closed end to end. States are `remote_turn.status`.

| # | Step | State after |
| --- | --- | --- |
| 1 | Attestor pre-claim: create stopped sandbox, verify real network config (§3.5); any connect/inspect failure refuses pre-claim | `dispatching` |
| 2 | Core atomic claim: claim CAS mints the unique execution lease | `claimed` |
| 3 | Core pushes the lease to the attestor (raw lease, never persisted, never to runtime) | `claimed` |
| 4 | Attestor mints egress token, writes token volume, registers the executor route at the gateway (§1.4), starts and inspects the sandbox, returns `startProof + {routeId, capability, expiresAt}` | `claimed` |
| 5 | Core verifies the startProof and commits `startExecution` | `executing` |
| 6 | Only on that commit, claim 200 returns the executor block | `executing` |
| 7 | Runtime executes via fixed gateway origin + capability (§1.3), then signs and submits the receipt | `reply_received` |
| 8 | Core pulls and verifies the gateway usage statement (§3.2), `beginTeardown`, calls attestor `/terminate` (§3.4), verifies the termination proof, `completeTeardown` and settlement | `completed` |
| 9 | Any step failure: executor route and egress token revoked, recoverable evidence preserved (§5) | per matrix |

Claim-response loss between 6 and 7 is recovered per §2 without a new
lease.

## 5. Failure matrix

| Failure point | Route revoked | Egress token revoked | Evidence | Final state |
| --- | --- | --- | --- | --- |
| §3.5 connect/inspect fails | n/a (none minted) | n/a | attestor refusal + reap log | `failed_pre_dispatch` path |
| egress token mint fails | n/a | n/a | attestor proof log | cancel with evidence (08 §3.2 N8) |
| route registration fails | n/a | yes | attestor proof log | cancel with evidence |
| sandbox start/inspect fails | yes | yes | attestor proof log | cancel with evidence |
| startProof verification fails at core | yes (via core-driven terminate) | yes | park event + attestation mismatch | `parked` (`runtime_attestation_invalid`) |
| executor call fails/timeout | via teardown sweep | via teardown sweep | receipt absence + watchdog event | `parked` → reconciled terminate |
| receipt invalid | via teardown sweep | via teardown sweep | refusal event | `parked` |
| usage missing at grace | n/a | yes (terminate) | full-charge settlement record | `completed` (full charge) |
| usage invalid (`invalidMetering`) | yes (terminate) | yes | park event | `parked` |
| terminate revoke ack fails | retained sandbox | retry/alert | attestor typed failure | `parked`, operator path |

## 6. AC → test map

New Gate 3 tests extend the 08 §7 matrix. Layers: `core` (src/), `attestor`,
`egress`, `runtime` (plugins), `e2e` (docker).

| AC | Acceptance criterion | Test | Layer |
| --- | --- | --- | --- |
| AC-1.1 | Claim 200 carries `{routeId, capability, expiresAt}`; no URL, no container name; `status: "executing"` | G3-23 | core integration |
| AC-1.2 | Gateway execute allows exactly the bound sandbox via record lookup; wrong route id, wrong capability, expired, revoked each typed-denied without proxying | G3-24 | egress integration |
| AC-1.3 | Capability persisted only as hash: gateway DB rows and logs contain no plaintext; core persists nothing | G3-25 | egress + core unit |
| AC-1.4 | Gateway route store survives restart: active route still executes after egress-gw restart | G3-26 | egress integration |
| AC-2.1 | Claim 200 lost (turn `executing`): same-JTI retry returns 200 with rotated capability; old capability immediately denied | G3-27 | core+attestor+egress integration |
| AC-2.2 | Recovery never re-mints the execution lease: lease hash identical across retry; egress token unchanged | G3-27 (assertion) | integration |
| AC-2.3 | Turn `claimed` with lease held by attestor: retry commits `executing` and returns rotated capability | G3-28 | integration |
| AC-2.4 | Turn `claimed` with no lease at attestor: typed refusal, cancel with evidence, sandbox reaped | G3-28 | integration |
| AC-2.5 | Wrong/expired JTI, or status past `executing`: typed refusal, no rotation | G3-27 negatives | integration |
| AC-2.6 | Rotation cap: 4th rotation typed-refused | G3-27 negative | attestor integration |
| AC-2.7 | `/lease` re-push of same lease hash: no token re-mint, no sandbox restart, rotated capability returned | G3-29 | attestor integration |
| AC-3.1 | Full success loop runs with runtime sending nothing after receipt; core pull fetches usage; terminate driven by core; proof verified; settlement complete | G3-10 (re-run, auditable) | e2e |
| AC-3.2 | Usage pull within grace → partial release; no statement at grace → full charge (stands from G3-08/G3-17, re-pointed at pull path) | G3-08/G3-17 amended | core integration |
| AC-3.3 | Teardown survives core restart mid-`teardown_pending`: sweep completes terminate + proof + settlement | G3-30 | core integration |
| AC-3.4 | Terminate fail-closed: revoke-ack failure retains sandbox, signs no proof, turn parks | G3-31 | attestor integration |
| AC-3.5 | Pre-claim network verification: connect or inspect failure ⇒ typed refusal, partial sandbox reaped, no attestation signed | G3-32 | attestor integration |
| AC-3.6 | Runtime sends no terminate call on success or failure paths (contract test: attestor terminate reachable only from core identity) | G3-33 | integration |
| AC-4 | Runtime layer fixtures fixed (2 failing, `bindingVersion`) | existing suite green | runtime unit |

G3-10 re-run is the auditable docker e2e against the declared D0-T profile
and is the acceptance for restoring `d0t-coverage.md` rows A4/A5/A8/A9/A10/
A12/B2.

## 7. Implementation surface

- **core**: claim handler recovery branch + synchronous startProof
  consumption (`src/api/routes/remote-turn.ts`); `pushLease` returns the
  response body and carries `executionWindowMs`; new attestor client
  `leaseRecovery`; new egress client `getUsageStatement`; reconciler
  teardown sweep; store accessors for claim recovery state
  (`src/remote-turn/store.ts`, `src/wiring.ts`).
- **attestor**: `/lease` idempotency + persisted startProof; new
  `/lease-recovery`; capability rotation counter; `/terminate` fail-closed
  ordering + idempotency + route revoke; `connectNetwork` fail-closed +
  inspect assertion (§3.5); gateway client `registerExecutorRoute` /
  `revokeRoutesByTurn`.
- **egress-gw**: PostgreSQL store (`EGRESS_PG_URL`); `/executor-routes`
  register + `revoke-by-turn`; `/remote-turn/execute` enforcement; durable
  usage statements served to core's pull; in-memory token map moved to the
  store. `/agent/*` untouched (prime path).
- **remote-runtime**: executor client → fixed path + capability headers;
  terminate signalling removed; `no_lease` retry policy per §2.2 (bounded
  same-JTI retry with backoff inside the token lifetime).
- **deployment.md**: new env (`EGRESS_PG_URL`, `ATTESTOR_MAX_ROUTE_ROTATIONS`),
  gateway DB create step, claim-response description refresh.
