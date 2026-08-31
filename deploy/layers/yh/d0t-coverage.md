# D0-T coverage table — yh layer

Target profile: **single-host Docker** (docker-compose) on the declared D0-T
target host: this machine (macOS arm64, Darwin 24.6.0, Docker Desktop engine
28.3.0, Linux container platform), PostgreSQL in a pinned container on the
same host. Declared in `docs/specs/remote-turn-v1/08-gate3-runtime-spec.md`
§1.1. Per the roadmap D0-T exit gate
(`docs/specs/agent-platform-roadmap-v1/03-gates-and-evidence.md`), every
numbered requirement must have an ownership and acceptance path.

Profile revision note (2026-08-30): per the D0-T acceptance checklist
precondition 4, the host shape declared earlier as "customer's private
host, x86_64 Linux" is revised to the actual target host: this machine,
macOS arm64 + Docker Desktop (engine 28.3.0). Scope: host shape only; the
single-host Docker + pinned PostgreSQL container profile, boundaries, and
every A/B requirement row stand unchanged. An acceptance record from this
profile proves only this host shape.

Closure model (agent system): OWNER is the responsible component/agent;
ACCEPT is a machine-verifiable acceptance path (test suite, live e2e record,
or fresh-context review sign-off), not a person's name. Rows marked
**DEPLOY-GATE** are closed on the code side but require an on-site
confirmation step at deployment time, executed by the deployment agent and
verified by the acceptance evidence listed; the runbook (`deployment.md`)
carries each step.

Legend: RED = non-negotiable line; FORM = required runtime shape;
SCOPE = docs/business scope; METRIC = quantified target;
DEVIATION = approved waiver or failure strategy.

## A. Requirements coverage

| # | RED / FORM / SCOPE | Requirement | METRIC | OWNER | ACCEPT (evidence) | DEVIATION / STATUS |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | RED | No legacy remote-runtime selection/construction route reachable (Gate 0) | 0 reachable routes | gate0-agent | Gate 0 inventory tests (`test/remote-turn-error-contract.test.ts`, harness isolation suites) | CLOSED |
| A2 | RED | All-containerized control plane on one Docker host, loopback-only external exposure | 0 non-loopback public ports | deploy-agent | D0-L validation (`d0-local-docker-baseline-v1/05-validation-and-drift.md`) + compose review | CLOSED (D0-L); host exposure re-checked at deploy |
| A3 | FORM | PostgreSQL (pinned image) as the only durable store; core + remote-turn + attestor on one instance | — | core-agent / attestor-agent | Gate 2 pg suites + `remote_turn_*` DDL migrations; attestor `createPostgresAttestorStore` live e2e (attestor_e2e2 db) | CLOSED |
| A4 | FORM | Per-turn sandbox per 08 §3 | — | attestor-agent | G3-10 live e2e: real stopped container created/started/terminated with full cleanup | **BLOCKED**: revalidation required (see §C, 2026-08-31) |
| A5 | SCOPE | One org (`yh`), one allowlisted scope, one runtime release | — | deploy-agent | Binding config in runbook; G3-10 e2e binding | **BLOCKED**: revalidation required (see §C, 2026-08-31) |
| A6 | RED | Every state change/receipt/settlement/cancel/rollback/read durable, versioned, audited | 0 un-audited transitions | core-agent | Gate 2 pg suites + audit-read tests + A5/A6 after-commit fixes | CLOSED |
| A7 | RED | Fail closed on missing/expired/forged/replayed/denied G0 authority | 0 bypasses | g0-agent | `test/remote-turn-g0-verifier.test.ts` + claim-route e2e (replay denied `governance_replay`) | CLOSED |
| A8 | FORM | Attestor outside runtime trust boundary; complete proof chain | — | attestor-agent | 08 §2; attestor tests (pre-claim/start/termination) stand; live e2e proof chain invalidated | **BLOCKED**: revalidation required (see §C, 2026-08-31) |
| A9 | FORM | Non-bypassable egress (per-turn network, token, allowlist) | 0 bypass attempts succeed | egress-agent | Live e2e: sandbox cannot reach external hosts (timeout) + `forward` allowlist deny | **BLOCKED**: revalidation required (see §C, 2026-08-31) |
| A10 | RED | Termination + egress revocation proof before completion/cancel | 0 evidence-free transitions | attestor-agent / core-agent | Reconciler requires `terminationSeen && egressRevoked && digest` (code stands); live e2e terminate evidence invalidated | **BLOCKED**: revalidation required (see §C, 2026-08-31) |
| A11 | FORM | Conservative settlement; missing usage ⇒ full charge | 0 full-charge violations | core-agent | `test/remote-turn-receipt-budget-teardown.test.ts` (grace/full-charge) + usage verifier tests | CLOSED |
| A12 | SCOPE | One bounded text reply via normal QM surface | ≤ 16 KiB | runtime-agent / core-agent | Receipt byte-bound tests stand; G3-10 e2e reply invalidated | **BLOCKED**: revalidation required (see §C, 2026-08-31) |
| A13 | SCOPE | Runbook: deploy, rotate, parked-turn, rollback drill | Drill executed once | deploy-agent | `deployment.md` procedures | **DEPLOY-GATE**: drill once against fresh checkout before acceptance |

