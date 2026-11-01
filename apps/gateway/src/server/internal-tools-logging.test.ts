import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import fs from "node:fs/promises";
import { GatewayConfigSchema, type Extension } from "@yoplai/shared";
import { ExtensionRuntime } from "../extensions/runtime.js";
import { canvasExtension } from "../canvas/index.js";
import { sessionHistoryExtension } from "../session-history/index.js";
import { taskLifecycleExtension } from "../tasks/extension.js";
import { registerContainerToken, removeContainerToken } from "../sdk/container/tokens.js";
import { createInternalTools } from "./internal-tools.js";

const fixtureHome = vi.hoisted(() => {
  const home = `${process.cwd()}/.alg-522-tool-home`;
  vi.stubEnv("YOPLAI_HOME", home);
  return home;
});
const config = GatewayConfigSchema.parse({
  version: 2,
  agents: [{
    id: "agent-1", name: "Agent One", workspace: `${fixtureHome}/agent`,
    queueMode: "queue", model: { model: "test" },
  }],
  extensions: {},
});

function failingTools(execute: (args: unknown) => unknown): Extension {
  return {
    id: "failure-fixture", displayName: "Failure fixture", description: "Failure fixture",
    dependencies: [], configSchema: z.object({}), routePrefixes: [],
    validateConfig: () => ({ valid: true, errors: [] }),
    registerRoutes: () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    capabilities: () => [],
    getAgentTools: () => [{
      name: "fixture_failure", description: "Fail", parameters: {}, execute,
    }],
  };
}

async function requestFailure(
  extension: Extension,
  tool = "fixture_failure",
  args: unknown = {},
  overrides: Parameters<typeof createInternalTools>[0] = {}
) {
  const runtime = new ExtensionRuntime();
  runtime.load([extension]);
  registerContainerToken("alg-522-tool-fixture", {
    agentId: "agent-1", sessionId: "session-1", runId: "run-1", containerName: "fixture",
    roots: { workspace: `${fixtureHome}/agent`, data: `${fixtureHome}/data`, uploads: `${fixtureHome}/uploads` },
    conversationFiles: { hostPath: `${fixtureHome}/files`, runtimePath: "/workspace/files" },
  });
  const app = createInternalTools({ getConfig: () => config, getRuntime: () => runtime, ...overrides });
  return app.request("/tools", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Agent-Id": "agent-1", "X-Agent-Token": "alg-522-tool-fixture" },
    body: JSON.stringify({ tool, args, agentId: "agent-1", agentToken: "alg-522-tool-fixture", sessionId: "session-1" }),
  });
}

function captureLogs() {
  const lines: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((line: string) => { lines.push(line); });
  vi.spyOn(console, "error").mockImplementation((line: string) => { lines.push(line); });
  return lines;
}

beforeEach(() => {
  vi.stubEnv("YOPLAI_HOME", fixtureHome);
});

