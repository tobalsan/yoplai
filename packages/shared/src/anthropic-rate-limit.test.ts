import { afterEach, describe, expect, it, vi } from "vitest";
import { captureAnthropicRateLimits } from "./anthropic-rate-limit.js";

// ALG-626 Testing Decisions approved by Thinh's Groom: GO, 4915dc05.
// Exercises the public fetch seam; installed Pi forwarding is covered separately.
type Options = { fetch?: typeof fetch; signal?: AbortSignal; onResponse?: () => void };
function makeAgent() {
  return {
    streamFunction: (_model: { provider: string }, _context: unknown, options?: Options) =>
      (options?.fetch ?? globalThis.fetch)("https://vendor.invalid/messages", { signal: options?.signal }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Anthropic rate-limit capture", () => {
  it.each([200, 500, 429])("preserves status %s with caller fetch, options, and capture errors", async status => {
    const response = new Response("unread fixture", { status });
    const callerFetch = vi.fn<typeof fetch>().mockResolvedValue(response);
    const globalFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", globalFetch);
    const controller = new AbortController();
    const onResponse = () => undefined;
    let received: Options | undefined;
    const agent = { streamFunction: (_model: { provider: string }, _context: unknown, options?: Options) => {
      received = options;
      return options!.fetch!("https://vendor.invalid/messages", { signal: options?.signal });
    } };
    const capture = vi.fn(() => { throw new Error("fixture capture failure"); });
    captureAnthropicRateLimits(agent, capture);
    expect(await agent.streamFunction({ provider: "anthropic" }, {}, { fetch: callerFetch, signal: controller.signal, onResponse })).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(callerFetch).toHaveBeenCalledWith("https://vendor.invalid/messages", { signal: controller.signal });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(received?.signal).toBe(controller.signal);
    expect(received?.onResponse).toBe(onResponse);
    expect(capture.mock.calls).toEqual(status === 429 ? [[{}]] : []);
  });

  it("warns safely and continues when the stream function is unavailable", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const agent = {};
      expect(() => captureAnthropicRateLimits(agent, () => undefined)).not.toThrow();
      expect(warning.mock.calls).toEqual([["[model-quota] Pi streamFunction unavailable; 429 capture disabled"]]);
    } finally {
      warning.mockRestore();
    }
  });

  it("leaves other providers and their options untouched", async () => {
    const response = new Response("other provider", { status: 429 });
    const options = { fetch: vi.fn<typeof fetch>().mockResolvedValue(response) };
    let receivedOptions: Options | undefined;
    const agent = { streamFunction: (_model: { provider: string }, _context: unknown, incoming?: Options) => {
      receivedOptions = incoming;
      return incoming!.fetch!("https://vendor.invalid/messages");
    } };
    const capture = vi.fn();
    captureAnthropicRateLimits(agent, capture);
    expect(await agent.streamFunction({ provider: "openai" }, {}, options)).toBe(response);
    expect(receivedOptions).toBe(options);
    expect(capture).not.toHaveBeenCalled();
  });
  it("captures only unified headers while returning the original unread 429", async () => {
    const response = new Response("invented rate limit body", { status: 429, headers: {
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-utilization": "1",
      "anthropic-ratelimit-unified-5h-reset": "2000000000",
      authorization: "FAKE_TOKEN_626",
      "request-id": "FAKE_REQUEST_626",
    } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);
    const captured: Record<string, string>[] = [];
    const agent = makeAgent();
    captureAnthropicRateLimits(agent, headers => captured.push(headers));
    const result = await agent.streamFunction({ provider: "anthropic" }, {});
    expect(result).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(captured).toEqual([{
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-utilization": "1",
      "anthropic-ratelimit-unified-5h-reset": "2000000000",
    }]);
  });
});
