export class NonRetryableTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableTurnError";
  }
}

export function isTerminalTurnError(err: unknown): boolean {
  return (
    err instanceof NonRetryableTurnError ||
    (typeof err === "object" && err !== null && (err as { retryable?: unknown }).retryable === false)
  );
}

export type TurnFailurePayload = { kind: "turn_failure"; message: string };

const GENERIC_TURN_FAILURE = "That turn failed and couldn't be completed. The details are in the operator error log.";

export function turnFailureMessage(err: unknown): string {
  return isTerminalTurnError(err) && err instanceof Error && err.message.trim() ? err.message : GENERIC_TURN_FAILURE;
}
