import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: {
      ...actual,
      readFile: vi.fn().mockResolvedValue("{}"),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
    },
  };
});

// Mock config to avoid loading real config
vi.mock("../config/index.js", () => ({
  CONFIG_DIR: "/tmp/yoplai-test",
  loadConfig: () => ({ agents: [], sessions: {} }),
}));

describe("restoreSessionUpdatedAt", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("is a no-op when originalUpdatedAt is undefined", async () => {
    const { restoreSessionUpdatedAt } = await import("./store.js");
    const fsMock = vi.mocked(fs);

    // Should not throw
    await restoreSessionUpdatedAt("test-agent", "main", undefined);

    // Should not save (no writes)
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("is a no-op when session entry does not exist", async () => {
    const { restoreSessionUpdatedAt } = await import("./store.js");
    const fsMock = vi.mocked(fs);

    // Session doesn't exist yet - should not throw
    await restoreSessionUpdatedAt("nonexistent-agent", "main", 1000);

    // Save is not called because entry doesn't exist
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("restores updatedAt when session entry exists", async () => {
    // Mock store with existing entry
    const originalUpdatedAt = 1000;
    const newUpdatedAt = 2000;
    const mockStore = {
      "test-agent:main": {
        sessionId: "test-session-id",
        updatedAt: newUpdatedAt,
        createdAt: originalUpdatedAt,
      },
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockStore));

    const { restoreSessionUpdatedAt, getSessionEntry } = await import("./store.js");

    // Restore to original value
    await restoreSessionUpdatedAt("test-agent", "main", originalUpdatedAt);

    // Verify entry was updated in memory
    const entry = await getSessionEntry("test-agent", "main");
    expect(entry?.updatedAt).toBe(originalUpdatedAt);

    // Verify save was called
    expect(vi.mocked(fs.writeFile)).toHaveBeenCalled();
  });

  it("does not modify sessionId when restoring updatedAt", async () => {
    const originalSessionId = "original-session-id";
    const mockStore = {
      "test-agent:main": {
        sessionId: originalSessionId,
        updatedAt: 2000,
        createdAt: 1000,
      },
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockStore));

    const { restoreSessionUpdatedAt, getSessionEntry } = await import("./store.js");

    await restoreSessionUpdatedAt("test-agent", "main", 1000);

    const entry = await getSessionEntry("test-agent", "main");
    expect(entry?.sessionId).toBe(originalSessionId);
  });
});

describe("getSessionEntry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns undefined for non-existent entry", async () => {
    vi.mocked(fs.readFile).mockResolvedValue("{}");

    const { getSessionEntry } = await import("./store.js");
    const entry = await getSessionEntry("nonexistent", "main");

    expect(entry).toBeUndefined();
  });

  it("returns entry when it exists", async () => {
    const mockStore = {
      "test-agent:main": {
        sessionId: "test-session",
        updatedAt: 1000,
        createdAt: 500,
      },
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockStore));

    const { getSessionEntry } = await import("./store.js");
    const entry = await getSessionEntry("test-agent", "main");

    expect(entry).toEqual({
      sessionId: "test-session",
      updatedAt: 1000,
      createdAt: 500,
    });
  });
});

describe("session id format", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("generates UUIDv7 session ids that sort by creation time", async () => {
    const { resolveSessionId } = await import("./store.js");

    const first = await resolveSessionId({
      agentId: "agent-a",
      sessionKey: "main",
      message: "hello",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await resolveSessionId({
      agentId: "agent-b",
      sessionKey: "main",
      message: "hello",
    });

    const uuidv7Re =
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(first.sessionId).toMatch(uuidv7Re);
    expect(second.sessionId).toMatch(uuidv7Re);
    expect(first.sessionId < second.sessionId).toBe(true);
  });
});

describe("session store isolation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("keeps single-user sessions in the root store", async () => {
    const { resolveSessionId } = await import("./store.js");

    await resolveSessionId({
      agentId: "test-agent",
      sessionKey: "main",
      message: "hello",
    });

    expect(vi.mocked(fs.rename)).toHaveBeenCalledWith(
      expect.stringContaining("/tmp/yoplai-test/sessions.json."),
      "/tmp/yoplai-test/sessions.json"
    );
  });

  it("writes multi-user sessions into the user store", async () => {
    const { resolveSessionId } = await import("./store.js");

    await resolveSessionId({
      agentId: "test-agent",
      userId: "user-123",
      sessionKey: "main",
      message: "hello",
    });

    expect(vi.mocked(fs.rename)).toHaveBeenCalledWith(
      expect.stringContaining(
        "/tmp/yoplai-test/sessions/users/user-123/sessions.json."
      ),
      "/tmp/yoplai-test/sessions/users/user-123/sessions.json"
    );
  });

  it("uses unique temp files for concurrent saves", async () => {
    let releaseWrites: (() => void) | undefined;
    const writesStarted = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    let blocked = true;
    vi.mocked(fs.writeFile).mockImplementation(async () => {
      if (blocked) {
        await writesStarted;
      }
    });

    const { resolveSessionId } = await import("./store.js");

    const first = resolveSessionId({
      agentId: "test-agent",
      sessionKey: "main",
      message: "hello",
    });
    const second = resolveSessionId({
      agentId: "test-agent",
      sessionKey: "other",
      message: "hello",
    });

    while (vi.mocked(fs.writeFile).mock.calls.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    blocked = false;
    releaseWrites?.();
    await Promise.all([first, second]);

    const tempFiles = vi
      .mocked(fs.writeFile)
      .mock.calls.map(([file]) => String(file));
    expect(new Set(tempFiles).size).toBe(tempFiles.length);
  });
});
