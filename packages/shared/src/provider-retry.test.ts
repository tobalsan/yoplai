import { describe, expect, it, vi } from "vitest";
import {
  findFailedTurn,
  getProviderErrorCategory,
  isReplayableFailedTurn,
  getRetryDelaySeconds,
  isRetryableProviderError,
  resumeAfterFailedTurn,
  runTurnWithProviderRetry,
  type RetryableTurnMessage,
} from "./provider-retry.js";

const RELACE_ERROR =
  "Upstream error from Relace: Queued past the 0.2s queue-time bound. Retry after 2s.";

function erroredTurn(errorMessage = RELACE_ERROR): RetryableTurnMessage {
  return { role: "assistant", stopReason: "error", errorMessage };
}

describe("isRetryableProviderError", () => {
  it("categorizes eligible provider failures for observability", () => {
    expect(getProviderErrorCategory({ status: 429 }, "nope")).toBe("rate_limit");
    expect(getProviderErrorCategory(undefined, "request timed out")).toBe("timeout");
    expect(getProviderErrorCategory(undefined, "network failure")).toBe("network");
    expect(getProviderErrorCategory({ status: 503 }, "nope")).toBe("unavailable");
  });
  it("retries rate limits and server errors reported as a status", () => {
    expect(isRetryableProviderError({ status: 429 }, "nope")).toBe(true);
    expect(isRetryableProviderError({ statusCode: 503 }, "nope")).toBe(true);
    expect(
      isRetryableProviderError({ response: { status: 500 } }, "nope")
    ).toBe(true);
  });

  it("retries transient failures reported only in the message", () => {
    for (const message of [
      RELACE_ERROR,
      "HTTP 429 Too Many Requests",
      "provider returned 502",
      "rate limit exceeded",
      "backpressure from upstream",
      "socket hang up",
      "read ECONNRESET",
      "connect ETIMEDOUT",
      "request timed out",
      "network failure contacting provider",
      "model temporarily unavailable",
      "quota exhaustion",
    ]) {
      expect(isRetryableProviderError(undefined, message)).toBe(true);
    }
  });

  it("does not retry client errors or unrelated failures", () => {
    expect(
      isRetryableProviderError({ status: 400 }, "Invalid request: mock fatal")
    ).toBe(false);
    expect(isRetryableProviderError({ status: 401 }, "unauthorized")).toBe(
      false
    );
    expect(isRetryableProviderError(undefined, "tool not found")).toBe(false);
  });

  it("does not retry failures that only the caller can fix", () => {
    for (const message of [
      "authentication_error: invalid x-api-key",
      "permission denied for this organization",
      "model `gpt-5-turbo` does not exist or you do not have access to it",
      "invalid_request_error: unknown parameter 'temperatur'",
      "Your request was rejected as a result of our safety system",
      "the assistant refused to answer",
      "prompt is too long: 210000 tokens > 200000 maximum",
      "context_length_exceeded",
      "tool `bash` failed: exit code 1",
      "tool not found: send_file",
    ]) {
      expect(isRetryableProviderError(undefined, message)).toBe(false);
      expect(getProviderErrorCategory(undefined, message)).toBeUndefined();
    }
  });
});

describe("isReplayableFailedTurn", () => {
  it("replays a failed turn that produced nothing, whatever came before", () => {
    expect(isReplayableFailedTurn([{ role: "user" }, erroredTurn()])).toBe(
      true
    );
    expect(
      isReplayableFailedTurn([
        { role: "user" },
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "t1" }],
        },
        { role: "toolResult" },
        erroredTurn(),
      ])
    ).toBe(true);
  });

  it("treats thinking-only output as nothing the user keeps", () => {
    expect(
      isReplayableFailedTurn([
        { role: "user" },
        { ...erroredTurn(), content: [{ type: "thinking", thinking: "hmm" }] },
      ])
    ).toBe(true);
  });

  it("refuses to replay a failed turn that showed text or called a tool", () => {
    expect(
      isReplayableFailedTurn([
        { role: "user" },
        { ...erroredTurn(), content: [{ type: "text", text: "partial" }] },
      ])
    ).toBe(false);
    expect(
      isReplayableFailedTurn([
        { role: "user" },
        { ...erroredTurn(), content: [{ type: "toolCall", id: "t1" }] },
      ])
    ).toBe(false);
    expect(
      isReplayableFailedTurn([
        { role: "user" },
        { ...erroredTurn(), content: [{ type: "toolCall", id: "t1" }] },
        { role: "toolResult" },
      ])
    ).toBe(false);
  });
});

describe("getRetryDelaySeconds", () => {
  it("prefers a Retry-After header over the message hint and backoff", () => {
    expect(
      getRetryDelaySeconds(
        { headers: { "Retry-After": "7" } },
        RELACE_ERROR,
        2,
        1
      )
    ).toBe(7);
    expect(
      getRetryDelaySeconds(
        { response: { headers: new Headers({ "retry-after": "5" }) } },
        "boom",
        2,
        1
      )
    ).toBe(5);
  });

  it("falls back to the retry hint in the message", () => {
    expect(getRetryDelaySeconds(undefined, RELACE_ERROR, 10, 3)).toBe(2);
  });

  it("doubles the base delay per attempt otherwise", () => {
    expect(getRetryDelaySeconds(undefined, "HTTP 500", 2, 1)).toBe(2);
    expect(getRetryDelaySeconds(undefined, "HTTP 500", 2, 2)).toBe(4);
    expect(getRetryDelaySeconds(undefined, "HTTP 500", 2, 3)).toBe(8);
  });
});

