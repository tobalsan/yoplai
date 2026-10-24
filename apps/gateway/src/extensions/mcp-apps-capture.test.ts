import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentConfigSchema, GatewayConfigSchema, type ExtensionAgentTool } from "@yoplai/shared";
import { ExtensionRuntime } from "./runtime.js";

// Thinh approved the runtime + real owner-scoped filesystem seam in ALG-544
// comment 04ea3081-4db9-4872-8433-2200b96ef01a. It catches capture and model
// result fidelity; adapter events and remote credentials are covered elsewhere.
const home = await vi.hoisted(async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const previousHome = process.env.HOME;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-capture-"));
  process.env.HOME = dir;
  return { dir, previousHome };
});

afterAll(async () => {
  if (home.previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = home.previousHome;
  await fs.rm(home.dir, { recursive: true, force: true });
});

const agent = AgentConfigSchema.parse({
  id: "capture", name: "Capture", workspace: path.join(home.dir, "workspace"),
  model: { provider: "test", model: "test" },
});
const config = GatewayConfigSchema.parse({ agents: [agent] });
const raw = {
  content: [{ type: "text", text: "Created drawing 7" }],
  _meta: { access_token: "fixture-private-raw" },
  structuredContent: { drawingId: 7 },
};

function runtime(execute: ExtensionAgentTool["execute"] = async () => raw) {
  const runtime = new ExtensionRuntime();
  runtime.load([{
    id: "fixture", displayName: "Fixture", description: "Fixture", dependencies: [],
    configSchema: z.object({}), routePrefixes: [],
    validateConfig: () => ({ valid: true, errors: [] }),
    registerRoutes: () => undefined, start: async () => {}, stop: async () => {},
    capabilities: () => [], getAgentTools: () => [{
      name: "draw", description: "Draw", parameters: {}, execute,
      mcp: { server: "canvas", tool: "draw", ui: { resourceUri: "ui://canvas/view", visibility: ["model", "app"] } },
    }],
  }]);
  return runtime;
}

async function records(sessionId: string, owner = "owner") {
  const dir = path.join(home.dir, ".yoplai", "sessions", "users", owner, "history", "mcp-apps", agent.id, sessionId);
  const names = await fs.readdir(dir).catch(() => []);
  return Promise.all(names.filter(name => name.endsWith(".json")).map(async name => JSON.parse(await fs.readFile(path.join(dir, name), "utf8"))));
}

describe("MCP Apps runtime capture", () => {
  it("preserves the model result and privately records raw replay data for the storage owner", async () => {
    const result = await runtime().executeTool(agent, "draw", { title: "Example" }, config, "saved", "requester", undefined, undefined, { sessionOwnerId: "owner", toolCallId: "call-7" });
    expect(result).toEqual({ found: true, result: raw });
    const saved = await records("saved");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ agentId: "capture", sessionId: "saved", ownerUserId: "owner", toolCallId: "call-7", server: "canvas", tool: "draw", resourceUri: "ui://canvas/view", args: { title: "Example" }, result: { content: [{ type: "text", text: "Created drawing 7" }], _meta: { access_token: "fixture-private-raw" }, structuredContent: { drawingId: 7 } } });
    expect(saved[0].recordId).toMatch(/^[a-f0-9]{32,}$/);
    expect(await records("saved", "requester")).toEqual([]);
  });

  it("keeps an oversized result text-only and logs one bounded reason", async () => {
    const oversized = { content: [{ type: "text", text: "x".repeat(5 * 1024 * 1024 + 1) }] };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runtime(async () => oversized).executeTool(agent, "draw", {}, config, "large", "owner", undefined, undefined, { toolCallId: "large-call" });
      expect(result.result).toBe(oversized);
      expect((await records("large")).length).toBe(0);
      expect(warn.mock.calls).toHaveLength(1);
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ outcome: "too_large", toolCallId: "large-call" });
    } finally { warn.mockRestore(); }
  });

  it("does not save a result returned after call cancellation", async () => {
    const controller = new AbortController();
    const result = await runtime(async () => { controller.abort(); return raw; }).executeTool(agent, "draw", {}, config, "cancelled", "owner", undefined, controller.signal, { toolCallId: "cancelled-call" });
    expect(result.result).toBe(raw);
    expect((await records("cancelled")).length).toBe(0);
  });

  it("removes a record when the call aborts during the atomic write", async () => {
    const controller = new AbortController();
    const rename = fs.rename.bind(fs);
    const interrupted = vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      await rename(from, to);
      controller.abort();
    });
    try {
      const result = await runtime().executeTool(agent, "draw", {}, config, "write-abort", "owner", undefined, controller.signal, { toolCallId: "write-abort-call" });
      expect(result.result).toBe(raw);
      expect((await records("write-abort")).length).toBe(0);
    } finally { interrupted.mockRestore(); }
  });

  it("returns the original result when private record storage is unwritable", async () => {
    const parent = path.join(home.dir, ".yoplai", "sessions", "users", "owner", "history", "mcp-apps", agent.id);
    await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(path.join(parent, "blocked"), "not a directory");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runtime().executeTool(agent, "draw", {}, config, "blocked", "owner", undefined, undefined, { toolCallId: "blocked-call" });
      expect(result.result).toBe(raw);
      expect((await records("blocked")).length).toBe(0);
      expect(warn.mock.calls).toHaveLength(1);
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ outcome: "write_failed", toolCallId: "blocked-call" });
      expect(String(warn.mock.calls[0]?.[0])).not.toContain("fixture-private-raw");
    } finally { warn.mockRestore(); }
  });

  it("captures returned MCP errors and parallel calls independently", async () => {
    const returnedError = { content: [{ type: "text", text: "Drawing failed" }], isError: true, _meta: { retry: false } };
    const tool = runtime(async () => returnedError);
    const results = await Promise.all(["one", "two"].map(toolCallId => tool.executeTool(agent, "draw", { title: "Same" }, config, "parallel", "owner", undefined, undefined, { toolCallId })));
    expect(results.map(result => result.result)).toEqual([returnedError, returnedError]);
    const saved = await records("parallel");
    expect(saved.map(record => record.toolCallId).sort()).toEqual(["one", "two"]);
    expect(new Set(saved.map(record => record.recordId)).size).toBe(2);
    expect(saved.map(record => record.result)).toEqual([returnedError, returnedError]);
  });

  it("keeps canonical authentication refusals and thrown errors text-only", async () => {
    // Canonical extension 2c9e6bf, src/mcp/index.ts notConnectedResponse.
    const refusal = { isError: true, connected: false, provider: "mcp", server: "canvas", reason: "needs_reconnect", message: "canvas is not connected.", authorizeUrl: "/connect" };
    const result = await runtime(async () => refusal).executeTool(agent, "draw", {}, config, "refused", "owner", undefined, undefined, { toolCallId: "refusal" });
    expect(result.result).toBe(refusal);
    expect((await records("refused")).length).toBe(0);
    await expect(runtime(async () => { throw new Error("Upstream failed"); }).executeTool(agent, "draw", {}, config, "thrown", "owner", undefined, undefined, { toolCallId: "thrown" })).rejects.toThrow("Upstream failed");
    expect((await records("thrown")).length).toBe(0);
  });

  it("requires trusted correlation and accepts shared single-user storage", async () => {
    await runtime().executeTool(agent, "draw", {}, config, "uncorrelated", "owner");
    expect((await records("uncorrelated")).length).toBe(0);
    await runtime().executeTool(agent, "draw", {}, config, "shared", "requester", undefined, undefined, { sessionOwnerId: null, toolCallId: "shared-call" });
    const dir = path.join(home.dir, ".yoplai", "history", "mcp-apps", agent.id, "shared");
    const names = await fs.readdir(dir);
    const saved = JSON.parse(await fs.readFile(path.join(dir, names[0]!), "utf8"));
    expect(saved).toMatchObject({ ownerUserId: null, toolCallId: "shared-call" });
    expect((await records("shared", "requester")).length).toBe(0);
  });
});
