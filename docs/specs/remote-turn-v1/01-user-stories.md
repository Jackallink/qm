# Round 1 — User Stories and Acceptance Criteria

## Decision being validated

Phase 1 is a one-shot protected Remote Turn. It has no Agent management product, no browser administration surface, and no user runtime selector. The configured organization is singular; scope authorization remains QM-owned.

## Personas

| Persona | Authority | What it may do in v1 |
| --- | --- | --- |
| Deployment controller | mTLS/signed release identity registered in core configuration | Create, enable, disable, or rotate a generic remote-runtime binding through the deployment procedure. |
| QM user | Current G0-verified designated-entry identity, governance decision, and session membership | Submit a normal text turn; it may be routed remotely only when the server verifies that G0 context. Request abort for a visible run; the capability reaches the runtime only from core. |
| Runtime service | Private mTLS/source-auth identity plus a per-turn capability | Claim exactly one lease, execute the fixed protocol, return receipt, and honor abort. |
| Deployment attestor | Key pinned in the binding | Attest immutable release, sandbox identity, and egress enforcement; prove termination. |
| Audit operator | Read-only operational database role/procedure | Read the durable Remote Turn/audit chain for an authorized scope; no browser UI is implied. |

## Stories

### US-01: Release-controlled opt-in

As a deployment controller, I can enable one versioned binding for one allowlisted scope only through the durable deployment procedure, so that a browser request, user parameter, cookie, environment default, or admin header cannot turn on a remote runtime. The binding describes a vendor-neutral runtime contract (protocol version, audience, digest, key sets) and never names a vendor implementation; any vendor runtime that meets the contract can be swapped in without a core change — the same pluggability the procurement requires of the execution-engine layer.

Acceptance criteria: RTH-02, RTH-03, RTH-05.

### US-02: Normal protected text turn

As a QM user with a current G0-verified designated-entry and governance authorization in an enabled scope, I can send a normal text turn and receive one bounded final reply. A direct QM request without that exact context remains non-remote, even when its ordinary QM authentication succeeds.

Acceptance criteria: RTH-03, RTH-04, RTH-05, RTH-08, RTH-10, RTH-14.

### US-03: Conversation and scope isolation

As a QM user, I cannot cause my request to use another scope, conversation, session, binding, token, or prior text. A same-scope concurrent conversation cannot share remote-runtime state or cancellation effects.

Acceptance criteria: RTH-03, RTH-04, RTH-06, RTH-07, RTH-09.

### US-04: Safe denial

As an operator, I see an explicit refusal before remote execution when binding, identity, transaction, budget reservation, attestation, egress, token, or input prerequisite fails. The system does not fall back to host execution, direct network access, or a legacy adapter.

Acceptance criteria: RTH-01, RTH-03, RTH-04, RTH-05, RTH-07, RTH-08, RTH-12.

### US-05: Honest abort

As a verified QM user who may view the run, I can use the existing normal-run abort action to request cancellation. Core authorizes visibility/scope, writes a durable RemoteTurn abort request, and sends a server-minted abort capability to the runtime; it never gives that capability to the browser. A browser disconnect is not an abort. A deployment controller can disable a binding and request abort for every active bound turn. Both callers learn whether each targeted sandbox was actually stopped and its egress authority revoked. A partial rollback is reported as partial, not successful.

Acceptance criteria: RTH-09, RTH-11, RTH-12, RTH-14.

### US-06: Durable evidence

As an audit operator, I can retrieve the binding snapshot, server-derived context, admission decision, attestation, token/lease events, receipt, budget reservation/settlement, and terminal outcome after process or instance restart without exposing another scope.

Acceptance criteria: RTH-05, RTH-06, RTH-07, RTH-09, RTH-10, RTH-13.

### US-07: Safe rollout and rollback

As a deployment controller, I can disable the binding and roll back to the prior approved local runtime. New remote admissions stop atomically; active work is terminated or parked for remediation; future user turns do not silently resume a legacy runtime path.

Acceptance criteria: RTH-01, RTH-02, RTH-09, RTH-11, RTH-14.

## Non-stories

No persona may create an agent, start a process on the QM host, open an Agent Panel, request a health check, send an agent message, schedule work, create a file/tool call, retain remote context, import a skill, choose a provider/model/CLI argument, or manage a binding from a browser.

## Round-1 approval condition

The stories are approved only when the authority boundaries, delivery procedure, non-stories, and all RTH mappings are accepted. No unresolved operational claim can be promoted into an acceptance criterion without an owner and test in Round 3/4.
