import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { normalizeContext, type TranscriptContext, type Model, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { captureAnthropicRateLimits } from "@yoplai/shared";

const model: Model<"anthropic-messages"> = {
  id: "claude-test",
  name: "Invented Claude",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://anthropic.invalid",
  input: ["text"],
  reasoning: false,
  contextWindow: 8192,
  maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const quotaHeaders = {
  "anthropic-ratelimit-unified-5h-status": "rejected",
  "anthropic-ratelimit-unified-5h-utilization": "1",
  "anthropic-ratelimit-unified-5h-reset": "2000000000",
};

function rejectedFetch() {
  return vi.fn<typeof fetch>(async () => new Response(
    JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Invented quota rejection" } }),
    { status: 429, headers: { ...quotaHeaders, "content-type": "application/json", "retry-after": "0" } }
  ));
}

afterEach(() => vi.unstubAllGlobals());

describe("installed Pi Anthropic quota capture contract", () => {
  it("lets the real Agent loop replace streamFunction and deliver request options", async () => {
    const fetch = rejectedFetch();
    vi.stubGlobal("fetch", fetch);
    const streamFn = vi.fn<StreamFn>((requestModel, context, options) => streamAnthropic(
      requestModel as Model<"anthropic-messages">,
      context,
      { ...options, apiKey: "invented-test-token", maxRetries: 0 }
    ));
    const agent = new Agent({ initialState: { model }, streamFn, sessionId: "invented-session" });
    expect(typeof agent.streamFunction).toBe("function");
    const captured = vi.fn();
    captureAnthropicRateLimits(agent, captured);

    await expect(agent.prompt("test rejection")).resolves.toBeUndefined();

    expect(streamFn).toHaveBeenCalledWith(model, expect.any(Object), expect.objectContaining({
      sessionId: "invented-session", signal: expect.any(AbortSignal), fetch: expect.any(Function),
    }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(captured).toHaveBeenCalledWith(quotaHeaders);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant", stopReason: "error", errorMessage: expect.stringContaining("Invented quota rejection"),
    });
  });

  it("forwards fetch to the real Anthropic client on every retry and preserves its error event", async () => {
    const fetch = rejectedFetch();
    const streamFunction = (requestModel: typeof model, context: TranscriptContext, options?: { fetch?: typeof globalThis.fetch }) =>
      streamAnthropic(requestModel, context, { ...options, apiKey: "invented-test-token", maxRetries: 2 });
    const agent = { streamFunction };
    const baseline: AssistantMessageEvent[] = [];
    for await (const event of agent.streamFunction(model, normalizeContext({ messages: [] }), { fetch })) baseline.push(event);
    expect(fetch).toHaveBeenCalledTimes(3);
    fetch.mockClear();
    const captured = vi.fn();
    captureAnthropicRateLimits(agent, captured);
    const wrapped: AssistantMessageEvent[] = [];

    for await (const event of agent.streamFunction(model, normalizeContext({ messages: [] }), { fetch })) wrapped.push(event);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(captured).toHaveBeenCalledTimes(3);
    const before = baseline.at(-1);
    const after = wrapped.at(-1);
    expect(before).toMatchObject({ type: "error", reason: "error", error: { stopReason: "error" } });
    expect(after).toMatchObject({ type: "error", reason: "error", error: { stopReason: "error" } });
    if (before?.type !== "error" || after?.type !== "error") throw new Error("Pi lost its provider error event");
    expect(after.error.errorMessage).toBe(before.error.errorMessage);
    expect(after.error.errorMessage).toContain("Invented quota rejection");
    expect(JSON.stringify(after)).not.toContain("invented-test-token");
    expect(JSON.stringify(after)).not.toContain("2000000000");
  });
});