afterEach(async () => {
  removeContainerToken("alg-522-tool-fixture");
  await fs.rm(fixtureHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("internal tool failure severity", () => {
  it("warns for task.complete without an active task and preserves the response", async () => {
    const lines = captureLogs();
    const response = await requestFailure(taskLifecycleExtension, "task.complete");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "No active task for this session" });
    expect(lines).toHaveLength(1);
    expect(lines[0].split("\n")).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      level: "warn", msg: "[internal-tools] tool execution failed",
      tool: "task.complete", agentId: "agent-1", message: "No active task for this session",
    });
  });

  it.each([
    ["extract_document", "pdf", "PDF extraction failed"],
    ["describe_image", "png", "Image description failed"],
  ])("keeps actual %s failures at error", async (tool, extension, message) => {
    await fs.mkdir(`${fixtureHome}/agent`, { recursive: true });
    await fs.writeFile(`${fixtureHome}/agent/file.${extension}`, "fixture");
    const lines = captureLogs();
    const fail = async () => { throw new Error(message); };
    const response = await requestFailure(failingTools(() => undefined), tool,
      { path: `/workspace/file.${extension}` }, { extractText: fail, describeImage: fail });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: message });
    expect(lines).toHaveLength(1);
    expect(lines[0].split("\n")).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: "error", msg: "[internal-tools] tool execution failed",
      tool, agentId: "agent-1", message, stack: expect.any(String),
    });
  });

  it.each([
    ["extract_document", { path: "/workspace/report.txt" }, "extract_document supports PDF files only", false],
    ["extract_document", { path: "/etc/report.pdf" }, "Document path is outside approved container roots", false],
    ["extract_document", { path: "/workspace/../report.pdf" }, "Document path traversal is not allowed", false],
    ["extract_document", { path: "/workspace/missing.pdf" }, "Document was not found under an approved container root", false],
    ["extract_document", { path: "/workspace/escape.pdf" }, "Document path is outside approved container roots", true],
    ["describe_image", {}, "describe_image requires a path", false],
    ["describe_image", { path: "/workspace/image.txt" }, "describe_image supports PNG, JPEG, GIF, WebP, and SVG files only", false],
    ["describe_image", { path: "/workspace/missing.png" }, "Image was not found under an approved container root", false],
    ["describe_image", { path: "/workspace/escape.png" }, "Image path is outside approved container roots", true],
    ["describe_image", { path: "/etc/image.png" }, "Document path is outside approved container roots", false],
    ["describe_image", { path: "/workspace/../image.png" }, "Document path traversal is not allowed", false],
  ])("warns for caller input to %s: %s", async (tool, args, message, escape) => {
    if (escape) {
      await fs.mkdir(`${fixtureHome}/agent`, { recursive: true });
      await fs.writeFile(`${fixtureHome}/outside`, "outside approved roots");
      await fs.symlink(`${fixtureHome}/outside`, `${fixtureHome}/agent/escape.${tool === "extract_document" ? "pdf" : "png"}`);
    }
    const lines = captureLogs();
    const response = await requestFailure(failingTools(() => undefined), tool, args);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: message });
    expect(lines).toHaveLength(1);
    expect(lines[0].split("\n")).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      level: "warn", msg: "[internal-tools] tool execution failed",
      tool, agentId: "agent-1", message,
    });
  });

  it("warns for extract_document without a path and preserves the response", async () => {
    const lines = captureLogs();
    const response = await requestFailure(failingTools(() => undefined), "extract_document");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "extract_document requires a path" });
    expect(lines).toHaveLength(1);
    expect(lines[0].split("\n")).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      level: "warn", msg: "[internal-tools] tool execution failed",
      tool: "extract_document", agentId: "agent-1", message: "extract_document requires a path",
    });
  });

  it("warns for numeric MCP invalid params and preserves the response", async () => {
    const lines = captureLogs();
    const response = await requestFailure(failingTools(() => {
      throw Object.assign(new Error('MCP error -32602: { "error": "custom prompts require a report_id" }'), {
        code: -32602,
      });
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'MCP error -32602: { "error": "custom prompts require a report_id" }' });
    expect(lines).toHaveLength(1);
    expect(lines[0].split("\n")).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      level: "warn", msg: "[internal-tools] tool execution failed",
      tool: "fixture_failure", agentId: "agent-1",
      message: 'MCP error -32602: { "error": "custom prompts require a report_id" }',
    });
  });

  it.each([
    ["MCP internal error", Object.assign(new Error("MCP error -32603: Internal error"), { code: -32603 }), "MCP error -32603: Internal error"],
    ["message-only invalid params", new Error("MCP error -32602: Invalid params"), "MCP error -32602: Invalid params"],
    ["string invalid-params code", Object.assign(new Error("MCP error -32602: Invalid params"), { code: "-32602" }), "MCP error -32602: Invalid params"],
  ])("keeps %s at error with a stack and preserves the response", async (_label, error, message) => {
    const lines = captureLogs();
    const response = await requestFailure(failingTools(() => { throw error; }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: message });
    expect(lines).toHaveLength(1);
    expect(lines[0].split("\n")).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: "error", msg: "[internal-tools] tool execution failed",
      tool: "fixture_failure", agentId: "agent-1", message, stack: expect.any(String),
    });
  });

  it("warns for upstream 404 with sanitized top-level context and preserves the response", async () => {
    const lines = captureLogs();
    const response = await requestFailure(failingTools(() => {
      throw Object.assign(new Error("Not found token=fixture-secret\nretry later"), {
        status: 404, endpoint: "https://api.example.test/items?token=fixture-secret",
      });
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found token=fixture-secret\nretry later" });
    expect(lines).toHaveLength(1);
    expect(lines[0].split("\n")).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      level: "warn", msg: "[internal-tools] tool execution failed",
      tool: "fixture_failure", agentId: "agent-1", status: 404,
      endpoint: "https://api.example.test/items?token=[REDACTED]",
      message: "Not found token=[REDACTED]\nretry later",
    });
  });

  it("warns for the dashboard_update slug validation marker without changing the response", async () => {
    const lines = captureLogs();
    const response = await requestFailure(canvasExtension, "dashboard_update", { slug: "../outside.html" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Dashboard slug must be one .html filename, e.g. pto-team.html" });
    expect(lines).toHaveLength(1);
    expect(lines[0].split("\n")).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      level: "warn", msg: "[internal-tools] tool execution failed",
      tool: "dashboard_update", agentId: "agent-1",
      message: "Dashboard slug must be one .html filename, e.g. pto-team.html",
    });
  });

  it("warns for a missing session_history search query without changing the response", async () => {
    const lines = captureLogs();
    const response = await requestFailure(sessionHistoryExtension, "session_history", { action: "search" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "search requires `query`" });
    expect(lines).toHaveLength(1);
    expect(lines[0].split("\n")).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      level: "warn", msg: "[internal-tools] tool execution failed",
      tool: "session_history", agentId: "agent-1",
      message: "search requires `query`",
    });
  });

  it("warns for upstream 429 without requiring an endpoint", async () => {
    const lines = captureLogs();
    const response = await requestFailure(failingTools(() => {
      throw Object.assign(new Error("Rate limited"), { status: 429 });
    }));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Rate limited" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      level: "warn", msg: "[internal-tools] tool execution failed",
      tool: "fixture_failure", agentId: "agent-1", status: 429, message: "Rate limited",
    });
  });

  it("keeps upstream 500 at error with sanitized diagnostics", async () => {
    const lines = captureLogs();
    const response = await requestFailure(failingTools(() => {
      throw Object.assign(new Error("Server failed token=fixture-secret\nupstream unavailable"), {
        status: 500, endpoint: "https://api.example.test/items?token=fixture-secret",
      });
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Server failed token=fixture-secret\nupstream unavailable" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("fixture-secret");
    expect(lines[0].split("\n")).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: "error", msg: "[internal-tools] tool execution failed",
      tool: "fixture_failure", agentId: "agent-1", status: 500,
      endpoint: "https://api.example.test/items?token=[REDACTED]",
      message: "Server failed token=[REDACTED]\nupstream unavailable",
      stack: expect.any(String),
    });
  });

  it("keeps an exception without a status at error even when its text contains 404", async () => {
    const lines = captureLogs();
    const response = await requestFailure(failingTools(() => { throw new Error("Unexpected 404 while parsing"); }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Unexpected 404 while parsing" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: "error", message: "Unexpected 404 while parsing" });
    expect(JSON.parse(lines[0])).not.toHaveProperty("status");
  });

  it("keeps network failures at error", async () => {
    const lines = captureLogs();
    const response = await requestFailure(failingTools(() => {
      throw Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" });
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Connection refused" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: "error", message: "Connection refused" });
  });

  it("keeps an unmarked auth-response Zod validation failure at error", async () => {
    const lines = captureLogs();
    const response = await requestFailure(failingTools(() => {
      return z.object({ accessToken: z.string() }).parse({ accessToken: 42 });
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: expect.stringContaining("invalid_type") });
    expect(lines).toHaveLength(1);
    expect(lines[0].split("\n")).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: "error", msg: "[internal-tools] tool execution failed",
      tool: "fixture_failure", agentId: "agent-1", message: expect.stringContaining("invalid_type"),
    });
  });

  it.each(["404", 404.5, 399, 600])("keeps an invalid HTTP status %s at error", async (status) => {
    const lines = captureLogs();
    const response = await requestFailure(failingTools(() => {
      throw Object.assign(new Error("Upstream failure"), { status });
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Upstream failure" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: "error", message: "Upstream failure" });
  });
});
