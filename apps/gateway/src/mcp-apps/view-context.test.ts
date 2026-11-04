import { beforeEach, describe, expect, it, vi } from "vitest";

// Approved in ALG-600 comment 9de9b656: public in-memory store interface.
// Snapshots reveal selection/lifetime/caps, not RPC or model transport behavior.
describe("MCP App view context", () => {
  beforeEach(() => vi.resetModules());

  it("keeps only each view's latest context within its owner's session", async () => {
    const contexts = await import("./view-context.js");
    const scope = { agentId: "main", sessionId: "chat", ownerUserId: "alice" };
    contexts.set(scope, "boards\nui://board", "first");
    contexts.set(scope, "boards\nui://board", "selected card 17");
    expect(contexts.snapshot(scope)).toEqual([{ viewKey: "boards\nui://board", value: "selected card 17" }]);
    expect(contexts.snapshot({ ...scope, ownerUserId: "bob" })).toEqual([]);
    expect(contexts.snapshot({ ...scope, sessionId: "other" })).toEqual([]);
    expect(contexts.snapshot({ ...scope, agentId: "other" })).toEqual([]);
  });
  it("consumes the captured version once while preserving a later selection", async () => {
    const contexts = await import("./view-context.js");
    const scope = { agentId: "main", sessionId: "chat" };
    contexts.set(scope, "a\nui://one", "captured");
    contexts.set(scope, "b\nui://two", "unchanged");
    const captured = contexts.snapshot({ ...scope, ownerUserId: null });
    contexts.set(scope, "a\nui://one", "new selection");
    contexts.consume(captured);
    expect(contexts.snapshot(scope)).toEqual([{ viewKey: "a\nui://one", value: "new selection" }]);
    contexts.consume(captured);
    expect(contexts.snapshot(scope)).toEqual([{ viewKey: "a\nui://one", value: "new selection" }]);
    contexts.consume(contexts.snapshot(scope));
    expect(contexts.snapshot(scope)).toEqual([]);
  });
  it("clears one view or the whole normalized session without affecting other sessions", async () => {
    const contexts = await import("./view-context.js");
    const scope = { agentId: "main", sessionId: "chat" };
    contexts.set(scope, "a", "one");
    contexts.set(scope, "b", "two");
    contexts.set({ ...scope, sessionId: "other" }, "a", "other");
    contexts.clear({ ...scope, ownerUserId: null }, "a");
    expect(contexts.snapshot(scope)).toEqual([{ viewKey: "b", value: "two" }]);
    contexts.clearSession(scope);
    expect(contexts.snapshot(scope)).toEqual([]);
    expect(contexts.snapshot({ ...scope, sessionId: "other" })).toEqual([{ viewKey: "a", value: "other" }]);
  });
  it("evicts the least recently updated view above eight in one session", async () => {
    const contexts = await import("./view-context.js");
    const scope = { agentId: "main", sessionId: "chat" };
    for (let i = 0; i < 8; i++) contexts.set(scope, String(i), "selection");
    contexts.set(scope, "0", "refreshed");
    contexts.set(scope, "8", "new");
    expect(contexts.snapshot(scope).map((view) => view.viewKey)).toEqual(["2", "3", "4", "5", "6", "7", "0", "8"]);
  });
  it("bounds global storage at 1000 by update recency across sessions", async () => {
    const contexts = await import("./view-context.js");
    for (let i = 0; i < 1000; i++) contexts.set({ agentId: "main", sessionId: String(i) }, "view", "selection");
    contexts.set({ agentId: "main", sessionId: "0" }, "view", "refreshed");
    contexts.set({ agentId: "main", sessionId: "1000" }, "view", "new");
    expect(contexts.snapshot({ agentId: "main", sessionId: "1" })).toEqual([]);
    expect(contexts.snapshot({ agentId: "main", sessionId: "0" })).toEqual([{ viewKey: "view", value: "refreshed" }]);
    expect(contexts.snapshot({ agentId: "main", sessionId: "1000" })).toEqual([{ viewKey: "view", value: "new" }]);
  });
});
