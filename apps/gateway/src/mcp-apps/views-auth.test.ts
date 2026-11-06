import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net, { type AddressInfo } from "node:net";
import { request as httpRequest, type ClientRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Extension, McpAppsContext } from "@yoplai/shared";
import { writeTestV3Config } from "../test-utils/v3-config.js";

type Viewer = { id: string; cookie: string };
const route = "/api/agents/main/sessions/owned-chat/mcp-apps/call-one";

describe("MCP Apps authenticated ownership", () => {
  let home: string;
  let previousHome: string | undefined;
  let server: ReturnType<typeof import("../server/index.js").startServer>;
  let gatewayUrl: string;
  let admin: Viewer, alice: Viewer, bob: Viewer;
  let stopAuth: (() => Promise<void>) | undefined;
  const reads: Array<{ ctx: McpAppsContext; server: string; uri: string }> = [];
  const calls: Array<{ ctx: McpAppsContext; server: string; tool: string; args: Record<string, unknown> }> = [];

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-app-auth-"));
    previousHome = process.env.YOPLAI_HOME;
    process.env.YOPLAI_HOME = home;
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const appsPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await writeTestV3Config(home, {
      agents: [{ id: "main" }],
      extensions: { multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: "mcp-apps-test-session-secret-32-characters" } },
      extraConfig: { apps: { port: appsPort } },
    });
    vi.resetModules();
    const { loadConfig } = await import("../config/index.js");
    const { multiUserExtension } = await import("@yoplai/extension-multi-user");
    const { createExtensionContext } = await import("../extensions/context.js");
    await multiUserExtension.start(createExtensionContext(loadConfig()));
    stopAuth = () => multiUserExtension.stop();
    const mcp: Extension = {
      id: "mcp", displayName: "MCP fixture", description: "Viewer-scoped MCP fixture", dependencies: [], routePrefixes: [], configSchema: z.object({}),
      validateConfig: () => ({ valid: true, errors: [] }), registerRoutes() {}, async start() {}, async stop() {}, capabilities: () => [],
      mcpApps: {
        async readResource(ctx, server, uri) {
          reads.push({ ctx, server, uri });
          return { contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: "<p>Private board</p>" }] };
        },
        async callTool(ctx, server, tool, args) { calls.push({ ctx, server, tool, args }); return { content: [{ type: "text", text: "Edited as viewer" }] }; },
      },
    };
    const { getExtensionRuntime } = await import("../extensions/registry.js");
    const runtime = getExtensionRuntime();
    runtime.load([multiUserExtension, mcp]);
    const { api } = await import("../server/api.core.js");
    multiUserExtension.registerRoutes(api);
    const { startServer } = await import("../server/index.js");
    server = startServer(0, "127.0.0.1", runtime);
    await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
    gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    async function signup(name: string): Promise<Viewer> {
      const response = await fetch(gatewayUrl + "/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify({ name, email: `${name}@apps.test`, password: "e2e-password-123" }) });
      expect(response.status).toBe(200);
      const cookies = response.headers.getSetCookie();
      expect(cookies.some((cookie) => /;\s*Domain=/i.test(cookie))).toBe(false);
      const body = await response.json();
      return { id: body.user.id, cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; ") };
    }
    admin = await signup("admin"); alice = await signup("alice"); bob = await signup("bob");
    await seed(alice.id, "owned-chat", alice.id);
    // A history with the same session id in Bob's scope must never find Alice's record.
    await fs.mkdir(path.join(home, "sessions", "users", bob.id, "history"), { recursive: true });
    await fs.writeFile(path.join(home, "sessions", "users", bob.id, "history", "2026-10-24T12-00-00-000Z_main-owned-chat.jsonl"), "");
    await seed(undefined, "shared-only", null);
    await seed(alice.id, "wrong-owner", bob.id);
  }, 20_000);

  async function seed(storageUser: string | undefined, sessionId: string, ownerUserId: string | null): Promise<void> {
    const history = storageUser ? path.join(home, "sessions", "users", storageUser, "history") : path.join(home, "history");
    const records = path.join(history, "mcp-apps", "main", sessionId);
    await fs.mkdir(records, { recursive: true });
    await fs.writeFile(path.join(history, `2026-10-24T12-00-00-000Z_main-${sessionId}.jsonl`), "");
    await fs.writeFile(path.join(records, "abcdef0123456789abcdef0123456789.json"), JSON.stringify({
      recordId: "abcdef0123456789abcdef0123456789", agentId: "main", sessionId, ownerUserId,
      toolCallId: "call-one", server: "private-boards", tool: "create_board", resourceUri: "ui://boards/private",
      args: { board: 17 }, result: { content: [{ type: "text", text: "Private result" }], _meta: { revision: 2 } }, createdAt: 1792843200000,
    }));
  }

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await stopAuth?.();
    if (previousHome === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
    vi.resetModules();
  });

  function post(viewer: Viewer, endpoint: string, body?: unknown): Promise<Response> {
    return fetch(gatewayUrl + endpoint, { method: "POST", headers: { Cookie: viewer.cookie, Origin: "http://localhost:3000", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }

  // Thinh approved this real HTTP/auth/record seam in ALG-599 comment
  // f0b31b16-5802-41d7-aa24-72d7e959dd59. It catches viewer scope and replay
  // fidelity; browser delivery and deployment configuration are covered elsewhere.
  it("returns stored data only to its viewer without calling MCP or issuing a view", async () => {
    const beforeReads = reads.length;
    const beforeCalls = calls.length;
    const response = await post(alice, route + "/data");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      args: { board: 17 },
      result: { content: [{ type: "text", text: "Private result" }], _meta: { revision: 2 } },
    });
    for (const viewer of [bob, admin]) expect((await post(viewer, route + "/data")).status).toBe(404);
    for (const session of ["shared-only", "wrong-owner", "missing-session"]) expect((await post(alice, route.replace("owned-chat", session) + "/data")).status).toBe(404);
    expect((await post(alice, route.replace("call-one", "missing-call") + "/data")).status).toBe(404);
    expect((await fetch(gatewayUrl + route + "/data", { method: "POST" })).status).toBe(401);
    expect(reads).toHaveLength(beforeReads);
    expect(calls).toHaveLength(beforeCalls);
  });

  it("refuses data from a record copied into a different session", async () => {
    const history = path.join(home, "sessions", "users", alice.id, "history");
    const filename = "abcdef0123456789abcdef0123456789.json";
    const destination = path.join(history, "mcp-apps", "main", "copied-chat");
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(history, "2026-10-24T12-00-00-000Z_main-copied-chat.jsonl"), "");
    await fs.copyFile(path.join(history, "mcp-apps", "main", "owned-chat", filename), path.join(destination, filename));
    const response = await post(alice, route.replace("owned-chat", "copied-chat") + "/data");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("loads only the authenticated viewer's own stored result, including against staff bypass and shared history", async () => {
    const response = await post(alice, route + "/view");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.available).toBe(true);
    expect(result.args).toEqual({ board: 17 });
    expect(result.result).toEqual({ content: [{ type: "text", text: "Private result" }], _meta: { revision: 2 } });
    expect(reads).toEqual([{ ctx: { agentId: "main", userId: alice.id, signal: expect.any(AbortSignal) }, server: "private-boards", uri: "ui://boards/private" }]);
    for (const viewer of [bob, admin]) expect((await post(viewer, route + "/view")).status).toBe(404);
    for (const session of ["shared-only", "wrong-owner", "missing-session"]) expect((await post(alice, route.replace("owned-chat", session) + "/view")).status).toBe(404);
    expect((await post(alice, route.replace("call-one", "missing-call") + "/view")).status).toBe(404);
    expect((await fetch(gatewayUrl + route + "/view", { method: "POST", headers: { Origin: "http://localhost:3000" } })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
  it("fails closed if the auth runtime declares any Domain-scoped cookie policy", async () => {
    const { getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
    const options = (getMultiUserRuntime()!.auth as unknown as { options: Record<string, unknown> }).options;
    const original = options.advanced;
    try {
      for (const advanced of [
        { crossSubDomainCookies: { enabled: true, domain: ".example.test" } },
        { defaultCookieAttributes: { domain: ".example.test" } },
        { cookies: { session_token: { attributes: { domain: ".example.test" } } } },
      ]) {
        options.advanced = advanced;
        const result = await (await post(alice, route + "/view")).json();
        expect(result.available).toBe(false);
        expect(result.reason).toBe("unsafe_cookie_domain");
      }
    } finally { options.advanced = original; }
  });

  it("relays as the authenticated viewer on the record's server and keeps all operations out of chat history", async () => {
    const response = await post(alice, route + "/rpc", { jsonrpc: "2.0", id: "private-edit", method: "tools/call", params: { name: "edit_board", arguments: { title: "Release" }, server: "other-server", userId: bob.id, agentId: "other-agent" } });
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: "private-edit", result: { content: [{ type: "text", text: "Edited as viewer" }] } });
    expect(calls).toEqual([{ ctx: { agentId: "main", userId: alice.id, signal: expect.any(AbortSignal) }, server: "private-boards", tool: "edit_board", args: { title: "Release" } }]);
    const resource = await post(alice, route + "/rpc", { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "ui://boards/selection" } });
    expect((await resource.json()).result.contents[0].uri).toBe("ui://boards/selection");
    expect(reads.at(-1)).toEqual({ ctx: { agentId: "main", userId: alice.id, signal: expect.any(AbortSignal) }, server: "private-boards", uri: "ui://boards/selection" });
    expect((await post(alice, route + "/log", { level: "info", message: "view ready" })).status).toBe(200);
    for (const viewer of [bob, admin]) {
      expect((await post(viewer, route + "/rpc", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "edit_board" } })).status).toBe(404);
      expect((await post(viewer, route + "/log", { level: "info", message: "denied" })).status).toBe(404);
    }
    expect(calls).toHaveLength(1);
    expect(await fs.readFile(path.join(home, "sessions", "users", alice.id, "history", "2026-10-24T12-00-00-000Z_main-owned-chat.jsonl"), "utf8")).toBe("");
  });

  it("refuses model context from a yoplai file view and audits the refusal", async () => {
    const sessionId = "file-chat";
    await seed(alice.id, sessionId, alice.id);
    const filename = path.join(home, "sessions", "users", alice.id, "history", "mcp-apps", "main", sessionId, "abcdef0123456789abcdef0123456789.json");
    const record = JSON.parse(await fs.readFile(filename, "utf8"));
    await fs.writeFile(filename, JSON.stringify({ ...record, server: "yoplai", resourceUri: "ui://yoplai/file-viewer" }));
    const log = vi.spyOn(console, "log");
    try {
      const response = await post(alice, route.replace("owned-chat", sessionId) + "/rpc", { jsonrpc: "2.0", id: "file-context", method: "ui/update-model-context", params: { content: [{ type: "text", text: "Private file selection" }] } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: "file-context", error: { code: -32601, message: "Method not found" } });
      const lines = log.mock.calls.flatMap(([line]) => typeof line === "string" && line.startsWith("{") ? [JSON.parse(line)] : []);
      expect(lines.filter((line) => line.msg === "MCP Apps operation" && line.session === sessionId)).toEqual([
        expect.objectContaining({ server: "yoplai", method: "ui/update-model-context", outcome: "method_not_found" }),
      ]);
      expect(JSON.stringify(lines)).not.toContain("Private file selection");
    } finally { log.mockRestore(); }
  });

  // ALG-600 seam approval: 9de9b656-b0db-413c-8e8f-6707c6aece4d.
  it("stores the latest normalized view context through authenticated RPC without changing user history", async () => {
    const contexts = await import("./view-context.js");
    const scope = { agentId: "main", sessionId: "owned-chat", ownerUserId: alice.id };
    const response = await post(alice, route + "/rpc", { jsonrpc: "2.0", id: "context", method: "ui/update-model-context", params: { content: [{ type: "text", text: "  card 17  " }, { type: "text", text: "  " }, { type: "text", text: " detail " }, { type: "image", data: "AA==", mimeType: "image/png" }, { type: "audio", data: "AA==", mimeType: "audio/wav" }, { type: "resource_link", uri: "file:///note", name: "Note" }, { type: "resource", resource: { uri: "file:///note", text: "ignored resource" } }], structuredContent: { selected: 17 } } });
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: "context", result: {} });
    expect(contexts.snapshot(scope)).toEqual([{ viewKey: "private-boards\nui://boards/private", value: 'card 17\n\ndetail\n\n{"selected":17}' }]);
    for (const viewer of [bob, admin]) expect((await post(viewer, route + "/rpc", { jsonrpc: "2.0", id: 9, method: "ui/update-model-context", params: {} })).status).toBe(404);
    expect((await post(alice, route.replace("owned-chat", "wrong-owner") + "/rpc", { jsonrpc: "2.0", id: 9, method: "ui/update-model-context", params: {} })).status).toBe(404);
    await post(alice, route + "/rpc", { jsonrpc: "2.0", id: 2, method: "ui/update-model-context", params: { content: [{ type: "text", text: "latest" }] } });
    expect(contexts.snapshot(scope)).toEqual([{ viewKey: "private-boards\nui://boards/private", value: "latest" }]);
    await post(alice, route + "/rpc", { jsonrpc: "2.0", id: 3, method: "ui/update-model-context", params: { content: [{ type: "text", text: " \n " }] } });
    expect(contexts.snapshot(scope)).toEqual([]);
    expect(await fs.readFile(path.join(home, "sessions", "users", alice.id, "history", "2026-10-24T12-00-00-000Z_main-owned-chat.jsonl"), "utf8")).toBe("");
  });

  it("rejects malformed context before replacing the previous selection", async () => {
    const contexts = await import("./view-context.js");
    const scope = { agentId: "main", sessionId: "owned-chat", ownerUserId: alice.id };
    const key = "private-boards\nui://boards/private";
    contexts.set(scope, key, "keep me");
    for (const params of [null, [], "text", { content: {} }, { content: [null] }, { content: [{}] }, { content: [{ type: "image" }] }, { content: [{ type: "audio", data: 17, mimeType: "audio/wav" }] }, { content: [{ type: "resource", resource: null }] }, { content: [{ type: "resource_link", uri: "ui://foo" }] }, { content: [{ type: "unknown" }] }, { content: [{ type: "text" }] }, { content: [{ type: "text", text: 17 }] }, { structuredContent: null }, { structuredContent: [] }, { structuredContent: "text" }]) {
      const reply = await (await post(alice, route + "/rpc", { jsonrpc: "2.0", id: 4, method: "ui/update-model-context", params })).json();
      expect(reply).toEqual({ jsonrpc: "2.0", id: 4, error: { code: -32602, message: "Invalid params" } });
      expect(contexts.snapshot(scope)).toEqual([{ viewKey: key, value: "keep me" }]);
    }
    contexts.clearSession(scope);
  });

  it("caps normalized UTF-8 context at 16 KiB and keeps the previous accepted value", async () => {
    const contexts = await import("./view-context.js");
    const scope = { agentId: "main", sessionId: "owned-chat", ownerUserId: alice.id };
    const boundary = "é".repeat(8192);
    const send = (text: string) => post(alice, route + "/rpc", { jsonrpc: "2.0", id: "bytes", method: "ui/update-model-context", params: { content: [{ type: "text", text }] } });
    expect(await (await send(boundary)).json()).toEqual({ jsonrpc: "2.0", id: "bytes", result: {} });
    expect(await (await send(boundary + "x")).json()).toEqual({ jsonrpc: "2.0", id: "bytes", error: { code: -32602, message: "Context exceeds 16 KiB" } });
    expect(contexts.snapshot(scope)).toEqual([{ viewKey: "private-boards\nui://boards/private", value: boundary }]);
    contexts.clearSession(scope);
  });

  it("clears model context when its authenticated session is deleted", async () => {
    const contexts = await import("./view-context.js");
    const sessionId = "delete-context";
    await seed(alice.id, sessionId, alice.id);
    const scope = { agentId: "main", sessionId, ownerUserId: alice.id };
    await post(alice, route.replace("owned-chat", sessionId) + "/rpc", { jsonrpc: "2.0", id: 5, method: "ui/update-model-context", params: { content: [{ type: "text", text: "delete this selection" }] } });
    expect(contexts.snapshot(scope)).toHaveLength(1);
    const response = await fetch(gatewayUrl + "/api/agents/main/sessions/" + sessionId, { method: "DELETE", headers: { Cookie: alice.cookie, Origin: "http://localhost:3000" } });
    expect(response.status).toBe(200);
    expect(contexts.snapshot(scope)).toEqual([]);
  });

  it("cannot recreate model context when the session is deleted while its RPC body is arriving", async () => {
    const contexts = await import("./view-context.js");
    const sessionId = "delete-context-pending";
    await seed(alice.id, sessionId, alice.id);
    const scope = { agentId: "main", sessionId, ownerUserId: alice.id };
    const body = JSON.stringify({ jsonrpc: "2.0", id: "late-context", method: "ui/update-model-context", params: { content: [{ type: "text", text: "must stay deleted" }] } });
    let outgoing!: ClientRequest;
    const pending = new Promise<unknown>((resolve, reject) => {
      outgoing = httpRequest(gatewayUrl + route.replace("owned-chat", sessionId) + "/rpc", {
        method: "POST", headers: { Cookie: alice.cookie, Origin: "http://localhost:3000", "content-type": "application/json" },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch (error) { reject(error); }
        });
      });
      outgoing.on("error", reject);
    });
    try {
      await new Promise<void>((resolve, reject) => outgoing.write(body.slice(0, -1), (error) => error ? reject(error) : resolve()));
      // Leave the owned request waiting for its final JSON byte before deletion.
      await delay(50);
      const deleted = await fetch(gatewayUrl + "/api/agents/main/sessions/" + sessionId, { method: "DELETE", headers: { Cookie: alice.cookie, Origin: "http://localhost:3000" } });
      expect(deleted.status).toBe(200);
      outgoing.end(body.slice(-1));
      const result = await pending;
      expect(contexts.snapshot(scope)).toEqual([]);
      expect(result).toEqual({ jsonrpc: "2.0", id: "late-context", error: { code: -32000, message: "Session deleted" } });
    } finally { outgoing.destroy(); }
  });

  it("audits context byte size and outcome without recording its text", async () => {
    const log = vi.spyOn(console, "log");
    try {
      for (const text of ["AUDIT-ONLY", "z".repeat(16385)]) await post(alice, route + "/rpc", { jsonrpc: "2.0", id: "audit", method: "ui/update-model-context", params: { content: [{ type: "text", text }] } });
      const lines = log.mock.calls.flatMap(([line]) => typeof line === "string" && line.startsWith("{") ? [JSON.parse(line)] : []);
      const audits = lines.filter((line) => line.msg === "MCP Apps operation" && line.method === "ui/update-model-context");
      expect(audits).toEqual([
        expect.objectContaining({ size: 10, outcome: "set" }),
        expect.objectContaining({ size: 16385, outcome: "too_large" }),
      ]);
      expect(JSON.stringify(audits)).not.toContain("AUDIT-ONLY");
      expect(JSON.stringify(audits)).not.toContain("zzzz");
    } finally { log.mockRestore(); }
    const contexts = await import("./view-context.js");
    contexts.clearSession({ agentId: "main", sessionId: "owned-chat", ownerUserId: alice.id });
  });

  it("refuses view, data, RPC and log operations during real admin impersonation", async () => {
    const started = await post(admin, "/api/admin/impersonate/start", { targetUserId: alice.id });
    expect(started.status).toBe(204);
    const before = calls.length;
    try {
      for (const operation of ["view", "data", "rpc", "log"]) {
        const response = await post(admin, route + "/" + operation, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "edit_board" } });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "read_only_impersonation" });
      }
      expect(calls).toHaveLength(before);
    } finally { await post(admin, "/api/admin/impersonate/end"); }
  });

});
