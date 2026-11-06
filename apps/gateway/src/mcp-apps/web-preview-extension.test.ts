import { createServer, type Server } from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentConfigSchema, GatewayConfigSchema } from "@yoplai/shared";

// Pom approved loaded runtime tools -> model text and public capture reads in
// ALG-656 comment 77af29fb. This misses runner transport and native browser loads.
let home: string;
let server: Server | undefined;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-preview-tool-"));
  vi.stubEnv("YOPLAI_HOME", home);
  vi.resetModules();
});
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});
async function runtimeTool() {
  const { loadExtensions } = await import("../extensions/registry.js");
  const { ExtensionRuntime } = await import("../extensions/runtime.js");
  const agent = AgentConfigSchema.parse({ id: "preview", name: "Preview", workspace: path.join(home, "workspace"), model: { provider: "test", model: "test" } });
  const config = GatewayConfigSchema.parse({ agents: [agent], extensionsPath: path.join(home, "extensions"), canvas: { enabled: false } });
  const runtime = new ExtensionRuntime();
  runtime.load(await loadExtensions(config));
  const tool = (await runtime.getTools(agent, config)).find(tool => tool.name === "web_preview");
  expect(tool).toBeDefined();
  if (!tool) throw new Error("Missing web_preview");
  return { tool, context: { agent, config, sessionId: "chat", toolCallId: "preview-call" } };
}

it("always exposes a core preview tool and captures a local page without a reserved-server warning", async () => {
  server = createServer((_req, res) => { res.end("Preview fixture"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  const url = `http://localhost:${address.port}/page#heading`;
  const { tool, context } = await runtimeTool();
  expect(tool).toMatchObject({ core: true, mcp: { server: "yoplai", tool: "web_preview", ui: { resourceUri: "ui://yoplai/web-preview", visibility: ["model"] } } });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await tool.execute({ url, title: "Local page" }, context)).toBe(`Web preview shown: ${url}`);
  const capture = await import("./capture.js");
  const identity = { agentId: "preview", sessionId: "chat" };
  expect(capture.getMcpAppView(identity, "preview-call")).toMatchObject({ key: `http://localhost:${address.port}/page`, preview: { frameable: true } });
  expect(await capture.readMcpAppRecord(identity, "preview-call")).toMatchObject({
    args: { url, title: "Local page" }, result: {
      content: [{ type: "text", text: `Web preview shown: ${url}` }],
      structuredContent: { url, finalUrl: url, title: "Local page", frameable: true, reason: null, status: 200 },
    },
  });
  expect(warn.mock.calls.flat().some(line => String(line).includes("reserved_server"))).toBe(false);
});

it("refuses invalid URLs, overlong titles and cancelled runs without storing a view", async () => {
  const { tool, context } = await runtimeTool();
  const capture = await import("./capture.js");
  const identity = { agentId: "preview", sessionId: "chat" };
  for (const args of [{ url: "ftp://example.test/page" }, { url: "http://localhost:3000" }, { url: "https://example.test", title: "a".repeat(201) }]) {
    await expect(tool.execute(args, context)).rejects.toThrow();
    expect(capture.getMcpAppView(identity, "preview-call")).toBeUndefined();
    expect(await capture.readMcpAppRecord(identity, "preview-call")).toBeUndefined();
  }
  const controller = new AbortController();
  controller.abort(new Error("run cancelled"));
  await expect(tool.execute({ url: "https://example.test" }, { ...context, signal: controller.signal })).rejects.toThrow("run cancelled");
  expect(await capture.readMcpAppRecord(identity, "preview-call")).toBeUndefined();
});

it("returns a link-card result with a stored non-frameable reference when the page refuses framing", async () => {
  server = createServer((_req, res) => { res.writeHead(200, { "X-Frame-Options": "DENY" }); res.end("Private fixture"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  const url = `http://localhost:${address.port}/denied`;
  const { tool, context } = await runtimeTool();
  expect(await tool.execute({ url, title: "a".repeat(200) }, context)).toBe(`Web preview of ${url}: link card shown (x-frame-options)`);
  const capture = await import("./capture.js");
  expect(capture.getMcpAppView({ agentId: "preview", sessionId: "chat" }, "preview-call")).toMatchObject({ key: url, preview: { frameable: false } });
  expect(await capture.readMcpAppRecord({ agentId: "preview", sessionId: "chat" }, "preview-call")).toMatchObject({ result: {
    structuredContent: { url, finalUrl: url, title: "a".repeat(200), frameable: false, reason: "x-frame-options", status: 200 },
  } });
});
