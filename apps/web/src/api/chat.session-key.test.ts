// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { getSessionKey, setSessionKey } from "./chat";

describe("getSessionKey after the aihub -> yoplai rename", () => {
  beforeEach(() => {
    localStorage.clear();
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
});
