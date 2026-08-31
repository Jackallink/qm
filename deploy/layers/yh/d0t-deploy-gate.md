# D0-T target-host deployment acceptance

## Status

Pending execution on the declared single-host Docker target. This checklist
does not replace the code-side D0-T closure in `d0t-coverage.md`; it closes
only the rows marked `DEPLOY-GATE` there. Until every required row has a
recorded result, the deployment is not a target-host acceptance and no
production Remote Turn binding or canary may be enabled.

Profile revision (2026-08-30): per precondition 4, the declared host shape
is this machine (macOS arm64 + Docker Desktop engine 28.3.0), revised in
`d0t-coverage.md` and spec §1.1 from the earlier "customer's private host,
x86_64 Linux" wording. The single-host Docker + pinned PostgreSQL profile,
boundaries, and requirements are unchanged.

## Preconditions

1. Start from a fresh checkout of the approved private release and record its
   commit and all deployed image digests.
2. Use the target host's gitignored secret source. Do not copy secrets into
   the checkout, images, command history, ordinary logs, or this record.
3. Follow `deployment.md` for service order, key ceremony, binding creation,
   rotation, parked-turn handling, and rollback.
4. Keep the profile single-host Docker. A different host shape, database,
   architecture, orchestration platform, or network design requires a revised
   D0-T review before this checklist is used.

## Required evidence

| Coverage row | Target-host action | Required record | Stop condition |
| --- | --- | --- | --- |
| A13 | Deploy from the fresh checkout; create and enable the approved binding; run one bounded canary; rotate once; disable and re-enable the binding as rollback. | Commit, image digests, binding versions, canary ID, stale-version refusal, rollback result, audit-chain reference. | Any action returns success without a corresponding durable state and audit result. |
| B1 | Restart PostgreSQL and the dependent services; verify migration state and perform the approved recovery/canary path. | Restart timestamps, health results, migration version, recovery result and audit-chain reference. | Lost state, duplicate execution, failed reconciliation, or unverified completion. |
| B3 | Record host facts before deployment. | OS release, kernel, Docker/Compose versions, CPU architecture/count, memory, storage capacity and Docker daemon configuration. | Host differs from the declared single-host Docker profile without a revised D0-T review. |
| B5 | Exercise the key ceremony and one overlapping key rotation followed by rollback. | Key identifiers only, never values; binding versions, overlap/retirement times, rotation and rollback proof. | A secret value enters Git, logs, an image, ordinary CLI output, or an unauthorized service. |
| B6 | Verify time synchronization and record observed clock state. | `timedatectl`/equivalent output, time source and measured synchronization state. | Time is unsynchronized or exceeds the configured token/receipt skew policy. |
| B7 | Record the single-host HA waiver and execute the documented recovery drill. | Approved waiver reference, service restart sequence, recovery time and final health/canary result. | HA is claimed, or recovery cannot restore a safe stopped/operable state. |
| B8 | Record the backup policy and perform one restore validation against an isolated recovery target. | Backup location class, retention, restore timestamp, recovered schema/config proof and cleanup record. | Only a backup command exists; no restore result is available. |

## Execution log

### 2026-08-30/31 — A13 partial execution on the declared target host

Fresh checkout (`d0t-acceptance` worktree at `3a793c7`), key ceremony, image
build (executor `qm-executor:d0t`, digest `3c79a158…`), compose stack up.
B3 host facts recorded: macOS 15.6 (24G84), kernel 24.6.0 arm64, 10 cores,
64 GiB RAM, Docker Desktop engine 28.3.0, overlay2, linux/aarch64. Binding
`binding-1` (version 2) created and enabled. Core fixes `ae346c9`,
`b30db2c`, `9da1720` landed during the drill (single-source pre-claim
expiry; dispatch UPDATE parameter numbering). Canary turn
`810debff-b0ba-4dce-b84f-ea6f2ed4b2d7` passed session_bind, admit,
prepare_dispatch and claim (HTTP 200), then failed at the executor link:
the runtime POSTs `${EXECUTOR_BASE_URL}/execute` to egress-gw, which has no
such route (HTTP 404); the turn ended in `timeout`. Root-cause review
invalidated the 8-16 G3-10 evidence and identified five defects (see
`d0t-coverage.md` §C). Result: **blocked** — G3-10 rework required before
A13 can complete. Rotation and rollback drills were not executed in this
run.

## Acceptance record template

Record one entry per target deployment in the approved private evidence store:

| Field | Value to record |
| --- | --- |
| Target profile | Single-host Docker, hostname or approved opaque target identifier |
| Release | Commit, release tag and deployed image digests |
| Operator | Authorized deployment identity, not a personal secret or token |
| Scope | Approved organization and allowlisted scope identifier |
| A13/B1/B3/B5/B6/B7/B8 | Pass, fail, or blocked with links to the evidence above |
| Exceptions | Approved deviation ID, owner and expiry; no silent waiver |
| Final decision | Accepted, rejected, or parked; accepted requires all rows above to pass |

## Result boundary

An accepted record proves only the declared single-host Docker profile. It
does not prove Kubernetes, HA, multi-host recovery, a different operating
system or database, browser governance integration, PC/device adapters, or
any capability outside the approved Remote Turn binding.
