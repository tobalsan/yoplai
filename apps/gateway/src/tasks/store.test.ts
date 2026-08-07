import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";

vi.mock("../config/index.js", () => ({ CONFIG_DIR: "/tmp/yoplai-test" }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: {
      ...actual,
      readFile: vi.fn().mockResolvedValue("{}"),
      mkdir: vi.fn(),
      writeFile: vi.fn(),
      rename: vi.fn(),
    },
  };
});

describe("task ledger", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(fs.readFile).mockResolvedValue("{}");
  });
  it("persists checkpoints and recovers them after a store restart", async () => {
    const store = await import("./store.js");
    await store.adoptTask("agent", "session", "Task A", "user");
    await store.updateTask("agent", "session", "user", {
      checkpoint: "halfway",
    });
    const saved = vi.mocked(fs.writeFile).mock.calls.at(-1)?.[1] as string;
    store.resetTaskStoreForTests();
    vi.mocked(fs.readFile).mockResolvedValue(saved);
    expect(await store.getTask("agent", "session", "user")).toMatchObject({
      title: "Task A",
      checkpoint: "halfway",
      status: "active",
    });
    expect(fs.writeFile).toHaveBeenCalled();
  });
  it("preserves a paused task when unrelated work is adopted", async () => {
    const store = await import("./store.js");
    await store.adoptTask("agent", "session", "Task A");
    await expect(store.adoptTask("agent", "session", "Task B")).rejects.toThrow(
      "unfinished task"
    );
    await store.updateTask("agent", "session", undefined, {
      status: "paused",
      pauseReason: "unrelated work",
    });
    const taskB = await store.adoptTask("agent", "session", "Task B");
    expect(await store.getTasks("agent", "session")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Task A", status: "paused" }),
        expect.objectContaining({ id: taskB.id, status: "active" }),
      ])
    );
    await store.completeTask("agent", "session");
    await store.updateTask("agent", "session", undefined, {
      status: "active",
    });
    expect(await store.getTask("agent", "session")).toMatchObject({
      title: "Task A",
      status: "active",
    });
  });
  it("isolates agents, users, and sessions", async () => {
    const store = await import("./store.js");
    await store.adoptTask("agent-a", "session-a", "A", "user-a");
    expect(
      await store.getTask("agent-b", "session-a", "user-a")
    ).toBeUndefined();
    expect(
      await store.getTask("agent-a", "session-b", "user-a")
    ).toBeUndefined();
    expect(
      await store.getTask("agent-a", "session-a", "user-b")
    ).toBeUndefined();
  });
  it("does not overwrite a ledger when reading it fails", async () => {
    const store = await import("./store.js");
    const error = Object.assign(new Error("disk unavailable"), { code: "EIO" });
    vi.mocked(fs.readFile).mockRejectedValue(error);

    await expect(store.adoptTask("agent", "session", "Task A")).rejects.toThrow(
      "disk unavailable"
    );
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});
