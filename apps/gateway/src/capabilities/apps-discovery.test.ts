import fs from "node:fs/promises";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentConfigSchema, GatewayConfigSchema, type ExtensionAgentTool } from "@yoplai/shared";
import type { CapabilityEntry } from "./catalog.js";

const setup = await vi.hoisted(async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const home = await fs.mkdtemp(path.join(process.cwd(), ".mcp-discovery-test-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  return { home, previousHome };
});

const { capabilityDiscoveryExtension } = await import("./extension.js");
const workspace = path.join(setup.home, "agent");
let server: Server;
let tools: Record<string, unknown>[];
const requests: Record<string, unknown>[] = [];

beforeEach(async () => {
  requests.length = 0;
  tools = [
    { name: "draw", description: "Draw a diagram", _meta: { ui: { visibility: ["model", "app"] } } },
    { name: "edit_in_view", description: "Edit inside the view", _meta: { ui: { visibility: ["app"] } } },
    { name: "model_report", description: "Report to the model", _meta: { ui: { visibility: ["model"] } } },
  ];
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const message = JSON.parse(body) as Record<string, unknown>;
    requests.push(message);
    if (message.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      jsonrpc: "2.0", id: message.id,
      result: message.method === "tools/list" ? { tools } : {
        protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "apps-fixture", version: "1" },
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not listen");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "mcp.json"), JSON.stringify({
    mcpServers: { drawing: { url: `http://127.0.0.1:${address.port}` } },
  }));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

afterAll(async () => {
  if (setup.previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = setup.previousHome;
  await fs.rm(setup.home, { recursive: true, force: true });
});

async function listDrawingTools() {
  const agent = AgentConfigSchema.parse({ id: "discovery", name: "Discovery", workspace, model: { provider: "openai", model: "gpt-4o-mini" } });
  const config = GatewayConfigSchema.parse({ agents: [agent], extensions: {}, extensionsPath: path.join(setup.home, "extensions") });
  const declarations = await capabilityDiscoveryExtension.getAgentTools!(agent) as ExtensionAgentTool[];
  const list = declarations.find((tool) => tool.name === "capabilities.list");
  if (!list) throw new Error("Missing public discovery tool");
  const catalog = await list.execute({}, { agent, config, sessionId: "discovery" }) as CapabilityEntry[];
  return catalog.find((entry) => entry.id === "mcp:drawing")?.tools;
}

it("capabilities.list excludes app-only tools from the live MCP catalog", async () => {
  expect(await listDrawingTools()).toEqual([
    { name: "draw", description: "Draw a diagram" },
    { name: "model_report", description: "Report to the model" },
  ]);
});

it("capabilities.list advertises the same MCP Apps capability as agent connections", async () => {
  await listDrawingTools();
  expect(requests.find((request) => request.method === "initialize")).toMatchObject({
    params: { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } },
  });
});

it("keeps absent and malformed visibility model-visible while honoring valid empty lists", async () => {
  tools = [
    { name: "legacy" },
    { name: "missing_visibility", _meta: { ui: {} } },
    { name: "malformed_ui", _meta: { ui: ["app"] } },
    { name: "malformed_string", _meta: { ui: { visibility: "app" } } },
    { name: "malformed_entry", _meta: { ui: { visibility: ["app", "unknown"] } } },
    { name: "malformed_null", _meta: { ui: { visibility: null } } },
    { name: "empty", _meta: { ui: { visibility: [] } } },
    { name: "duplicate_app", _meta: { ui: { visibility: ["app", "app"] } } },
    { name: "model", _meta: { ui: { visibility: ["model"] } } },
  ];
  expect((await listDrawingTools())?.map((tool) => tool.name)).toEqual([
    "legacy", "missing_visibility", "malformed_ui", "malformed_string", "malformed_entry", "malformed_null", "model",
  ]);
});
