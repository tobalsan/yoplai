import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import {
  registerContainerToken,
  removeContainerToken,
} from "../sdk/container/tokens.js";
import { createInternalTools } from "./internal-tools.js";

const registeredTokens: string[] = [];

function registerToken(token: string, agentId = "agent-1"): void {
  registerContainerToken(token, agentId, "container-1");
  registeredTokens.push(token);
}

function createDeps(agentId = "agent-1") {
  const config = {
    agents: [
      {
        id: agentId,
        name: "Agent One",
        workspace: "/tmp/agent-1",
        queueMode: "queue",
        model: { model: "test" },
      },
    ],
    extensions: {},
  } as unknown as GatewayConfig;
  const executeExtensionTool = vi.fn().mockResolvedValue({
    found: true,
    result: { id: "PRO-1", title: "Project One" },
  });
  const runtime = {} as never;

  return {
    app: createInternalTools({
      getConfig: () => config,
      getRuntime: () => runtime,
      executeExtensionTool,
    }),
    executeExtensionTool,
    runtime,
  };
}

function postTool(
  app: ReturnType<typeof createInternalTools>,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Response> {
  return Promise.resolve(
    app.request("/tools", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Agent-Id": String(body.agentId),
        "X-Agent-Token": String(body.agentToken),
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );
}

afterEach(() => {
  for (const token of registeredTokens.splice(0)) {
    removeContainerToken(token);
  }
  vi.clearAllMocks();
});

describe("internal tools", () => {
  it("accepts a valid container token", async () => {
    const { app, executeExtensionTool, runtime } = createDeps();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerToken("token-1");

    const response = await postTool(app, {
      tool: "project.get",
      args: { projectId: "PRO-1" },
      agentId: "agent-1",
      agentToken: "token-1",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "PRO-1",
      title: "Project One",
    });
    expect(executeExtensionTool).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      "project.get",
      { projectId: "PRO-1" },
      expect.objectContaining({ agents: expect.any(Array), extensions: {} }),
      runtime,
      undefined
    );
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("sandbox image is likely stale")
    );
  });

  it("rejects an invalid token", async () => {
    const { app, executeExtensionTool } = createDeps();

    const response = await postTool(app, {
      tool: "project.get",
      args: { projectId: "PRO-1" },
      agentId: "agent-1",
      agentToken: "missing",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Invalid agent token" });
    expect(executeExtensionTool).not.toHaveBeenCalled();
  });

  it("rejects a token registered to another agent", async () => {
    const { app, executeExtensionTool } = createDeps();
    registerToken("token-2", "agent-2");

    const response = await postTool(app, {
      tool: "project.get",
      args: { projectId: "PRO-1" },
      agentId: "agent-1",
      agentToken: "token-2",
    });

    expect(response.status).toBe(403);
    expect(executeExtensionTool).not.toHaveBeenCalled();
  });

  it("dispatches tools through enabled extensions", async () => {
    const { app, executeExtensionTool, runtime } = createDeps();
    registerToken("token-3");

    const response = await postTool(app, {
      tool: "project.get",
      args: { projectId: "PRO-1" },
      agentId: "agent-1",
      agentToken: "token-3",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "PRO-1",
      title: "Project One",
    });
    expect(executeExtensionTool).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      "project.get",
      { projectId: "PRO-1" },
      expect.objectContaining({ agents: expect.any(Array), extensions: {} }),
      runtime,
      undefined
    );
  });

  it("dispatches enabled extension tools", async () => {
    const { app, executeExtensionTool, runtime } = createDeps();
    executeExtensionTool.mockResolvedValueOnce({
      found: true,
      result: { content: "hello" },
    });
    registerToken("token-6");

    const response = await postTool(app, {
      tool: "scratchpad.read",
      args: {},
      agentId: "agent-1",
      agentToken: "token-6",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ content: "hello" });
    expect(executeExtensionTool).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      "scratchpad.read",
      {},
      expect.objectContaining({ agents: expect.any(Array), extensions: {} }),
      runtime,
      undefined
    );
  });

  it("passes sessionId through to extension tool execution", async () => {
    const { app, executeExtensionTool, runtime } = createDeps("agent-3");
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerToken("token-7", "agent-3");

    const response = await postTool(app, {
      tool: "discord.create_forum_thread",
      args: { channel_id: "forum-1", title: "Title", body: "Body" },
      agentId: "agent-3",
      agentToken: "token-7",
      sessionId: "session-1",
    });

    expect(response.status).toBe(200);
    expect(executeExtensionTool).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-3" }),
      "discord.create_forum_thread",
      { channel_id: "forum-1", title: "Title", body: "Body" },
      expect.objectContaining({ agents: expect.any(Array), extensions: {} }),
      runtime,
      "session-1"
    );
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("warns about a missing sessionId only once per agent", async () => {
    const { app } = createDeps("agent-2");
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerToken("token-missing-session", "agent-2");

    const body = {
      tool: "project.get",
      args: { projectId: "PRO-1" },
      agentId: "agent-2",
      agentToken: "token-missing-session",
    };
    expect((await postTool(app, body)).status).toBe(200);
    expect((await postTool(app, body)).status).toBe(200);

    expect(consoleWarn).toHaveBeenCalledOnce();
  });

  it("returns 500 for tool execution errors", async () => {
    const { app, executeExtensionTool } = createDeps();
    const error = Object.assign(new Error("Project not found: PRO-1"), {
      status: 502,
      endpoint: "/api/v1/deals",
      requestId: "request-1",
      details: "x".repeat(600),
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    executeExtensionTool.mockRejectedValueOnce(error);
    registerToken("token-4");

    const response = await postTool(app, {
      tool: "project.get",
      args: { projectId: "PRO-1" },
      agentId: "agent-1",
      agentToken: "token-4",
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Project not found: PRO-1",
    });
    expect(consoleError).toHaveBeenCalledOnce();
    const line = consoleError.mock.calls[0]?.[0];
    expect(typeof line).toBe("string");
    expect(line).not.toContain("\n");
    expect(JSON.parse(line as string)).toMatchObject({
      level: "error",
      msg: "[internal-tools] tool execution failed",
      tool: "project.get",
      agentId: "agent-1",
      status: 502,
      endpoint: "/api/v1/deals",
      requestId: "request-1",
      message: "Project not found: PRO-1",
      stack: expect.any(String),
    });
    expect(JSON.parse(line as string).details).toHaveLength(501);
  });

  it("returns 400 for unknown tools", async () => {
    const { app, executeExtensionTool } = createDeps();
    executeExtensionTool.mockResolvedValueOnce({ found: false });
    registerToken("token-5");

    const response = await postTool(app, {
      tool: "unknown.tool",
      args: {},
      agentId: "agent-1",
      agentToken: "token-5",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Unknown tool: unknown.tool",
    });
  });
});
