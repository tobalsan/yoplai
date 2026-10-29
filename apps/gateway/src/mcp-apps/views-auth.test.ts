import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net, { type AddressInfo } from "node:net";
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

  it("refuses view, RPC and log operations during real admin impersonation", async () => {
    const started = await post(admin, "/api/admin/impersonate/start", { targetUserId: alice.id });
    expect(started.status).toBe(204);
    const before = calls.length;
    try {
      for (const operation of ["view", "rpc", "log"]) {
        const response = await post(admin, route + "/" + operation, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "edit_board" } });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "read_only_impersonation" });
      }
      expect(calls).toHaveLength(before);
    } finally { await post(admin, "/api/admin/impersonate/end"); }
  });

});
