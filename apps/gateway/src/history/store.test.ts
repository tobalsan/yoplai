import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: {
      ...actual,
      access: vi.fn().mockRejectedValue(new Error("missing")),
      appendFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockRejectedValue(new Error("missing")),
      readdir: vi.fn().mockRejectedValue(new Error("missing")),
    },
  };
});

vi.mock("../config/index.js", () => ({
  CONFIG_DIR: "/tmp/yoplai-test",
}));

vi.mock("../sessions/store.js", () => ({
  getSessionCreatedAt: vi.fn().mockResolvedValue(0),
}));

vi.mock("../sessions/files.js", () => ({
  resolveSessionDataFile: vi.fn(
    async ({ dir, agentId, sessionId, createdAt }) =>
      `${dir}/${(createdAt ?? 0) ? "1970-01-01T00-00-00-000Z" : "1970-01-01T00-00-00-000Z"}_${agentId}-${sessionId}.jsonl`
  ),
  timestampedSessionFileName: vi.fn(
    () => "1970-01-01T00-00-00-000Z_agent-1-session-1.jsonl"
  ),
}));

describe("history store isolation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("keeps canonical history in the history dir by default", async () => {
    const { appendSessionMeta } = await import("./store.js");

    await appendSessionMeta("agent-1", "session-1", "thinkingLevel", "high");

    expect(vi.mocked(fs.appendFile)).toHaveBeenCalledWith(
      "/tmp/yoplai-test/history/1970-01-01T00-00-00-000Z_agent-1-session-1.jsonl",
      expect.any(String),
      "utf-8"
    );
  });

  it("routes canonical history into the user dir when userId is provided", async () => {
    const { appendSessionMeta } = await import("./store.js");

    await appendSessionMeta(
      "agent-1",
      "session-1",
      "thinkingLevel",
      "high",
      "user-123"
    );

    expect(vi.mocked(fs.appendFile)).toHaveBeenCalledWith(
      "/tmp/yoplai-test/sessions/users/user-123/history/1970-01-01T00-00-00-000Z_agent-1-session-1.jsonl",
      expect.any(String),
      "utf-8"
    );
  });

  it("redacts sensitive session metadata before persistence", async () => {
    const { appendSessionMeta } = await import("./store.js");
    const canary = "canary-private-value";

    await appendSessionMeta("agent-1", "session-1", "tool", {
      authorization: `Bearer ${canary}`,
      output: `https://files.example.test/report?X-Amz-Signature=${canary}`,
    });

    expect(String(vi.mocked(fs.appendFile).mock.calls[0]?.[1])).not.toContain(
      canary
    );
  });

  it("persists thinking timing and reads it back, including aborted turns", async () => {
    const store = await import("./store.js");
    for (const stopReason of ["stop", "aborted"]) {
      vi.mocked(fs.appendFile).mockClear();
      const buffer = store.createTurnBuffer();
      store.bufferHistoryEvent(buffer, {
        type: "assistant_thinking",
        text: "a",
        timestamp: 1000,
      });
      store.bufferHistoryEvent(buffer, {
        type: "assistant_thinking",
        text: "b",
        timestamp: 4000,
      });
      buffer.meta = { stopReason };
      await store.flushTurnBuffer("agent-1", "session-1", buffer);
      const written = vi
        .mocked(fs.appendFile)
        .mock.calls.map((c) => String(c[1]))
        .join("");
      vi.mocked(fs.readFile).mockResolvedValueOnce(written);
      const history = await store.getFullHistory("agent-1", "session-1");
      const assistant = history.find((m) => m.role === "assistant");
      expect(assistant?.content).toEqual([
        { type: "thinking", thinking: "ab", startedAt: 1000, endedAt: 4000 },
      ]);
    }
  });

  it("recognizes an empty title meta entry as an intentional title", async () => {
    const { hasSessionMeta } = await import("./store.js");
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      `${JSON.stringify({ type: "meta", key: "title", value: "", timestamp: 1 })}\n`
    );

    await expect(hasSessionMeta("agent-1", "session-1", "title")).resolves.toBe(true);
  });

  it("does not append an automatic title behind a concurrent manual rename", async () => {
    const { appendSessionMeta, appendSessionMetaIfAbsent } =
      await import("./store.js");
    let finishManual!: () => void;
    vi.mocked(fs.appendFile).mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishManual = resolve;
      })
    );
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      `${JSON.stringify({ type: "meta", key: "title", value: "Manual", timestamp: 1 })}\n`
    );

    const manual = appendSessionMeta("agent-1", "session-race", "title", "Manual");
    await vi.waitFor(() => expect(finishManual).toBeTypeOf("function"));
    const automatic = appendSessionMetaIfAbsent(
      "agent-1",
      "session-race",
      "title",
      "Automatic"
    );
    finishManual();

    await expect(manual).resolves.toBeUndefined();
    await expect(automatic).resolves.toBe(false);
    expect(fs.appendFile).toHaveBeenCalledTimes(1);
  });

  it("caches resolved history files until invalidated", async () => {
    const { resolveSessionDataFile } = await import("../sessions/files.js");
    const { appendSessionMeta, invalidateResolvedHistoryFile } =
      await import("./store.js");

    await appendSessionMeta("agent-1", "session-1", "thinkingLevel", "high");
    await appendSessionMeta("agent-1", "session-1", "thinkingLevel", "medium");
    expect(vi.mocked(resolveSessionDataFile)).toHaveBeenCalledTimes(1);

    invalidateResolvedHistoryFile("agent-1", "session-1");
    await appendSessionMeta("agent-1", "session-1", "thinkingLevel", "low");
    expect(vi.mocked(resolveSessionDataFile)).toHaveBeenCalledTimes(2);
  });
});
