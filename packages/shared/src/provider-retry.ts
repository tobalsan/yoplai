/**
 * Transient upstream provider errors, classified once for every Pi runtime.
 *
 * Host and sandboxed agents share this contract so a rate limit, a 5xx, or a
 * queue/backpressure hint is retried the same way and with the same delay
 * wherever the turn ran. The module is deliberately free of SDK imports: it
 * only needs the structural shape of an agent message.
 */

export const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_BASE_DELAY_SECONDS = 2;

/** Structural view of a Pi agent message; both runtimes pass their own type. */
export type RetryableTurnMessage = {
  role: string;
  stopReason?: unknown;
  errorMessage?: unknown;
};

/** A model turn that ended in failure, either thrown or reported as an errored assistant message. */
export type TurnFailure = { source: unknown; message: string; thrown: boolean };

/**
 * Report the last turn as failed when the model answered with an error stop
 * reason. Eligibility is per turn: earlier successful turns (including their
 * tool calls and results) do not disqualify a retry.
 */
export function findFailedTurn(
  messages: readonly RetryableTurnMessage[]
): TurnFailure | undefined {
  const lastAssistant = messages
    .slice()
    .reverse()
    .find((message) => message.role === "assistant");
  if (lastAssistant?.stopReason !== "error") return undefined;
  return {
    source: lastAssistant,
    message:
      typeof lastAssistant.errorMessage === "string" &&
      lastAssistant.errorMessage
        ? lastAssistant.errorMessage
        : "unknown error",
    thrown: false,
  };
}

/**
 * Resume the run after a failed turn without appending a duplicate user
 * message. The failed assistant message is dropped from the agent context (it
 * stays in the session transcript for history) and the agent continues from the
 * preceding user or tool-result message, mirroring pi's own auto-retry. Any
 * partial text the failed turn streamed is discarded with it. `reprompt` is
 * only used when dropping the turn leaves the context empty.
 */
export async function resumeAfterFailedTurn<M extends RetryableTurnMessage>(
  session: {
    agent: { state: { messages: M[] }; continue: () => Promise<unknown> };
  },
  reprompt: () => Promise<unknown>
): Promise<void> {
  const messages = session.agent.state.messages;
  if (messages[messages.length - 1]?.role === "assistant") {
    session.agent.state.messages = messages.slice(0, -1);
  }
  if (session.agent.state.messages.length === 0) {
    await reprompt();
    return;
  }
  await session.agent.continue();
}

export function isRetryableProviderError(
  error: unknown,
  message: string
): boolean {
  const status = getErrorStatus(error);
  if (
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599)
  ) {
    return true;
  }
  if (/\b(?:http\s*)?(?:429|5\d\d)\b/i.test(message)) return true;
  return /\b(queue(?:d|ing)?|backpressure|retry[- ]after|too many requests|rate limit|quota(?: exhaustion| exceeded)?|econnreset|econnrefused|enotfound|connection reset|connection (?:failed|refused)|network (?:error|failure)|socket hang up|etimedout|timeout|timed out|temporar(?:y|ily) unavailable|model (?:is )?(?:unavailable|overloaded)|overloaded)\b/i.test(
    message
  );
}

export function getProviderErrorCategory(
  error: unknown,
  message: string
): "rate_limit" | "timeout" | "network" | "unavailable" | undefined {
  const status = getErrorStatus(error);
  if (status === 429 || /rate limit|too many requests|quota/i.test(message)) return "rate_limit";
  if (status === 408 || /timeout|timed out|etimedout/i.test(message)) return "timeout";
  if (/econnreset|econnrefused|enotfound|connection|network|socket hang up/i.test(message)) return "network";
  if ((status !== undefined && status >= 500) || /queue|backpressure|unavailable|overloaded/i.test(message)) return "unavailable";
  return undefined;
}

export function getRetryDelaySeconds(
  error: unknown,
  message: string,
  baseDelaySeconds: number,
  attempt: number
): number {
  const retryAfter = getRetryAfterSeconds(error);
  if (retryAfter !== undefined) return retryAfter;
  const hint = /retry[- ]after\s+(\d+(?:\.\d+)?)\s*s(?:econds?)?\b/i.exec(
    message
  );
  return hint ? Number(hint[1]) : baseDelaySeconds * 2 ** (attempt - 1);
}

export type ProviderRetryLoopOptions = {
  maxAttempts: number;
  baseDelaySeconds: number;
  /** Runs the turn. `attempt` is 1-based; later attempts resume the failed turn. */
  runTurn: (attempt: number) => Promise<void>;
  /** Agent context after the turn, read to detect an errored assistant message. */
  getMessages: () => readonly RetryableTurnMessage[];
  /** Aborted runs are never retried, whether the abort threw or errored the turn. */
  isAbort: (error: unknown) => boolean;
  onRetry: (attempt: number, delaySeconds: number, message: string) => void;
  onAttempt?: (attempt: number, durationMs: number, failure?: TurnFailure) => void;
  sleep: (milliseconds: number) => Promise<void>;
};

/**
 * Run a turn, retrying it in place while the failure looks like a transient
 * upstream provider error. Returns once the turn succeeded or the failure is
 * final; a thrown final failure is rethrown, an errored assistant message is
 * left for the caller to report.
 */
export async function runTurnWithProviderRetry(
  options: ProviderRetryLoopOptions
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const startedAt = Date.now();
    let failure: TurnFailure | undefined;
    try {
      await options.runTurn(attempt);
    } catch (error) {
      failure = {
        source: error,
        message: error instanceof Error ? error.message : String(error),
        thrown: true,
      };
    }
    failure ??= findFailedTurn(options.getMessages());
    options.onAttempt?.(attempt, Date.now() - startedAt, failure);
    if (!failure) return;
    if (
      options.isAbort(failure.source) ||
      !isRetryableProviderError(failure.source, failure.message) ||
      attempt >= options.maxAttempts
    ) {
      if (failure.thrown) throw failure.source;
      return;
    }
    const delaySeconds = getRetryDelaySeconds(
      failure.source,
      failure.message,
      options.baseDelaySeconds,
      attempt
    );
    options.onRetry(attempt, delaySeconds, failure.message);
    await options.sleep(delaySeconds * 1000);
  }
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  for (const value of [
    record.status,
    record.statusCode,
    (record.response as Record<string, unknown> | undefined)?.status,
  ]) {
    if (typeof value === "number") return value;
  }
  return undefined;
}

function getRetryAfterSeconds(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const response = record.response as Record<string, unknown> | undefined;
  const headers = response?.headers ?? record.headers;
  if (!headers || typeof headers !== "object") return undefined;
  const value =
    headers instanceof Headers
      ? headers.get("retry-after")
      : Object.entries(headers as Record<string, unknown>).find(
          ([key]) => key.toLowerCase() === "retry-after"
        )?.[1];
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const retryAt = Date.parse(String(value));
  return Number.isNaN(retryAt)
    ? undefined
    : Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}
