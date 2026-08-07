// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionKey, postCompact, setSessionKey } from "./chat";

describe("getSessionKey after the aihub -> yoplai rename", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a conversation that was stored under the legacy key", () => {
    localStorage.setItem("aihub:sessionKey:lead", "feature-branch");

    expect(getSessionKey("lead")).toBe("feature-branch");
    expect(localStorage.getItem("yoplai:sessionKey:lead")).toBe(
      "feature-branch"
    );
    // Second read no longer depends on the legacy key.
    expect(getSessionKey("lead")).toBe("feature-branch");
  });

  it("migrates per-agent keys independently", () => {
    localStorage.setItem("aihub:sessionKey:lead", "lead-session");
    localStorage.setItem("aihub:sessionKey:reviewer", "reviewer-session");

    expect(getSessionKey("lead")).toBe("lead-session");
    expect(getSessionKey("reviewer")).toBe("reviewer-session");
    expect(getSessionKey("unknown-agent")).toBe("main");
  });

  it("prefers a session key already written under the new name", () => {
    setSessionKey("lead", "current-session");
    localStorage.setItem("aihub:sessionKey:lead", "stale-session");

    expect(getSessionKey("lead")).toBe("current-session");
  });

  it("falls back to the default session with nothing stored", () => {
    expect(getSessionKey("lead")).toBe("main");
  });

  it("times out a stalled compaction request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            );
          })
      )
    );

    const request = postCompact("lead", "main");
    const timeoutError = expect(request).rejects.toThrow(
      "Compaction timed out. Try again."
    );
    await vi.advanceTimersByTimeAsync(60_000);

    await timeoutError;
  });
});
