import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net, { type AddressInfo } from "node:net";
import http from "node:http";
import { z } from "zod";
import { JSDOM } from "jsdom";
import type { Extension, McpAppsContext, McpResourceContent } from "@yoplai/shared";
import { writeTestV3Config } from "../test-utils/v3-config.js";

const route = "/api/agents/main/sessions/chat-one/mcp-apps/call-one";
const rawResult = { content: [{ type: "text", text: "Created board" }], _meta: { board: "raw-board" } };

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("MCP Apps gateway views", () => {
  let home: string;
  let previousHome: string | undefined;
  let server: ReturnType<typeof import("../server/index.js").startServer>;
  let gatewayUrl: string;
  let appsPort: number;
  let contents: McpResourceContent[];
  const reads: Array<{ ctx: McpAppsContext; server: string; uri: string }> = [];
  let toolCalls = 0;
  let upstreamError: unknown;
  let hangTools = false;
  let heldRead: Promise<void> | undefined;
  let readStarted: (() => void) | undefined;
  const waitingSignals: Array<AbortSignal | undefined> = [];
  const calls: Array<{ ctx: McpAppsContext; server: string; tool: string; args: Record<string, unknown> }> = [];

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-app-views-"));
    previousHome = process.env.YOPLAI_HOME;
    process.env.YOPLAI_HOME = home;
    appsPort = await freePort();
    await writeTestV3Config(home, {
      agents: [{ id: "main" }],
      extraConfig: { apps: { port: appsPort } },
    });
    const history = path.join(home, "history");
    await fs.mkdir(path.join(history, "mcp-apps", "main", "chat-one"), { recursive: true });
    await fs.writeFile(path.join(history, "2026-10-24T12-00-00-000Z_main-chat-one.jsonl"), '{"type":"user","content":"draw"}\n');
    await fs.writeFile(path.join(history, "mcp-apps", "main", "chat-one", "0123456789abcdef0123456789abcdef.json"), JSON.stringify({
      recordId: "0123456789abcdef0123456789abcdef", agentId: "main", sessionId: "chat-one", ownerUserId: null,
      toolCallId: "call-one", server: "boards", tool: "create_board", resourceUri: "ui://boards/editor",
      args: { title: "Roadmap" }, result: rawResult, createdAt: 1792843200000,
    }));
    contents = [{ uri: "ui://boards/editor", mimeType: "text/html;profile=mcp-app", text: "<!doctype html><p>Board</p>" }];
    vi.resetModules();
    const { getExtensionRuntime } = await import("../extensions/registry.js");
    const runtime = getExtensionRuntime();
    const extension: Extension = {
      id: "mcp", routePrefixes: [], dependencies: [], displayName: "MCP fixture", description: "MCP Apps route fixture", configSchema: z.object({}),
      validateConfig: () => ({ valid: true, errors: [] }), registerRoutes() {}, async start() {}, async stop() {}, capabilities: () => [],
      mcpApps: {
        async readResource(ctx, server, uri) { reads.push({ ctx, server, uri }); if (heldRead) { readStarted?.(); await heldRead; } return { contents }; },
        async callTool(ctx, server, tool, args) { if (hangTools) { waitingSignals.push(ctx.signal); return new Promise(() => { /* Uncooperative upstream. */ }); } if (upstreamError) throw upstreamError; toolCalls++; calls.push({ ctx, server, tool, args }); return { content: [{ type: "text", text: "Edited" }], _meta: { edit: 4 } }; },
      },
    };
    runtime.load([extension]);
    const { startServer } = await import("../server/index.js");
    server = startServer(0, "127.0.0.1", runtime);
    await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
    gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousHome === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
    vi.resetModules();
  });

  it("replays stored arguments and raw result by reading the resource without rerunning the tool", async () => {
    const response = await fetch(gatewayUrl + route + "/view", { method: "POST", headers: { Origin: "http://localhost:3000" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      available: true, appsOrigin: `http://yoplai-apps.localhost:${appsPort}`, server: "boards", toolName: "create_board",
      args: { title: "Roadmap" }, result: rawResult,
    });
    expect(reads).toEqual([{ ctx: { agentId: "main", signal: expect.any(AbortSignal) }, server: "boards", uri: "ui://boards/editor" }]);
    expect(toolCalls).toBe(0);
  });
  async function view() {
    const response = await fetch(gatewayUrl + route + "/view", { method: "POST", headers: { Origin: "http://localhost:3000" } });
    return response.json() as Promise<{ sandboxUrl: string; appsOrigin: string }>;
  }

  function appGet(url: string, host?: string, method = "GET"): Promise<Response> {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port: appsPort, path: target.pathname, method, headers: { Host: host ?? target.host } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers as Record<string, string> })));
      });
      request.on("error", reject);
      request.end();
    });
  }

  it("serves only ticket pages with isolated headers and the exact restrictive default CSP", async () => {
    const issued = await view();
    const sandbox = await appGet(issued.sandboxUrl);
    const content = await appGet(issued.sandboxUrl.replace("/sandbox/", "/content/"));
    expect(sandbox.status).toBe(200);
    expect(content.status).toBe(200);
    for (const response of [sandbox, content]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(content.headers.get("content-security-policy")).toBe(`default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'; frame-src 'none'; base-uri 'self'; object-src 'none'; frame-ancestors http://localhost:3000 ${issued.appsOrigin}`);
    expect(sandbox.headers.get("content-security-policy")).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors http://localhost:3000");
    expect(content.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(await content.text()).toBe("<!doctype html><p>Board</p>");
    for (const pathname of ["/api", "/ws", "/internal", "/d"]) {
      expect((await appGet(issued.appsOrigin + pathname)).status).toBe(404);
    }
  });

  it("bootstraps a checked double-frame relay without relying on the document referrer", async () => {
    const issued = await view();
    const parent = { postMessage: vi.fn() };
    const dom = new JSDOM(await (await appGet(issued.sandboxUrl)).text(), {
      url: issued.sandboxUrl, runScripts: "dangerously",
      beforeParse(window) { Object.defineProperty(window, "parent", { value: parent }); },
    });
    try {
      expect(parent.postMessage.mock.calls).toEqual([[{ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} }, "http://localhost:3000"]]);
      const ready = { jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: { html: "" } };
      function message(data: unknown, source: unknown, origin: string) {
        dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source: source as Window, origin }));
      }
      message(ready, parent, "https://attacker.test");
      message(ready, {}, "http://localhost:3000");
      expect(dom.window.document.querySelector("iframe")).toBeNull();
      message(ready, parent, "http://localhost:3000");
      const inner = dom.window.document.querySelector("iframe")!;
      expect(inner.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
      expect(inner.src).toBe(issued.sandboxUrl.replace("/sandbox/", "/content/"));
      const childPost = vi.spyOn(inner.contentWindow!, "postMessage");
      const request = { jsonrpc: "2.0", id: 7, method: "ui/initialize", params: {} };
      message(request, parent, "http://localhost:3000");
      expect(childPost.mock.calls).toEqual([[request, issued.appsOrigin]]);
      const result = { jsonrpc: "2.0", id: 7, result: { ready: true } };
      message(result, inner.contentWindow, "https://attacker.test");
      message(result, {}, issued.appsOrigin);
      expect(parent.postMessage).toHaveBeenCalledTimes(1);
      message(result, inner.contentWindow, issued.appsOrigin);
      expect(parent.postMessage).toHaveBeenLastCalledWith(result, "http://localhost:3000");
      message(ready, inner.contentWindow, issued.appsOrigin);
      message({ jsonrpc: "2.0", method: "ui/notifications/sandbox-evil" }, inner.contentWindow, issued.appsOrigin);
      message({ jsonrpc: "2.0", method: "ui/notifications/sandbox-evil" }, parent, "http://localhost:3000");
      expect(parent.postMessage).toHaveBeenCalledTimes(2);
      expect(childPost).toHaveBeenCalledTimes(1);
    } finally { dom.window.close(); }
  });

  it("maps the four declared CSP lists, returning only approved origins and the resource border preference", async () => {
    contents = [{ uri: "ui://boards/editor", mimeType: "text/html;profile=mcp-app", text: "<p>Policy</p>", _meta: { ui: {
      prefersBorder: true,
      csp: { connectDomains: ["https://api.example.test", "wss://socket.example.test", "http://localhost:4170", "http://127.0.0.1:4171", "https://bad.test/path", "https://*.bad.test", "https://bad.test;script-src"], resourceDomains: ["https://cdn.example.test"], frameDomains: ["https://frame.example.test"], baseUriDomains: ["https://base.example.test"] },
    } } }];
    const warning = vi.spyOn(console, "warn");
    try {
      const response = await fetch(gatewayUrl + route + "/view", { method: "POST", headers: { Origin: "http://localhost:3000" } });
      const issued = await response.json();
      expect(issued).toMatchObject({ prefersBorder: true, csp: {
        connectDomains: ["https://api.example.test", "wss://socket.example.test", "http://localhost:4170", "http://127.0.0.1:4171"], resourceDomains: ["https://cdn.example.test"], frameDomains: ["https://frame.example.test"], baseUriDomains: ["https://base.example.test"],
      } });
      const content = await appGet(issued.sandboxUrl.replace("/sandbox/", "/content/"));
      expect(content.headers.get("content-security-policy")).toBe(`default-src 'none'; script-src 'self' 'unsafe-inline' https://cdn.example.test; style-src 'self' 'unsafe-inline' https://cdn.example.test; img-src 'self' data: https://cdn.example.test; media-src 'self' data: https://cdn.example.test; font-src 'self' https://cdn.example.test; connect-src https://api.example.test wss://socket.example.test http://localhost:4170 http://127.0.0.1:4171; frame-src https://frame.example.test; base-uri https://base.example.test; object-src 'none'; frame-ancestors http://localhost:3000 ${issued.appsOrigin}`);
      expect(warning.mock.calls.filter(([line]) => String(line).includes("MCP Apps invalid CSP origin"))).toHaveLength(3);
    } finally { warning.mockRestore(); }
  });

  it("relays JSON-RPC tool calls only to the stored server and returns the raw result", async () => {
    const response = await fetch(gatewayUrl + route + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      jsonrpc: "2.0", id: "edit-1", method: "tools/call", params: { name: "edit_board", arguments: { text: "Launch" }, server: "other-server", agentId: "other-agent", userId: "other-user" },
    }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: "edit-1", result: { content: [{ type: "text", text: "Edited" }], _meta: { edit: 4 } } });
    expect(calls).toEqual([{ ctx: { agentId: "main", signal: expect.any(AbortSignal) }, server: "boards", tool: "edit_board", args: { text: "Launch" } }]);
  });

  it("relays resource reads on the record server with the viewer context", async () => {
    reads.length = 0;
    contents = [{ uri: "ui://boards/detail", mimeType: "application/json", text: '{"selection":4}' }];
    const response = await fetch(gatewayUrl + route + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "resources/read", params: { uri: "ui://boards/detail", server: "attacker" } }) });
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 8, result: { contents: [{ uri: "ui://boards/detail", mimeType: "application/json", text: '{"selection":4}' }] } });
    expect(reads).toEqual([{ ctx: { agentId: "main", signal: expect.any(AbortSignal) }, server: "boards", uri: "ui://boards/detail" }]);
  });

  it("maps shaped MCP Apps errors without exposing upstream diagnostics", async () => {
    for (const reason of ["unknown_agent", "unknown_server", "unknown_tool", "not_app_visible", "not_connected", "needs_reconnect", "timeout", "aborted", "upstream"]) {
      upstreamError = { name: "McpAppsError", reason, authorizeUrl: "https://connect.example.test/start", message: "private upstream diagnostics" };
      const response = await fetch(gatewayUrl + route + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "edit_board", arguments: {} } }) });
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 9, error: { code: -32000, message: "MCP Apps request failed", data: { reason, authorizeUrl: "https://connect.example.test/start" } } });
    }
    upstreamError = undefined;
    const unknown = await fetch(gatewayUrl + route + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "ui/message", params: {} }) });
    expect(await unknown.json()).toEqual({ jsonrpc: "2.0", id: 10, error: { code: -32601, message: "Method not found" } });
  });

  it("refuses a JSON-RPC body over 1 MB before dispatching to MCP", async () => {
    const before = toolCalls;
    const response = await fetch(gatewayUrl + route + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "edit_board", arguments: { text: "x".repeat(1024 * 1024) } } }) });
    expect(response.status).toBe(413);
    expect(toolCalls).toBe(before);
  });

  it("times out an uncooperative RPC at the 30 second deadline and still serves a healthy call", async () => {
    const realTimeout = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => realTimeout(callback, delay === 30_000 ? 10 : delay, ...args));
    hangTools = true;
    try {
      const response = await fetch(gatewayUrl + route + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(800), body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "edit_board" } }) });
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 12, error: { code: -32000, message: "MCP Apps request failed", data: { reason: "timeout" } } });
      expect(waitingSignals.at(-1)?.aborted).toBe(true);
      hangTools = false;
      const healthy = await fetch(gatewayUrl + route + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "edit_board" } }) });
      expect(await healthy.json()).toMatchObject({ id: 13, result: { content: [{ type: "text", text: "Edited" }] } });
    } finally { hangTools = false; timer.mockRestore(); }
  });

  it("writes bounded sanitized web events and audits denied operations without payloads", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await fetch(gatewayUrl + route + "/log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: "info", message: "open-link token=fixture-secret", payload: { raw: "RAW-PAYLOAD-SHOULD-NOT-LOG" } }) });
      expect(response.status).toBe(200);
      const denied = await fetch(gatewayUrl + route.replace("call-one", "missing-call") + "/view", { method: "POST", headers: { Origin: "http://localhost:3000" } });
      expect(denied.status).toBe(404);
      const entries = log.mock.calls.flatMap(([line]) => {
        try { return [JSON.parse(String(line))]; } catch { return []; }
      }).filter((entry) => entry.msg === "MCP Apps operation");
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ viewer: null, agent: "main", session: "chat-one", toolCall: "call-one", server: "boards", method: "log", tool: "create_board", outcome: "ok", appLevel: "info", message: "open-link token=[REDACTED]", duration: expect.any(Number) });
      expect(entries[1]).toMatchObject({ viewer: null, agent: "main", session: "chat-one", toolCall: "missing-call", server: null, method: "view", outcome: "not_found" });
      expect(JSON.stringify(entries)).not.toContain("RAW-PAYLOAD-SHOULD-NOT-LOG");
      expect(JSON.stringify(entries)).not.toContain("fixture-secret");
    } finally { log.mockRestore(); }
  });

  async function seedSession(sessionId: string): Promise<string> {
    const source = path.join(home, "history", "mcp-apps", "main", "chat-one");
    const records = path.join(home, "history", "mcp-apps", "main", sessionId);
    await fs.cp(source, records, { recursive: true });
    const file = path.join(records, "0123456789abcdef0123456789abcdef.json");
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    record.sessionId = sessionId;
    await fs.writeFile(file, JSON.stringify(record));
    await fs.writeFile(path.join(home, "history", `2026-10-24T12-00-00-000Z_main-${sessionId}.jsonl`), '{"type":"user","content":"draw"}\n');
    return records;
  }

  it("keeps records and tickets when archiving, and removes both on session deletion", async () => {
    contents = [{ uri: "ui://boards/editor", mimeType: "text/html;profile=mcp-app", text: "<p>Archive</p>" }];
    const records = await seedSession("archive-delete");
    const sessionRoute = "/api/agents/main/sessions/archive-delete";
    const response = await fetch(gatewayUrl + sessionRoute + "/mcp-apps/call-one/view", { method: "POST", headers: { Origin: "http://localhost:3000" } });
    const issued = await response.json();
    const archived = await fetch(gatewayUrl + sessionRoute, { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"archived":true}' });
    expect(archived.status).toBe(200);
    expect((await appGet(issued.sandboxUrl)).status).toBe(200);
    expect(await fs.readdir(records)).toEqual(["0123456789abcdef0123456789abcdef.json"]);
    const deleted = await fetch(gatewayUrl + sessionRoute, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect((await appGet(issued.sandboxUrl)).status).toBe(404);
    await expect(fs.stat(records)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cannot publish a new ticket when the session is deleted during its resource read", async () => {
    await seedSession("delete-pending");
    contents = [{ uri: "ui://boards/editor", mimeType: "text/html;profile=mcp-app", text: "<p>Deleted</p>" }];
    let release = () => {};
    heldRead = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    try {
      const pending = fetch(gatewayUrl + route.replace("chat-one", "delete-pending") + "/view", { method: "POST", headers: { Origin: "http://localhost:3000" } });
      await started;
      const deleted = await fetch(gatewayUrl + "/api/agents/main/sessions/delete-pending", { method: "DELETE" });
      expect(deleted.status).toBe(200);
      release();
      const result = await (await pending).json();
      expect(result.available).toBe(false);
      expect(result.reason).toBe("session_deleted");
    } finally { release(); heldRead = undefined; readStarted = undefined; }
  });

  it("rejects non-GET requests, including Hono's implicit HEAD handling, on the isolated listener", async () => {
    const issued = await view();
    for (const method of ["HEAD", "POST", "OPTIONS", "PUT", "DELETE"]) {
      expect((await appGet(issued.sandboxUrl, undefined, method)).status).toBe(404);
    }
    expect((await appGet(issued.sandboxUrl)).status).toBe(200);
  });

  it("accepts one bounded HTML text or base64 blob and refuses invalid resource variants", async () => {
    contents = [{ uri: "ui://boards/editor", mimeType: "text/html;profile=mcp-app", blob: "PHA+QmxvYjwvcD4=" }];
    const issued = await view();
    expect(await (await appGet(issued.sandboxUrl.replace("/sandbox/", "/content/"))).text()).toBe("<p>Blob</p>");
    const cases: McpResourceContent[][] = [
      [],
      [{ uri: "ui://boards/editor", mimeType: "text/html", text: "<p>Wrong MIME</p>" }],
      [{ uri: "ui://boards/editor", mimeType: "text/html;profile=mcp-app", text: "one" }, { uri: "ui://boards/editor", mimeType: "text/html;profile=mcp-app", text: "two" }],
      [{ uri: "ui://boards/editor", mimeType: "text/html;profile=mcp-app", text: "x".repeat(2 * 1024 * 1024 + 1) }],
      [{ uri: "ui://boards/editor", mimeType: "text/html;profile=mcp-app", blob: "not base64!" }],
    ];
    for (const candidate of cases) {
      contents = candidate;
      const response = await fetch(gatewayUrl + route + "/view", { method: "POST", headers: { Origin: "http://localhost:3000" } });
      const result = await response.json();
      expect(result.available).toBe(false);
      expect(result.reason).toBe("invalid_resource");
    }
  });

  it("selects only an isolated bare apps origin for a trusted browser Origin", async () => {
    contents = [{ uri: "ui://boards/editor", mimeType: "text/html;profile=mcp-app", text: "<p>Origin</p>" }];
    const { loadConfig, setLoadedConfig } = await import("../config/index.js");
    const original = loadConfig();
    async function post(origin?: string) {
      return fetch(gatewayUrl + route + "/view", { method: "POST", headers: { ...(origin ? { Origin: origin } : {}), "X-Forwarded-Host": "chat.example.test" } });
    }
    try {
      setLoadedConfig({ ...original, web: { baseUrl: "https://chat.example.test" } });
      expect((await (await post("https://chat.example.test")).json()).available).toBe(false);
      expect((await post("https://attacker.example.test")).status).toBe(403);
      expect((await post()).status).toBe(403);
      setLoadedConfig({ ...original, web: { baseUrl: "https://chat.example.test" }, apps: { port: appsPort, origin: "https://apps.example.org" } });
      const remote = await (await post("https://chat.example.test")).json();
      expect(remote.available).toBe(true);
      expect(remote.appsOrigin).toBe("https://apps.example.org");
      expect((await appGet(remote.sandboxUrl)).status).toBe(200);
      for (const candidate of ["https://chat.example.test:8443", "http://apps.example.org", "https://apps.example.org/path", "https://apps.example.org?query=1", "https://apps.example.org#fragment", "https://user:pass@apps.example.org", "https://apps.example.org/"]) {
        setLoadedConfig({ ...original, web: { baseUrl: "https://chat.example.test" }, apps: { port: appsPort, origin: candidate } });
        const result = await (await post("https://chat.example.test")).json();
        expect(result.available).toBe(false);
      }
    } finally { setLoadedConfig(original); }
  });

  it("redacts ticket capabilities from successful and failed listener access logs", async () => {
    const issued = await view();
    const ticket = new URL(issued.sandboxUrl).pathname.split("/").at(-1)!;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await appGet(issued.sandboxUrl);
      await appGet(issued.appsOrigin + "/content/not-a-ticket");
      const lines = log.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => /^--> GET \/sandbox\/\[redacted\] 200/.test(line))).toBe(true);
      expect(lines.some((line) => /^--> GET \/content\/\[redacted\] 404/.test(line))).toBe(true);
      expect(lines.join(" ").includes(ticket)).toBe(false);
    } finally { log.mockRestore(); }
  });

  it("binds tickets to their apps host, expires them after one hour, and prunes the oldest beyond 512", async () => {
    const issued = await view();
    expect((await appGet(issued.sandboxUrl, "other.localhost:" + appsPort)).status).toBe(404);
    expect((await appGet(issued.appsOrigin + "/sandbox/not-a-ticket")).status).toBe(404);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3600_001);
    try { expect((await appGet(issued.sandboxUrl)).status).toBe(404); }
    finally { clock.mockRestore(); }
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const oldest = await view();
      let latest = oldest;
      for (let index = 0; index < 512; index++) latest = await view();
      expect((await appGet(oldest.sandboxUrl)).status).toBe(404);
      expect((await appGet(latest.sandboxUrl)).status).toBe(200);
    } finally { log.mockRestore(); }
  }, 10_000);

  it("rejects malformed JSON-RPC requests before any upstream dispatch", async () => {
    const beforeCalls = calls.length, beforeReads = reads.length;
    for (const [body, code] of [
      [{ jsonrpc: "2.0", id: true, method: "tools/call", params: { name: "edit_board" } }, -32600],
      [{ jsonrpc: "2.0", id: {}, method: "tools/call", params: { name: "edit_board" } }, -32600],
      [[{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "edit_board" } }], -32600],
      [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "edit_board", arguments: [] } }, -32602],
      [{ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: 4 } }, -32602],
    ] as const) {
      const response = await fetch(gatewayUrl + route + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect((await response.json()).error.code).toBe(code);
    }
    expect(calls.length).toBe(beforeCalls);
    expect(reads.length).toBe(beforeReads);
  });

  it("cancels an RPC on client disconnect, audits the abort and continues serving calls", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const controller = new AbortController();
    const before = waitingSignals.length;
    hangTools = true;
    try {
      const pending = fetch(gatewayUrl + route + "/rpc", { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "edit_board" } }) }).catch((error: Error) => error);
      await vi.waitFor(() => expect(waitingSignals.length).toBe(before + 1));
      controller.abort();
      expect((await pending) instanceof Error).toBe(true);
      await vi.waitFor(() => {
        expect(waitingSignals.at(-1)?.aborted).toBe(true);
        expect(log.mock.calls.some(([line]) => String(line).includes('"outcome":"aborted"'))).toBe(true);
      });
      hangTools = false;
      const healthy = await fetch(gatewayUrl + route + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "edit_board" } }) });
      expect((await healthy.json()).result.content).toEqual([{ type: "text", text: "Edited" }]);
    } finally { controller.abort(); hangTools = false; log.mockRestore(); }
  });

  it("times out a hung view resource read and leaves a subsequent view available", async () => {
    let release = () => {};
    heldRead = new Promise<void>((resolve) => { release = resolve; });
    const realTimeout = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => realTimeout(callback, delay === 30_000 ? 10 : delay, ...args));
    try {
      const response = await fetch(gatewayUrl + route + "/view", { method: "POST", headers: { Origin: "http://localhost:3000" }, signal: AbortSignal.timeout(800) });
      expect(await response.json()).toEqual({ available: false, reason: "timeout" });
      release(); heldRead = undefined;
      const healthy = await fetch(gatewayUrl + route + "/view", { method: "POST", headers: { Origin: "http://localhost:3000" } });
      expect((await healthy.json()).available).toBe(true);
    } finally { release(); heldRead = undefined; timer.mockRestore(); }
  });

  it("keeps the gateway healthy and reports apps unavailable when the apps port is occupied", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startServer } = await import("../server/index.js");
    const second = startServer(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve) => second.listening ? resolve() : second.once("listening", resolve));
      const url = `http://127.0.0.1:${(second.address() as AddressInfo).port}`;
      await vi.waitFor(() => expect(warning.mock.calls.some(([line]) => String(line).includes("MCP Apps listener unavailable"))).toBe(true));
      expect((await fetch(url + "/health")).status).toBe(200);
      expect((await (await fetch(url + "/api/capabilities")).json()).apps).toEqual({ available: false });
      const response = await fetch(url + route + "/view", { method: "POST", headers: { Origin: "http://localhost:3000" } });
      expect(await response.json()).toEqual({ available: false, reason: "apps_unavailable" });
    } finally {
      await new Promise<void>((resolve) => second.close(() => resolve()));
      warning.mockRestore();
    }
  });

});
