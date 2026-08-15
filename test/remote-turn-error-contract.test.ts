import { test } from "node:test";
import assert from "node:assert/strict";
import {
  errorOutcome,
  remoteTurnError,
  type RemoteTurnError,
} from "../src/remote-turn/error-contract.ts";

test("error contract maps every spec Round-3 row to its typed outcome", () => {
  const cases: Array<{ input: RemoteTurnError; expected: string }> = [
    { input: remoteTurnError("governance_authorization_required"), expected: "remote_refused: governance_authorization_required" },
    { input: remoteTurnError("runtime_not_enabled"), expected: "remote_refused: runtime_not_enabled" },
    { input: remoteTurnError("admission_not_committed"), expected: "remote_unavailable: admission_not_committed" },
    { input: remoteTurnError("execution_uncertain"), expected: "remote_parked: execution_uncertain" },
    { input: remoteTurnError("receipt_unverified"), expected: "remote_parked: receipt_unverified" },
    { input: remoteTurnError("receipt_ignored"), expected: "remote_refused: receipt_ignored" },
    { input: remoteTurnError("invocation_denied"), expected: "remote_refused: invocation_denied" },
    { input: remoteTurnError("partial_rollback"), expected: "remote_partial_rollback" },
  ];
  for (const { input, expected } of cases) {
    assert.equal(errorOutcome(input), expected, `outcome for ${input.code}`);
  }
});

test("error contract preserves durable evidence and owner on every row", () => {
  const row = remoteTurnError("receipt_unverified", "rt-1", "receipt-settler");
  assert.equal(row.code, "receipt_unverified");
  assert.equal(row.remoteTurnId, "rt-1");
  assert.equal(row.owner, "receipt-settler");
  assert.ok(row.durableEvidence, "durable evidence reference must be present");
  assert.equal(errorOutcome(row), "remote_parked: receipt_unverified");
});

test("error contract rejects unknown codes", () => {
  assert.throws(() => remoteTurnError("not_a_real_code" as never));
});
