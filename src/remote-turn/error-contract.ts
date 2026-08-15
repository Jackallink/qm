export type RemoteTurnErrorCode =
  | "governance_authorization_required"
  | "runtime_not_enabled"
  | "admission_not_committed"
  | "execution_uncertain"
  | "receipt_unverified"
  | "receipt_ignored"
  | "invocation_denied"
  | "partial_rollback";

export interface RemoteTurnError {
  code: RemoteTurnErrorCode;
  remoteTurnId?: string;
  owner: string;
  durableEvidence: string;
}

const OUTCOMES: Record<RemoteTurnErrorCode, string> = {
  governance_authorization_required: "remote_refused: governance_authorization_required",
  runtime_not_enabled: "remote_refused: runtime_not_enabled",
  admission_not_committed: "remote_unavailable: admission_not_committed",
  execution_uncertain: "remote_parked: execution_uncertain",
  receipt_unverified: "remote_parked: receipt_unverified",
  receipt_ignored: "remote_refused: receipt_ignored",
  invocation_denied: "remote_refused: invocation_denied",
  partial_rollback: "remote_partial_rollback",
};

const OWNERS: Record<RemoteTurnErrorCode, string> = {
  governance_authorization_required: "g0-context-verifier",
  runtime_not_enabled: "binding-resolver",
  admission_not_committed: "admission-transaction",
  execution_uncertain: "reconciliation-coordinator",
  receipt_unverified: "receipt-settler",
  receipt_ignored: "receipt-settler",
  invocation_denied: "core-claim-abort",
  partial_rollback: "deployment-controller",
};

export function remoteTurnError(code: RemoteTurnErrorCode, remoteTurnId?: string, owner?: string): RemoteTurnError {
  if (!(code in OUTCOMES)) throw new Error(`unknown remote-turn error code: ${String(code)}`);
  return {
    code,
    ...(remoteTurnId ? { remoteTurnId } : {}),
    owner: owner ?? OWNERS[code],
    durableEvidence: `remote_turn_events:${code}`,
  };
}

export function errorOutcome(error: RemoteTurnError): string {
  return OUTCOMES[error.code];
}
