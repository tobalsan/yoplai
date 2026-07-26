// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readMigratedLocal } from "./local-storage";

// Every renamed key that persists browser state, with the legacy spelling it
// must adopt on upgrade. Parameterised keys are listed with a concrete id.
const RENAMED_KEYS: Array<[newKey: string, legacyKey: string]> = [
  ["yoplai-theme", "aihub-theme"],
  ["yoplai:quick-chat-last-agent", "aihub:quick-chat-last-agent"],
  ["yoplai:context-panel:mode", "aihub:context-panel:mode"],
  ["yoplai:context-panel:selected-agent", "aihub:context-panel:selected-agent"],
  ["yoplai:recent-project-views", "aihub:recent-project-views"],
  ["yoplai:board:selected-agent", "aihub:board:selected-agent"],
  ["yoplai:projects:expanded-columns", "aihub:projects:expanded-columns"],
  ["yoplai:projects:create-form", "aihub:projects:create-form"],
  ["yoplai:projects:delete-success", "aihub:projects:delete-success"],
  ["yoplai:sidebar-collapsed", "aihub:sidebar-collapsed"],
  ["yoplai:right-panel-collapsed", "aihub:right-panel-collapsed"],
  ["yoplai:zen-mode", "aihub:zen-mode"],
  ["yoplai:sessionKey:agent-1", "aihub:sessionKey:agent-1"],
  ["yoplai:project:PRO-1:center-view", "aihub:project:PRO-1:center-view"],
];

describe("readMigratedLocal", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it.each(RENAMED_KEYS)(
    "adopts the legacy value of %s",
    (newKey, legacyKey) => {
      localStorage.setItem(legacyKey, "stored-value");

      expect(readMigratedLocal(newKey)).toBe("stored-value");
      expect(localStorage.getItem(newKey)).toBe("stored-value");
      expect(localStorage.getItem(legacyKey)).toBeNull();
    }
  );

  it.each(RENAMED_KEYS)(
    "never clobbers an existing value of %s",
    (newKey, legacyKey) => {
      localStorage.setItem(newKey, "current");
      localStorage.setItem(legacyKey, "legacy");

      expect(readMigratedLocal(newKey)).toBe("current");
      expect(localStorage.getItem(newKey)).toBe("current");
    }
  );

  it("keeps parameterised keys scoped to their own id", () => {
    localStorage.setItem("aihub:sessionKey:agent-a", "session-a");
    localStorage.setItem(
      "aihub:project:PRO-2:center-view",
      '{"tab":"changes"}'
    );

    expect(readMigratedLocal("yoplai:sessionKey:agent-b")).toBeNull();
    expect(readMigratedLocal("yoplai:project:PRO-1:center-view")).toBeNull();
    expect(readMigratedLocal("yoplai:sessionKey:agent-a")).toBe("session-a");
    expect(readMigratedLocal("yoplai:project:PRO-2:center-view")).toBe(
      '{"tab":"changes"}'
    );
  });

  it("preserves an empty string stored under the new key", () => {
    localStorage.setItem("yoplai:context-panel:mode", "");
    localStorage.setItem("aihub:context-panel:mode", "agents");

    expect(readMigratedLocal("yoplai:context-panel:mode")).toBe("");
  });

  it("stays inert without a browser window", () => {
    localStorage.setItem("aihub:zen-mode", "true");
    vi.stubGlobal("window", undefined);
    try {
      expect(readMigratedLocal("yoplai:zen-mode")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(localStorage.getItem("yoplai:zen-mode")).toBeNull();
  });

  it("returns null for an unbranded key with no legacy spelling", () => {
    expect(readMigratedLocal("lead-session:lastViewed:PRO-1")).toBeNull();
    localStorage.setItem("lead-session:lastViewed:PRO-1", "S01");
    expect(readMigratedLocal("lead-session:lastViewed:PRO-1")).toBe("S01");
  });
});
