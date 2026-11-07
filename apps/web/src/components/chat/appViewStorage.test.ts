// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { load, save } from "./appViewStorage";

describe("saved chat panel tabs", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("keeps ordered keys, dashboard frame metadata and the active key per agent and session", () => {
    save("maple", "morning", {
      tabs: [{ key: "notes" }, { key: "dashboard", frame: { id: "garden", title: "Garden" } }],
      active: "notes",
    });
    expect(load("maple", "morning")).toEqual({
      tabs: [{ key: "notes" }, { key: "dashboard", frame: { id: "garden", title: "Garden" } }],
      active: "notes",
    });
    expect(load("maple", "evening")).toBeUndefined();
    expect(load("birch", "morning")).toBeUndefined();
  });

  it("removes a chat's entry after its last tab closes without changing another chat", () => {
    save("maple", "morning", { tabs: [{ key: "notes" }] });
    save("maple", "evening", { tabs: [{ key: "sketch" }] });
    save("maple", "morning", { tabs: [] });
    expect(load("maple", "morning")).toBeUndefined();
    expect(sessionStorage.getItem("yoplai.chat-panel-tabs.v1:maple:morning")).toBeNull();
    expect(load("maple", "evening")).toEqual({ tabs: [{ key: "sketch" }] });
    save("maple", "evening", undefined);
    expect(load("maple", "evening")).toBeUndefined();
  });

  it("ignores malformed JSON and invalid stored shapes", () => {
    const key = "yoplai.chat-panel-tabs.v1:maple:morning";
    for (const value of ["{", "null", "[]", '{}', '{"tabs":{}}', '{"tabs":[null]}', '{"tabs":[{"key":9}]}', '{"tabs":[{"key":""}]}', '{"tabs":[{"key":"notes","frame":{"id":"garden"}}]}', '{"tabs":[],"active":5}']) {
      sessionStorage.setItem(key, value);
      expect(load("maple", "morning")).toBeUndefined();
    }
  });

  it("keeps storage access failures from breaking the chat", () => {
    vi.spyOn(Object.getPrototypeOf(sessionStorage), "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    expect(load("maple", "morning")).toBeUndefined();
    vi.spyOn(Object.getPrototypeOf(sessionStorage), "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
    expect(() => save("maple", "morning", { tabs: [{ key: "notes" }] })).not.toThrow();
    vi.spyOn(Object.getPrototypeOf(sessionStorage), "removeItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    expect(() => save("maple", "morning", undefined)).not.toThrow();
  });
});
