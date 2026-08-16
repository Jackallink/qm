# D0-T coverage table — yh layer

Target profile: **single-host Docker** (docker-compose) on the customer's
private host, PostgreSQL in a pinned container on the same host. Declared in
`docs/specs/remote-turn-v1/08-gate3-runtime-spec.md` §1.1. Per the roadmap
D0-T exit gate (`docs/specs/agent-platform-roadmap-v1/03-gates-and-evidence.md`),
Gate 3 implementation starts only when every row below is closed (owner +
acceptor assigned, evidence linked, or an approved deviation recorded), and
the target database/network/OS evidence rows carry their proofs.

Legend: RED = non-negotiable line; FORM = required runtime shape;
SCOPE = docs/business scope; METRIC = quantified target; OWNER/ACCEPT =
assignment; DEVIATION = approved waiver or failure strategy.

## A. Requirements coverage

| # | RED / FORM / SCOPE | Requirement | METRIC (where quantified) | OWNER | ACCEPT | Evidence / DEVIATION |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | RED | No legacy remote-runtime selection/construction route reachable in production (Gate 0) | 0 reachable routes | | | Gate 0 inventory + negative tests |
| A2 | RED | All containerized control plane on one Docker host, loopback-only external exposure | 0 non-loopback public ports | | | D0-L evidence + compose review |
| A3 | FORM | PostgreSQL (pinned image) as the only durable store; same instance serves core + remote-turn + attestor databases | — | | | Gate 2 pg suites + attestor DB setup |
| A4 | FORM | Local Docker sandbox for D0-L QA baseline; remote-turn per-turn sandbox per 08 spec §3 | — | | | D0-L validation + G3 e2e |
| A5 | SCOPE | One configured org (`yh`), one allowlisted scope, one runtime release | — | | | Binding config + G3-10 |
| A6 | RED | Every admission/state change/receipt/settlement/cancel/rollback/read durable, versioned, audited | 0 un-audited transitions | | | Gate 2 + G3 audit tests |
| A7 | RED | Fail closed on missing/expired/forged/replayed/denied G0 authority | 0 bypasses | | | G3-14/G3-15 + fail-closed tests |
| A8 | FORM | Trusted attestor outside runtime trust boundary; proof chain complete (pre-claim/start/termination) | — | | | 08 spec §2 + G3-05/G3-18 |
| A9 | FORM | Non-bypassable egress enforcement (per-turn network, token, allowlist) | 0 bypass attempts succeed | | | G3-06 + egress integration |
| A10 | RED | Actual termination + egress revocation proof before completion/cancel | 0 evidence-free terminal transitions | | | G3-07 + Gate 2 residual fixes |
| A11 | FORM | Budget reservation/settlement conservative; missing usage ⇒ full charge | 0 full-charge violations | | | G3-08/G3-17 + ledger tests |
| A12 | SCOPE | One bounded text reply per turn; reply delivered via normal QM surface | ≤ 16 KiB reply | | | G3-10 + delivery tests |
| A13 | SCOPE | Operator runbook: deploy, rotate, parked-turn procedure, rollback drill | Drill executed once | | | 08 §8 + deployment.md |

## B. Target environment feasibility

| # | Area | Requirement | Evidence | OWNER | ACCEPT | DEVIATION |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | Database | Consistency/locking/migration/crash-recovery semantics on the target Postgres container | Gate 2 pg suites + one restart drill on the target host | | | |
| B2 | Network | Single Docker host, per-turn internal networks, egress proxy as sole outbound route | G3-06 + compose network review | | | |
| B3 | Architecture | OS-arch: x86_64 Linux host (Docker CE), compose-based | Host facts sheet | | | |
| B4 | Licensing | Docker CE, postgres image, envoy, Node runtime licenses reviewed | License review note | | | |
| B5 | Crypto | Ed25519 key sets, mTLS certs, egress tokens; keys only in gitignored `.env` (0600) or secret store | Key ceremony + rotation drill (G3-13) | | | |
| B6 | Time sync | Host NTP; token/attestation skew windows depend on wall clock | `timedatectl` + drift check | | | |
| B7 | HA | Single host = no HA; approved deviation: restart/rollback drill is the recovery path | Runbook restart drill | | | HA waived for v1 |
| B8 | Storage | Postgres volume persistence (named volumes, non-purge) | D0-L persistence evidence + backup note | | | |
| B9 | Messaging | No external message dependency in v1 (no Slack/queue integration for remote turns) | — | | | |

## C. Open items (to be filled by the organization)

1. OWNER/ACCEPT for every row above (operator + acceptor names).
2. Target host facts: OS version, Docker version, available CPU/RAM, network
   exposure plan, backup/restore policy.
3. Acceptor sign-off after each drill (B1 restart, B5 rotation, A13 rollback).
4. Any approved deviations must be recorded in the DEVIATION column with a
   failure strategy — an empty DEVIATION means the requirement stands as
   written.
