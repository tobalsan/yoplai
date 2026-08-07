import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FullHistoryMessage } from "@yoplai/shared";

const getAgent = vi.fn();
const getFullSessionHistory = vi.fn();
const runAgent = vi.fn();
const replaceCanonicalHistoryWithCompaction = vi.fn();
const getSessionCreatedAt = vi.fn();
const resolveSessionDataFile = vi.fn();
const mkdir = vi.fn(async () => undefined);
const writeFile = vi.fn(async () => undefined);

vi.mock("../config/index.js", () => ({
  CONFIG_DIR: "/tmp/yoplai-test",
  getAgent,
}));

vi.mock("./runner.js", () => ({
  getFullSessionHistory,
  runAgent,
}));

vi.mock("../history/store.js", () => ({
  replaceCanonicalHistoryWithCompaction,
}));

vi.mock("../sessions/store.js", () => ({
  getSessionCreatedAt,
}));

vi.mock("../sessions/files.js", () => ({
  resolveSessionDataFile,
}));

vi.mock("node:fs/promises", () => ({
  default: { mkdir, writeFile },
  mkdir,
  writeFile,
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
    getAgent.mockReturnValue({
      id: "alpha",
      model: { provider: "anthropic", model: "claude" },
    });
    getFullSessionHistory.mockResolvedValue(historyMessages());
    replaceCanonicalHistoryWithCompaction.mockResolvedValue(undefined);
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
    expect(getFullSessionHistory).toHaveBeenCalledTimes(1);
    expect(replaceCanonicalHistoryWithCompaction).toHaveBeenCalledTimes(1);
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
    expect(replaceCanonicalHistoryWithCompaction).toHaveBeenCalledTimes(2);
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

    const stored = writeFile.mock.calls.at(-1)?.[1] as string;
    expect(stored).not.toContain(canary);
    expect(stored).toContain("Authorization: [REDACTED]");
  });
});
