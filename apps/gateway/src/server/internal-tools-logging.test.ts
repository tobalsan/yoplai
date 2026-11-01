import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GatewayConfigSchema, type Extension } from "@yoplai/shared";
import { ExtensionRuntime } from "../extensions/runtime.js";
import { canvasExtension } from "../canvas/index.js";
import { registerContainerToken, removeContainerToken } from "../sdk/container/tokens.js";
import { createInternalTools } from "./internal-tools.js";

const fixtureHome = `${process.cwd()}/.alg-522-tool-home`;
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
  args: unknown = {}
) {
  const runtime = new ExtensionRuntime();
  runtime.load([extension]);
  registerContainerToken("alg-522-tool-fixture", {
    agentId: "agent-1", sessionId: "session-1", runId: "run-1", containerName: "fixture",
    roots: { workspace: `${fixtureHome}/agent`, data: `${fixtureHome}/data`, uploads: `${fixtureHome}/uploads` },
    conversationFiles: { hostPath: `${fixtureHome}/files`, runtimePath: "/workspace/files" },
  });
  const app = createInternalTools({ getConfig: () => config, getRuntime: () => runtime });
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

afterEach(() => {
  removeContainerToken("alg-522-tool-fixture");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("internal tool failure severity", () => {
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
