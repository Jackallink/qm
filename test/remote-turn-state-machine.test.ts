import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canTransition,
  nextState,
  REMOTE_TURN_EVENTS,
  REMOTE_TURN_STATUSES,
  type RemoteTurnEvent,
  type RemoteTurnStatus,
} from "../src/remote-turn/state-machine.ts";

const LEGAL: ReadonlyArray<readonly [RemoteTurnStatus, RemoteTurnEvent, RemoteTurnStatus]> = [
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

const LEGAL_KEYS = new Set(LEGAL.map(([from, event]) => `${from}:${event}`));
const TERMINAL_NO_EVENT = new Set<RemoteTurnStatus>(["rejected", "failed_pre_dispatch", "failed"]);

test("every legal transition from the spec allowed-transitions table is accepted and maps to its next state", () => {
  for (const [from, event, to] of LEGAL) {
    assert.equal(canTransition(from, event), true, `${from} --${event}--> ${to}`);
    assert.equal(nextState(from, event), to, `${from} --${event}--> ${to}`);
  }
});

test("idempotent no-op transitions keep the same state", () => {
  assert.equal(nextState("dispatching", "restart"), "dispatching");
  assert.equal(nextState("completed", "duplicate_receipt"), "completed");
  assert.equal(nextState("cancelled", "duplicate_receipt"), "cancelled");
});

test("every illegal state/event pair is rejected", () => {
  for (const from of REMOTE_TURN_STATUSES) {
    for (const event of REMOTE_TURN_EVENTS) {
      if (LEGAL_KEYS.has(`${from}:${event}`)) continue;
      assert.equal(canTransition(from, event), false, `${from} --${event}--> should be illegal`);
      assert.throws(() => nextState(from, event));
    }
  }
});

test("terminal states rejected/failed_pre_dispatch/failed accept no events", () => {
  for (const from of TERMINAL_NO_EVENT) {
    for (const event of REMOTE_TURN_EVENTS) {
      assert.equal(canTransition(from, event), false, `${from} --${event}--> must be illegal`);
    }
  }
});

test("terminal states completed/cancelled accept only the duplicate_receipt no-op", () => {
  for (const from of ["completed", "cancelled"] as const) {
    for (const event of REMOTE_TURN_EVENTS) {
      if (event === "duplicate_receipt") {
        assert.equal(canTransition(from, event), true, `${from} --${event}--> must be legal`);
      } else {
        assert.equal(canTransition(from, event), false, `${from} --${event}--> must be illegal`);
      }
    }
  }
});