describe("findFailedTurn", () => {
  it("reports the last assistant turn when it errored", () => {
    expect(findFailedTurn([{ role: "user" }, erroredTurn()])).toMatchObject({
      message: RELACE_ERROR,
      thrown: false,
    });
  });

  it("ignores earlier errored turns once a later turn succeeded", () => {
    expect(
      findFailedTurn([
        { role: "user" },
        erroredTurn(),
        { role: "assistant", stopReason: "stop" },
      ])
    ).toBeUndefined();
  });

  it("falls back to a generic message when none was reported", () => {
    expect(
      findFailedTurn([{ role: "assistant", stopReason: "error" }])?.message
    ).toBe("unknown error");
  });
});

describe("resumeAfterFailedTurn", () => {
  it("drops the failed turn and continues without re-sending the prompt", async () => {
    const reprompt = vi.fn(async () => undefined);
    const session = {
      agent: {
        state: {
          messages: [
            { role: "user" },
            { role: "assistant", stopReason: "tool_calls" },
            { role: "tool" },
            erroredTurn(),
          ] as RetryableTurnMessage[],
        },
        continue: vi.fn(async () => undefined),
      },
    };

    await resumeAfterFailedTurn(session, reprompt);

    expect(session.agent.state.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(session.agent.continue).toHaveBeenCalledTimes(1);
    expect(reprompt).not.toHaveBeenCalled();
  });

  it("re-prompts when dropping the failed turn empties the context", async () => {
    const reprompt = vi.fn(async () => undefined);
    const session = {
      agent: {
        state: { messages: [erroredTurn()] as RetryableTurnMessage[] },
        continue: vi.fn(async () => undefined),
      },
    };

    await resumeAfterFailedTurn(session, reprompt);

    expect(reprompt).toHaveBeenCalledTimes(1);
    expect(session.agent.continue).not.toHaveBeenCalled();
  });
});

describe("runTurnWithProviderRetry", () => {
  function makeLoop(
    turns: Array<RetryableTurnMessage[] | Error>,
    overrides: Partial<Parameters<typeof runTurnWithProviderRetry>[0]> = {}
  ) {
    const attempts: number[] = [];
    const retries: Array<{ attempt: number; delaySeconds: number }> = [];
    const attemptDurations: number[] = [];
    const slept: number[] = [];
    let messages: RetryableTurnMessage[] = [];
    return {
      attempts,
      retries,
      attemptDurations,
      slept,
      run: () =>
        runTurnWithProviderRetry({
          maxAttempts: 3,
          baseDelaySeconds: 2,
          runTurn: async (attempt) => {
            attempts.push(attempt);
            const outcome = turns[attempt - 1];
            if (outcome instanceof Error) throw outcome;
            messages = outcome ?? [];
          },
          getMessages: () => messages,
          isAbort: () => false,
          onRetry: (attempt, delaySeconds) =>
            retries.push({ attempt, delaySeconds }),
          onAttempt: (_attempt, durationMs) => attemptDurations.push(durationMs),
          sleep: async (milliseconds) => {
            slept.push(milliseconds);
          },
          ...overrides,
        }),
    };
  }

  it("retries an errored turn until it succeeds", async () => {
    const loop = makeLoop([
      [erroredTurn()],
      [erroredTurn()],
      [{ role: "assistant", stopReason: "stop" }],
    ]);

    await loop.run();

    expect(loop.attempts).toEqual([1, 2, 3]);
    expect(loop.retries).toEqual([
      { attempt: 1, delaySeconds: 2 },
      { attempt: 2, delaySeconds: 2 },
    ]);
    expect(loop.slept).toEqual([2000, 2000]);
    expect(loop.attemptDurations).toHaveLength(3);
  });

  it("stops at maxAttempts and leaves the failed turn for the caller", async () => {
    const loop = makeLoop([[erroredTurn()], [erroredTurn()], [erroredTurn()]]);

    await loop.run();

    expect(loop.attempts).toEqual([1, 2, 3]);
    expect(loop.retries).toHaveLength(2);
  });

  it("does not retry a non-transient failure", async () => {
    const loop = makeLoop([[erroredTurn("Invalid request: mock fatal")]]);

    await loop.run();

    expect(loop.attempts).toEqual([1]);
    expect(loop.retries).toEqual([]);
  });

  it("rethrows a thrown non-transient failure", async () => {
    const loop = makeLoop([new Error("Invalid request: mock fatal")]);

    await expect(loop.run()).rejects.toThrow("Invalid request: mock fatal");
    expect(loop.retries).toEqual([]);
  });

  it("retries a thrown transient failure", async () => {
    const loop = makeLoop([
      new Error("HTTP 429 Too Many Requests"),
      [{ role: "assistant", stopReason: "stop" }],
    ]);

    await loop.run();

    expect(loop.attempts).toEqual([1, 2]);
    expect(loop.retries).toEqual([{ attempt: 1, delaySeconds: 2 }]);
  });

  it("never retries an aborted run", async () => {
    const loop = makeLoop([[erroredTurn()]], { isAbort: () => true });

    await loop.run();

    expect(loop.attempts).toEqual([1]);
    expect(loop.retries).toEqual([]);
  });
});
