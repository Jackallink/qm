# D0-T target-host deployment acceptance

## Status

Pending execution on the declared single-host Docker target. This checklist
does not replace the code-side D0-T closure in `d0t-coverage.md`; it closes
only the rows marked `DEPLOY-GATE` there. Until every required row has a
recorded result, the deployment is not a target-host acceptance and no
production Remote Turn binding or canary may be enabled.

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
