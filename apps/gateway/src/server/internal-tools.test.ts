import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import {
  registerContainerToken,
  removeContainerToken,
} from "../sdk/container/tokens.js";
import { createInternalTools } from "./internal-tools.js";

const registeredTokens: string[] = [];

function registerToken(
  token: string,
  agentId = "agent-1",
  roots = { workspace: "/tmp/workspace", data: "/tmp/data", uploads: "/tmp/uploads" },
  emitProgress?: (event: { label: string; taskId?: string }) => void
): void {
  registerContainerToken(token, {
    agentId,
    sessionId: "session-1",
    runId: "run-1",
    containerName: "container-1",
    roots,
    emitProgress,
  });
  registeredTokens.push(token);
}

function textPdf(text: string): Buffer {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
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
  it("forwards task checkpoint progress to the owning container run", async () => {
    const { app, executeExtensionTool } = createDeps();
    const emitProgress = vi.fn();
    registerToken("token-1", "agent-1", undefined, emitProgress);

    executeExtensionTool.mockImplementationOnce(async (...args) => {
      args[7]?.({ label: "Checkpoint saved.", taskId: "task-1" });
      return { found: true, result: {} };
    });
    const response = await postTool(app, {
      tool: "task.checkpoint",
      args: { checkpoint: "Saved safely" },
      agentId: "agent-1",
      agentToken: "token-1",
      sessionId: "session-1",
    });

    expect(response.status).toBe(200);
    expect(emitProgress).toHaveBeenCalledWith({
      label: "Checkpoint saved.",
      taskId: "task-1",
    });
  });

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
      "session-1"
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

  it("derives session context from the token and rejects caller mismatches", async () => {
    const { app, executeExtensionTool } = createDeps();
    registerToken("token-context");

    const response = await postTool(app, {
      tool: "project.get",
      args: { projectId: "PRO-1" },
      agentId: "agent-1",
      agentToken: "token-context",
      sessionId: "another-session",
      runId: "run-1",
    });

    expect(response.status).toBe(403);
    expect(executeExtensionTool).not.toHaveBeenCalled();
  });

  it.each([
    ["runId", "another-run"],
    ["containerName", "another-container"],
    ["agentId", ""],
    ["sessionId", ""],
    ["runId", ""],
    ["containerName", ""],
  ])("rejects a mismatched %s", async (field, value) => {
    const { app, executeExtensionTool } = createDeps();
    registerToken("token-identity");
    const response = await postTool(app, {
      tool: "project.get", args: { projectId: "PRO-1" }, agentId: "agent-1", agentToken: "token-identity", [field]: value,
    });
    expect(response.status).toBe(403);
    expect(executeExtensionTool).not.toHaveBeenCalled();
  });

  it("rejects a token after cleanup", async () => {
    const { app, executeExtensionTool } = createDeps();
    registerToken("token-expired");
    removeContainerToken("token-expired");

    const response = await postTool(app, {
      tool: "project.get",
      args: { projectId: "PRO-1" },
      agentId: "agent-1",
      agentToken: "token-expired",
    });

    expect(response.status).toBe(403);
    expect(executeExtensionTool).not.toHaveBeenCalled();
  });

  it("rejects extract_document paths outside the container roots", async () => {
    const { app } = createDeps();
    registerToken("token-path");

    const response = await postTool(app, {
      tool: "extract_document",
      args: { path: "/etc/report.pdf" },
      agentId: "agent-1",
      agentToken: "token-path",
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Document path is outside approved container roots" });
  });

  it("rejects traversal under an approved container root", async () => {
    const { app } = createDeps();
    registerToken("token-traversal");
    const response = await postTool(app, {
      tool: "extract_document", args: { path: "/workspace/../report.pdf" }, agentId: "agent-1", agentToken: "token-traversal",
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Document path traversal is not allowed" });
  });

  it("rejects an approved-root path that resolves through a symlink", async () => {
    const { app } = createDeps();
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-workspace-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-outside-"));
    await fs.writeFile(path.join(outside, "report.pdf"), textPdf("outside workspace document with sufficient text-layer content"));
    await fs.symlink(path.join(outside, "report.pdf"), path.join(workspace, "report.pdf"));
    registerToken("token-symlink", "agent-1", {
      workspace,
      data: path.join(workspace, "data"),
      uploads: path.join(workspace, "uploads"),
    });

    try {
      const response = await postTool(app, {
        tool: "extract_document",
        args: { path: "/workspace/report.pdf" },
        agentId: "agent-1",
        agentToken: "token-symlink",
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Document path is outside approved container roots" });
    } finally {
      await Promise.all([
        fs.rm(workspace, { recursive: true, force: true }),
        fs.rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("extracts a text-layer PDF from an approved workspace path", async () => {
    const { app } = createDeps();
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-workspace-"));
    const document = path.join(workspace, "report.pdf");
    const expectedText = "approved gateway document with sufficient text-layer content";
    await fs.writeFile(document, textPdf(expectedText));
    registerToken("token-document", "agent-1", {
      workspace,
      data: path.join(workspace, "data"),
      uploads: path.join(workspace, "uploads"),
    });

    try {
      const response = await postTool(app, {
        tool: "extract_document",
        args: { path: "/workspace/report.pdf" },
        agentId: "agent-1",
        agentToken: "token-document",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ text: expect.stringContaining(expectedText) });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
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
      "session-1"
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
      "session-1"
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
