import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FullHistoryMessage } from "@yoplai/shared";

const isStreaming = vi.fn(() => false);
const getAgent = vi.fn();
const getFullSessionHistory = vi.fn();
const runAgent = vi.fn();
const appendCanonicalCompaction = vi.fn();
const getSessionCreatedAt = vi.fn();
const resolveSessionDataFile = vi.fn();
const mkdir = vi.fn(async () => undefined);
const writeFile = vi.fn(async () => undefined);
const rename = vi.fn(async () => undefined);
const readFile = vi.fn(async () => "original runtime bytes\n");
const unlink = vi.fn(async () => undefined);

vi.mock("../config/index.js", () => ({
  CONFIG_DIR: "/tmp/yoplai-test",
  getAgent,
  getDefaultSdkId: () => "pi",
}));

vi.mock("../sdk/registry.js", () => ({ getDefaultSdkId: () => "pi" }));
vi.mock("./sessions.js", () => ({ isStreaming }));

vi.mock("./runner.js", () => ({
  getFullSessionHistory,
  runAgent,
}));

vi.mock("../history/store.js", () => ({
  appendCanonicalCompaction,
}));

vi.mock("../sessions/store.js", () => ({
  getSessionCreatedAt,
}));

vi.mock("../sessions/files.js", () => ({
  resolveSessionDataFile,
}));

vi.mock("node:fs/promises", () => ({
  default: { mkdir, writeFile, rename, readFile, unlink },
  mkdir,
  writeFile,
  rename,
  readFile,
  unlink,
}));