## B. Target environment feasibility

| # | Area | Requirement | Evidence | OWNER | ACCEPT | DEVIATION / STATUS |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | Database | Consistency/locking/migration/crash-recovery on the target Postgres container | Gate 2 pg suites; crash-recovery tests (`remote-turn-store-pg.test.ts` onStep) | core-agent | pg suites + crash tests | **DEPLOY-GATE**: one restart drill on the target host |
| B2 | Network | Per-turn internal networks, egress proxy sole outbound route | G3-06 stands; live e2e network inspect (`rt-net-*` members) invalidated | attestor-agent / egress-agent | live e2e | **BLOCKED**: revalidation required (see §C, 2026-08-31) |
| B3 | Architecture | Single-host Docker on the declared target: macOS arm64 + Docker Desktop (engine 28.3.0), compose; Linux container platform | Host facts sheet | deploy-agent | host facts recorded at deploy | **DEPLOY-GATE**: record OS/Docker/CPU/RAM at deployment |
| B4 | Licensing | Docker CE, postgres, node, jose, pg licenses reviewed | License note in runbook | deploy-agent | license note | CLOSED (vendored deps listed) |
| B5 | Crypto | Ed25519 key sets, mTLS, egress tokens; keys only in gitignored `.env`/secret store | Key ceremony + rotation drill | deploy-agent | ceremony/rotation in runbook | **DEPLOY-GATE**: rotation drill once at deploy |
| B6 | Time sync | Host NTP; skew windows depend on wall clock | `timedatectl` drift check | deploy-agent | drift check at deploy | **DEPLOY-GATE**: NTP confirmed at deploy |
| B7 | HA | Single host = no HA | Restart/rollback drill is recovery path | deploy-agent | runbook restart drill | DEVIATION: HA waived for v1; recovery = restart drill (must be exercised at deploy) |
| B8 | Storage | Postgres named-volume persistence, non-purge | D0-L persistence evidence; backup note | deploy-agent | D0-L evidence + backup note | **DEPLOY-GATE**: backup/restore policy recorded at deploy |
| B9 | Messaging | No external message dependency in v1 | — | core-agent | architecture (no Slack/queue in remote path) | CLOSED |

## C. Agent closure record

Every A/B row has an owner (component/agent) and a machine-verifiable
acceptance path. Standing evidence anchors: core suite (remote-turn +
run-store + api), layer suites (shared/attestor/egress), G3-01 type parity
(7 field sets + envelope digest), three fresh-context review rounds with
sign-off and fix batches.

2026-08-31 revalidation: the G3-10 live full-loop evidence
(`3171cf1`/`f5f0915`) is invalidated and G3-10 reverts to blocked. During
A13 execution on the target host, canary turn
`810debff-b0ba-4dce-b84f-ea6f2ed4b2d7` passed session_bind, admit,
prepare_dispatch and claim (HTTP 200), then failed: the runtime POSTs
`${EXECUTOR_BASE_URL}/execute` to egress-gw, which has no `/execute` route
(HTTP 404, turn ends in `timeout`). Root-cause review found five defects:
(1) the runtime executor URL names a route egress-gw never served; (2) the
core claim handler discards the attestor `/lease` response body, so
`startExecution` never runs, the turn stays `claimed`, and any receipt is
refused `not_receivable`; (3) the egress-gw `/agent/<sandbox>/` route was
added in `49af625` (2026-08-16 18:49), three hours after `f5f0915` (15:41)
recorded the "full loop", and the runtime never called it, so the 8-16
record proves at most a lower-layer sandbox-to-egress-to-model smoke, not
the Core-to-runtime-to-executor-to-receipt-to-teardown loop; (4) attestor
`connectNetwork` swallows all errors, so per-turn network membership in
that drill was never actually verified; (5) `/agent/<sandbox>/` binds no
turn, lease or capability and accepts arbitrary container names and paths,
so it cannot serve as the executor route as built. Rows A4, A5, A8, A9,
A10, A12 and B2 revert to revalidation required. Unit-test and Gate 2 pg
evidence not derived from the live loop stands. The layer runtime suite
currently has 2 failing fixtures (missing `bindingVersion`), to be fixed
with the G3-10 rework.

DEPLOY-GATE items remain on-site confirmations executed per `deployment.md`
(A13, B1, B3, B5, B6, B7, B8). G3-10 re-execution with the corrected
executor path is required before A4/A5/A8/A9/A10/A12/B2 can close. The
remediation design is
`docs/specs/remote-turn-v1/09-gate3-executor-capability-spec.md`
(Gate-1 re-review pending). A row
with no DEVIATION stands as written.
