import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveSessionId = vi.fn();
const isAbortTrigger = vi.fn();
const invalidateResolvedHistoryFile = vi.fn();
const normalizeInboundAttachments = vi.fn();

vi.mock("../sessions/index.js", () => ({
  resolveSessionId,
  isAbortTrigger,
}));

vi.mock("../history/store.js", () => ({
  invalidateResolvedHistoryFile,
}));

vi.mock("../sdk/attachments.js", () => ({
  normalizeInboundAttachments,
}));

const extensionRuntime = {} as never;
const agent = {
  id: "alpha",
  name: "Alpha",
  workspace: "/tmp/alpha",
  queueMode: "queue" as const,
  model: { provider: "anthropic", model: "claude" },
};

describe("normalizeRunRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAbortTrigger.mockReturnValue(false);
    normalizeInboundAttachments.mockImplementation(
      async (attachments) => attachments
    );
    resolveSessionId.mockResolvedValue({
      sessionId: "session-1",
      message: "hello",
      isNew: false,
      createdAt: 1,
    });
  });

  it("carries a project into a new session run", async () => {
    const { normalizeRunRequest } = await import("./run-request.js");
    const result = await normalizeRunRequest({
      agent, input: { agentId: "alpha", message: "hello", projectId: "research" },
      authContext: null, extensionRuntime, source: "web",
    });
    expect(result).toMatchObject({ type: "run", params: { projectId: "research" } });
  });

  it("carries the device turn token of a chat message into the run", async () => {
    const { normalizeRunRequest } = await import("./run-request.js");
    const input = { agentId: "alpha", message: "hello" };
    const withToken = await normalizeRunRequest({
      agent, input: { ...input, deviceTurnToken: "token-1" }, authContext: null, extensionRuntime, source: "web",
    });
    expect(withToken).toMatchObject({ type: "run", params: { deviceTurnToken: "token-1" } });
    const without = await normalizeRunRequest({ agent, input, authContext: null, extensionRuntime, source: "web" });
    expect(without).toMatchObject({ type: "run", params: { deviceTurnToken: undefined } });
  });

  it("rejects unsafe explicit session ids", async () => {
    const { normalizeRunRequest } = await import("./run-request.js");

    const result = await normalizeRunRequest({
      agent,
      input: { agentId: "alpha", message: "hello", sessionId: "foo:..:bar" },
      authContext: null,
      extensionRuntime,
      source: "web",
    });

    expect(result).toEqual({
      type: "validation_error",
      message: "Invalid session id",
    });
    expect(resolveSessionId).not.toHaveBeenCalled();
  });

  it("resolves keyed sessions once and returns runAgent params", async () => {
    const { normalizeRunRequest } = await import("./run-request.js");

    const result = await normalizeRunRequest({
      agent,
      input: {
        agentId: "alpha",
        message: "/new hello",
        sessionKey: "main",
      },
      authContext: null,
      extensionRuntime,
      source: "web",
    });

    expect(result).toEqual({
      type: "run",
      params: expect.objectContaining({
        agentId: "alpha",
        message: "/new hello",
        sessionId: undefined,
        sessionKey: undefined,
        resolvedSession: {
          sessionId: "session-1",
          sessionKey: "main",
          message: "hello",
          isNew: false,
        },
      }),
    });
    expect(resolveSessionId).toHaveBeenCalledTimes(1);
  });

  it("defaults REST-like requests to the main session key upstream", async () => {
    const { normalizeRunRequest } = await import("./run-request.js");

    const result = await normalizeRunRequest({
      agent,
      input: { agentId: "alpha", message: "hello" },
      authContext: null,
      extensionRuntime,
      source: "web",
    });

    expect(result).toEqual({
      type: "run",
      params: expect.objectContaining({
        sessionId: undefined,
        sessionKey: undefined,
        resolvedSession: expect.objectContaining({
          sessionId: "session-1",
          sessionKey: "main",
        }),
      }),
    });
    expect(resolveSessionId).toHaveBeenCalledWith({
      agentId: "alpha",
      userId: undefined,
      sessionKey: "main",
      message: "hello",
    });
  });

  it("returns an immediate reset response for empty reset messages", async () => {
    resolveSessionId.mockResolvedValue({
      sessionId: "session-2",
      message: "",
      isNew: true,
      createdAt: 1,
    });
    const { normalizeRunRequest } = await import("./run-request.js");

    const result = await normalizeRunRequest({
      agent: { ...agent, introMessage: "Fresh start." },
      input: { agentId: "alpha", message: "/new", sessionKey: "main" },
      authContext: null,
      extensionRuntime,
      source: "web",
    });

    expect(result).toEqual({
      type: "immediate",
      events: [
        { type: "session_reset", sessionId: "session-2" },
        { type: "text", data: "Fresh start." },
        { type: "done", meta: { durationMs: 0 } },
      ],
      result: {
        payloads: [{ text: "Fresh start." }],
        meta: { durationMs: 0, sessionId: "session-2" },
      },
    });
    expect(invalidateResolvedHistoryFile).toHaveBeenCalledWith(
      "alpha",
      "session-2",
      undefined
    );
  });

  it("does not resolve abort requests", async () => {
    isAbortTrigger.mockReturnValue(true);
    const { normalizeRunRequest } = await import("./run-request.js");

    const result = await normalizeRunRequest({
      agent,
      input: { agentId: "alpha", message: "/abort", sessionKey: "main" },
      authContext: null,
      extensionRuntime,
      source: "web",
    });

    expect(result.type).toBe("run");
    expect(resolveSessionId).not.toHaveBeenCalled();
  });

  it("adds auth user id and user context", async () => {
    const { normalizeRunRequest } = await import("./run-request.js");

    const result = await normalizeRunRequest({
      agent,
      input: { agentId: "alpha", message: "hello" },
      authContext: {
        user: { name: "Thinh" },
        session: { userId: "user-1" },
      },
      extensionRuntime,
      source: "web",
    });

    expect(result).toEqual({
      type: "run",
      params: expect.objectContaining({
        userId: "user-1",
        context: { kind: "web", name: "Thinh" },
      }),
    });
  });
});