function historyMessages(): FullHistoryMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "hi there" }],
      timestamp: 2,
    },
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("compactAgentSession single-flight coordination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isStreaming.mockReturnValue(false);
    readFile.mockResolvedValue("original runtime bytes\n");
    getAgent.mockReturnValue({
      id: "alpha",
      model: { provider: "anthropic", model: "claude" },
    });
    getFullSessionHistory.mockResolvedValue(historyMessages());
    appendCanonicalCompaction.mockResolvedValue(undefined);
    getSessionCreatedAt.mockResolvedValue(123);
    resolveSessionDataFile.mockImplementation(
      async (params: { sessionId: string }) => `/tmp/${params.sessionId}.jsonl`
    );
  });

  it("coalesces concurrent requests for the same identity into one rewrite and one seed", async () => {
    const { compactAgentSession } = await import("./compact.js");

    const summary = deferred<{ payloads: { text: string }[] }>();
    runAgent.mockImplementation(() => summary.promise);

    const callArgs = { agentId: "alpha", sessionId: "s1", sessionKey: "main", userId: "u1" };
    const first = compactAgentSession(callArgs);
    const second = compactAgentSession(callArgs);

    // Give both callers a chance to observe the in-flight entry before resolving.
    await Promise.resolve();
    await Promise.resolve();

    summary.resolve({ payloads: [{ text: "the summary" }] });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(getFullSessionHistory).toHaveBeenCalledTimes(2);
    expect(appendCanonicalCompaction).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toEqual({
      sessionId: "s1",
      summary: "the summary",
      keptMessages: 2,
    });
  });

  it("compacts two different sessions independently and concurrently", async () => {
    const { compactAgentSession } = await import("./compact.js");

    const deferredBySession = new Map<string, ReturnType<typeof deferred<{ payloads: { text: string }[] }>>>();
    runAgent.mockImplementation((params: { sessionId: string }) => {
      const key = params.sessionId.includes(":s1:") ? "s1" : "s2";
      const entry = deferredBySession.get(key) ?? deferred<{ payloads: { text: string }[] }>();
      deferredBySession.set(key, entry);
      return entry.promise;
    });

    const runS1 = compactAgentSession({
      agentId: "alpha",
      sessionId: "s1",
      sessionKey: "main",
      userId: "u1",
    });
    const runS2 = compactAgentSession({
      agentId: "alpha",
      sessionId: "s2",
      sessionKey: "main",
      userId: "u1",
    });

    await Promise.resolve();
    await Promise.resolve();

    deferredBySession.get("s1")?.resolve({ payloads: [{ text: "summary one" }] });
    deferredBySession.get("s2")?.resolve({ payloads: [{ text: "summary two" }] });

    const [resultS1, resultS2] = await Promise.all([runS1, runS2]);

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(appendCanonicalCompaction).toHaveBeenCalledTimes(2);
    expect(resultS1.sessionId).toBe("s1");
    expect(resultS1.summary).toBe("summary one");
    expect(resultS2.sessionId).toBe("s2");
    expect(resultS2.summary).toBe("summary two");
  });

  it("clears the in-flight entry after completion so a later call runs fresh", async () => {
    const { compactAgentSession } = await import("./compact.js");

    runAgent.mockResolvedValue({ payloads: [{ text: "first pass" }] });
    const callArgs = { agentId: "alpha", sessionId: "s1", sessionKey: "main", userId: "u1" };

    await compactAgentSession(callArgs);

    runAgent.mockResolvedValue({ payloads: [{ text: "second pass" }] });
    const second = await compactAgentSession(callArgs);

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(second.summary).toBe("second pass");
  });

  it("times out a hung summary and permits a later successful compaction", async () => {
    const { compactAgentSession } = await import("./compact.js");
    vi.useFakeTimers();
    try {
      runAgent.mockImplementationOnce(() => new Promise(() => {}));
      const failed = expect(compactAgentSession({ agentId: "alpha", sessionId: "s1", sessionKey: "main" })).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(120_000);
      await failed;
      expect(writeFile).not.toHaveBeenCalled();
      expect(appendCanonicalCompaction).not.toHaveBeenCalled();
      runAgent.mockResolvedValueOnce({ payloads: [{ text: "retry" }] });
      await expect(compactAgentSession({ agentId: "alpha", sessionId: "s1", sessionKey: "main" })).resolves.toMatchObject({ summary: "retry" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unsupported harnesses without touching history or runtime", async () => {
    const { compactAgentSession } = await import("./compact.js");
    getAgent.mockReturnValue({ id: "alpha", sdk: "openclaw", model: { provider: "anthropic", model: "claude" } });
    await expect(compactAgentSession({ agentId: "alpha", sessionId: "s1", sessionKey: "main" })).rejects.toThrow("only for Pi");
    expect(getFullSessionHistory).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("leaves an empty session untouched", async () => {
    const { compactAgentSession } = await import("./compact.js");
    getFullSessionHistory.mockResolvedValue([]);
    await expect(compactAgentSession({ agentId: "alpha", sessionId: "s1", sessionKey: "main" })).resolves.toEqual({ sessionId: "s1", summary: "", keptMessages: 0 });
    expect(runAgent).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("rolls runtime activation back if appending the durable summary fails", async () => {
    const { compactAgentSession } = await import("./compact.js");
    runAgent.mockResolvedValue({ payloads: [{ text: "summary" }] });
    appendCanonicalCompaction.mockRejectedValueOnce(new Error("disk failure"));
    await expect(compactAgentSession({ agentId: "alpha", sessionId: "s1", sessionKey: "main" })).rejects.toThrow("disk failure");
    expect(writeFile).toHaveBeenLastCalledWith(expect.any(String), "original runtime bytes\n", "utf-8");
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it("leaves runtime and durable history unchanged if a new turn writes during summarization", async () => {
    const { compactAgentSession } = await import("./compact.js");
    getFullSessionHistory.mockResolvedValueOnce(historyMessages()).mockResolvedValueOnce([...historyMessages(), { role: "user", timestamp: 3, content: [{ type: "text", text: "new turn" }] }]);
    runAgent.mockResolvedValue({ payloads: [{ text: "summary" }] });
    await expect(compactAgentSession({ agentId: "alpha", sessionId: "s1", sessionKey: "main" })).rejects.toThrow("Session changed");
    expect(writeFile).not.toHaveBeenCalled();
    expect(appendCanonicalCompaction).not.toHaveBeenCalled();
  });

  it("reuses the durable summary when retrying without new conversation messages", async () => {
    const { compactAgentSession } = await import("./compact.js");
    getFullSessionHistory.mockResolvedValue([...historyMessages(), { role: "system", timestamp: 3, content: [{ type: "text", text: "[COMPACTED CONTEXT SUMMARY]\nexisting" }], compaction: { id: "c1", coveredThrough: 2 } }]);
    const result = await compactAgentSession({ agentId: "alpha", sessionId: "s1", sessionKey: "main" });
    expect(result.summary).toBe("existing");
    expect(runAgent).not.toHaveBeenCalled();
    expect(appendCanonicalCompaction).not.toHaveBeenCalled();
  });

  it("resolves user-scoped host Pi runtime files", async () => {
    const { compactAgentSession } = await import("./compact.js");
    runAgent.mockResolvedValue({ payloads: [{ text: "summary" }] });
    await compactAgentSession({ agentId: "alpha", sessionId: "s1", sessionKey: "main", userId: "u1" });
    expect(resolveSessionDataFile).toHaveBeenCalledWith(expect.objectContaining({ dir: "/tmp/yoplai-test/sessions/users/u1/sessions" }));
    expect(getSessionCreatedAt).toHaveBeenCalledWith("s1", "u1");
  });

  it("uses the sandbox runner's actual legacy runtime filename", async () => {
    const { compactAgentSession } = await import("./compact.js");
    getAgent.mockReturnValue({ id: "alpha", sandbox: { enabled: true }, model: { provider: "anthropic", model: "claude" } });
    runAgent.mockResolvedValue({ payloads: [{ text: "summary" }] });
    await compactAgentSession({ agentId: "alpha", sessionId: "s1", sessionKey: "main" });
    expect(rename).toHaveBeenCalledWith(expect.any(String), "/tmp/yoplai-test/sessions/alpha/s1.jsonl");
  });

  it("clears the in-flight entry after a failure so the session is not wedged", async () => {
    const { compactAgentSession } = await import("./compact.js");
    const callArgs = { agentId: "alpha", sessionId: "s1", sessionKey: "main", userId: "u1" };

    // An empty summarization throws; the in-flight entry must not survive it,
    // or every later compaction of this session would replay the rejection.
    runAgent.mockResolvedValueOnce({ payloads: [] });
    await expect(compactAgentSession(callArgs)).rejects.toThrow();

    runAgent.mockResolvedValueOnce({ payloads: [{ text: "recovered" }] });
    const retry = await compactAgentSession(callArgs);

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(retry.summary).toBe("recovered");
  });
});

describe("compact agent session helpers", () => {
  it("strips assistant usage metadata before seeding retained messages", async () => {
    const { compactAssistantMeta } = await import("./compact.js");
    expect(
      compactAssistantMeta({
        model: "gpt-5.2",
        provider: "openai",
        api: "responses",
        stopReason: "stop",
        usage: {
          input: 120000,
          output: 10,
          cacheRead: 5000,
          cacheWrite: 0,
          totalTokens: 125010,
        },
      })
    ).toEqual({
      model: "gpt-5.2",
      provider: "openai",
      api: "responses",
      stopReason: "stop",
    });
  });

  it("redacts sensitive values before reseeding the Pi session", async () => {
    const { compactAgentSession } = await import("./compact.js");
    const canary = "pi-session-canary";
    getFullSessionHistory.mockResolvedValue([
      {
        role: "user",
        content: [{ type: "text", text: `Authorization: Bearer ${canary}` }],
        timestamp: 1,
      },
    ]);
    runAgent.mockResolvedValue({
      payloads: [{ text: `summary with token=${canary}` }],
    });

    await compactAgentSession({
      agentId: "alpha",
      sessionId: "s1",
      sessionKey: "main",
      userId: "u1",
    });

    const stored =
      (writeFile.mock.calls.at(-1) as unknown as [string, string] | undefined)
        ?.at(1) ?? "";
    expect(stored).not.toContain(canary);
    expect(stored).toContain("Authorization: [REDACTED]");
  });

  it("replaces retained file blocks with text so providers never get dataless images", async () => {
    const { compactAgentSession } = await import("./compact.js");
    getFullSessionHistory.mockResolvedValue([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "file",
            fileId: "f1",
            filename: "shot.png",
            mimeType: "image/png",
            size: 10,
            direction: "inbound",
          },
        ],
        timestamp: 1,
      },
    ]);
    runAgent.mockResolvedValue({ payloads: [{ text: "summary" }] });

    await compactAgentSession({
      agentId: "alpha",
      sessionId: "s1",
      sessionKey: "main",
      userId: "u1",
    });

    const stored =
      (writeFile.mock.calls.at(-1) as unknown as [string, string] | undefined)
        ?.at(1) ?? "";
    const user = stored
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.message?.role === "user")
      .at(-1);
    expect(user.message.content).toEqual([
      { type: "text", text: "look" },
      { type: "text", text: expect.stringContaining("shot.png") },
    ]);
    const canonical = appendCanonicalCompaction.mock.calls.at(-1)?.[0];
    expect(canonical.recentMessages[0].content[1].type).toBe("file");
  });

  it("seeds retained assistant messages with zeroed usage so Pi can read it", async () => {
    const { compactAgentSession } = await import("./compact.js");
    getFullSessionHistory.mockResolvedValue([
      { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        timestamp: 2,
        meta: {
          provider: "anthropic",
          model: "claude",
          stopReason: "stop",
          usage: { input: 120000, output: 10, totalTokens: 120010 },
        },
      },
    ]);
    runAgent.mockResolvedValue({ payloads: [{ text: "summary" }] });

    await compactAgentSession({
      agentId: "alpha",
      sessionId: "s1",
      sessionKey: "main",
      userId: "u1",
    });

    const stored =
      (writeFile.mock.calls.at(-1) as unknown as [string, string] | undefined)
        ?.at(1) ?? "";
    const assistant = stored
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((entry) => entry.message?.role === "assistant");
    expect(assistant.message.usage).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    });
  });
});
