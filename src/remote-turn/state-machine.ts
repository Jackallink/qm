export type RemoteTurnStatus =
  | "created"
  | "session_bound"
  | "admitted"
  | "dispatching"
  | "claimed"
  | "executing"
  | "reply_received"
  | "teardown_pending"
  | "cancel_requested"
  | "parked"
  | "completed"
  | "rejected"
  | "failed_pre_dispatch"
  | "failed"
  | "cancelled";

export type RemoteTurnEvent =
  | "session_bind"
  | "admit"
  | "prepare_dispatch"
  | "abort_pre_claim"
  | "claim"
  | "restart"
  | "start"
  | "attestation_invalid"
  | "receipt"
  | "teardown"
  | "complete"
  | "abort"
  | "timeout"
  | "park"
  | "reconcile_completed"
  | "reconcile_cancelled"
  | "reconcile_failed"
  | "reject_deadline"
  | "expire_pre_dispatch"
  | "duplicate_receipt";

export const REMOTE_TURN_STATUSES: readonly RemoteTurnStatus[] = [
  "created",
  "session_bound",
  "admitted",
  "dispatching",
  "claimed",
  "executing",
  "reply_received",
  "teardown_pending",
  "cancel_requested",
  "parked",
  "completed",
  "rejected",
  "failed_pre_dispatch",
  "failed",
  "cancelled",
];

export const REMOTE_TURN_EVENTS: readonly RemoteTurnEvent[] = [
  "session_bind",
  "admit",
  "prepare_dispatch",
  "abort_pre_claim",
  "claim",
  "restart",
  "start",
  "attestation_invalid",
  "receipt",
  "teardown",
  "complete",
  "abort",
  "timeout",
  "park",
  "reconcile_completed",
  "reconcile_cancelled",
  "reconcile_failed",
  "reject_deadline",
  "expire_pre_dispatch",
  "duplicate_receipt",
];

const TRANSITIONS: ReadonlyArray<readonly [RemoteTurnStatus, RemoteTurnEvent, RemoteTurnStatus]> = [
  ["created", "session_bind", "session_bound"],
  ["created", "reject_deadline", "rejected"],
  ["session_bound", "reject_deadline", "rejected"],
  ["session_bound", "admit", "admitted"],
  ["admitted", "reject_deadline", "rejected"],
  ["admitted", "prepare_dispatch", "dispatching"],
  ["dispatching", "abort_pre_claim", "cancel_requested"],
  ["dispatching", "claim", "claimed"],
  ["dispatching", "restart", "dispatching"],
  ["dispatching", "expire_pre_dispatch", "failed_pre_dispatch"],
  ["claimed", "start", "executing"],
  ["claimed", "park", "parked"],
  ["claimed", "attestation_invalid", "parked"],
  ["executing", "park", "parked"],
  ["executing", "receipt", "reply_received"],
  ["reply_received", "park", "parked"],
  ["reply_received", "teardown", "teardown_pending"],
  ["teardown_pending", "complete", "completed"],
  ["claimed", "abort", "cancel_requested"],
  ["executing", "abort", "cancel_requested"],
  ["reply_received", "abort", "cancel_requested"],
  ["teardown_pending", "abort", "cancel_requested"],
  ["claimed", "timeout", "cancel_requested"],
  ["executing", "timeout", "cancel_requested"],
  ["reply_received", "timeout", "cancel_requested"],
  ["teardown_pending", "timeout", "cancel_requested"],
  ["cancel_requested", "complete", "cancelled"],
  ["cancel_requested", "park", "parked"],
  ["teardown_pending", "park", "parked"],
  ["completed", "duplicate_receipt", "completed"],
  ["cancelled", "duplicate_receipt", "cancelled"],
  ["parked", "reconcile_completed", "completed"],
  ["parked", "reconcile_cancelled", "cancelled"],
  ["parked", "reconcile_failed", "failed"],
];

const TRANSITION_KEYS = new Map<string, RemoteTurnStatus>(
  TRANSITIONS.map(([from, event, to]) => [`${from}:${event}`, to]),
);

export function canTransition(from: RemoteTurnStatus, event: RemoteTurnEvent): boolean {
  return TRANSITION_KEYS.has(`${from}:${event}`);
}

export function nextState(from: RemoteTurnStatus, event: RemoteTurnEvent): RemoteTurnStatus {
  const to = TRANSITION_KEYS.get(`${from}:${event}`);
  if (to === undefined) {
    throw new Error(`illegal remote-turn transition: ${from} --${event}-->`);
  }
  return to;
}
