/**
 * Raised when a follow-up is delivered to a run whose runtime is already gone.
 * A run settles (container exited, IPC namespace removed) before the gateway
 * finishes flushing its history, so joins can still find a live-looking handle
 * during that window. Callers must re-buffer the message for the next run
 * instead of writing it into a namespace nothing is polling.
 */
export class RunSettledError extends Error {
  readonly runSettled = true;

  constructor(message = "Run already settled") {
    super(message);
    this.name = "RunSettledError";
  }
}

export function isRunSettledError(error: unknown): error is RunSettledError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { runSettled?: unknown }).runSettled === true
  );
}
