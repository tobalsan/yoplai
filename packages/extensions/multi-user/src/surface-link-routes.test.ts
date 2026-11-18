import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayConfigSchema, getSurfaceLinkService, registerSurfaceIdentityProvider, type ExtensionContext } from "@yoplai/shared";
import { multiUserExtension } from "./index.js";
import { createAuthMiddleware } from "./middleware.js";

describe("surface linking HTTP routes", () => {
  let dataDir: string;
  let app: Hono;
  let api: Hono;
  let unregister: () => void;
  const baseUrl = "http://127.0.0.1:4999";
  const identity = { surface: "threadit" as const, scope: "https://board.example.test", externalId: "17", username: "<alice>" };
  const tokenFrom = (url: string) => new URL(url).pathname.split("/").at(-1)!;
  const request = (url: string, init?: RequestInit) => app.request(new URL(url, baseUrl).href, init);
  const signup = async (name: string) => {
    const response = await request("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ name, email: `${name}@example.test`, password: "surface-link-test-password" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { user: { id: string; email: string } };
    return { user: body.user, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
  };

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-surface-routes-"));
    const config = GatewayConfigSchema.parse({ agents: [], server: { baseUrl }, gateway: { port: 4999 }, ui: { port: 4999 }, extensions: {
      multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: "surface-link-tests-secret-at-least-32-chars" },
    } });
    const context: ExtensionContext = {
      getConfig: () => config, getDataDir: () => dataDir, getAgent: () => undefined, getAgents: () => [],
      reloadConfig() {}, isAgentActive: () => true, isAgentStreaming: () => false, resolveWorkspaceDir: () => dataDir,
      runAgent: async () => ({ payloads: [], meta: { durationMs: 0, sessionId: "unused" } }), getSubagentTemplates: () => [],
      resolveSessionId: async () => undefined, getSessionEntry: async () => undefined, clearSessionEntry: async () => undefined,
      restoreSessionUpdatedAt() {}, deleteSession() {}, hasSession: async () => false, resetSession: async () => {},
      ensureSession: async () => { throw new Error("unused"); }, invalidateHistoryCache: async () => {}, getSessionHistory: async () => [],
      registerDeliverySink: () => () => {}, getDeliverySink: () => undefined, registerUserNotifier: () => () => {}, getUserNotifiers: () => new Map(),
      subscribe: () => () => {}, emit() {}, logger: { info() {}, warn() {}, error() {} },
    };
    await multiUserExtension.start(context);
    unregister = registerSurfaceIdentityProvider({ ...identity, lookup: async () => ({ username: "<alice>", email: "alice@example.test", isAgent: false }) });
    app = new Hono();
    app.use("/api/*", createAuthMiddleware());
    api = new Hono();
    multiUserExtension.registerRoutes!(api);
    app.route("/api", api);
  });
  afterEach(async () => {
    unregister();
    await multiUserExtension.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("shows sign-in for a public pairing link and returns to the same token", async () => {
    const service = getSurfaceLinkService()!;
    const url = await service.issue(identity);
    const response = await request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await response.text();
    expect(html).toContain("&lt;alice&gt;");
    expect(html).toContain("Sign in");
    expect(html).toContain(`returnTo=%2Fapi%2Fsurface-links%2Fpair%2F${tokenFrom(url)}`);
    expect(service.resolve("threadit", identity.scope, "17")).toBeUndefined();
  });
  it("connects the signed-in email only after confirmation and rejects link reuse", async () => {
    const alice = await signup("alice");
    const service = getSurfaceLinkService()!;
    const url = await service.issue(identity);
    const page = await request(url, { headers: { cookie: alice.cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("alice@example.test");
    expect(service.resolve("threadit", identity.scope, "17")).toBeUndefined();
    const init = { method: "POST", headers: { cookie: alice.cookie, origin: baseUrl } };
    const response = await request(url, init);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Connected. Return to Threadit and retry your message.");
    expect(service.resolve("threadit", identity.scope, "17")).toBe(alice.user.id);
    expect((await request(url, init)).status).toBe(400);
  });
  it("lists and unlinks only the caller's accounts", async () => {
    const alice = await signup("alice");
    const bob = await signup("bob");
    const service = getSurfaceLinkService()!;
    await service.redeem(tokenFrom(await service.issue(identity)), alice.user);
    const list = "/api/surface-links";
    const aliceHeaders = { cookie: alice.cookie };
    const response = await request(list, { headers: aliceHeaders });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { links: Array<{ id: string; surface: string; username: string }> };
    expect(body.links).toMatchObject([{ surface: "threadit", username: "<alice>" }]);
    expect(await (await request(list, { headers: { cookie: bob.cookie } })).json()).toEqual({ links: [] });
    const path = list + "/" + body.links[0]!.id;
    expect((await request(path, { method: "DELETE", headers: { cookie: bob.cookie, origin: baseUrl } })).status).toBe(200);
    expect(service.resolve("threadit", identity.scope, "17")).toBe(alice.user.id);
    expect((await request(path, { method: "DELETE", headers: { ...aliceHeaders, origin: baseUrl } })).status).toBe(200);
    expect(service.resolve("threadit", identity.scope, "17")).toBeUndefined();
    expect(await (await request(list, { headers: aliceHeaders })).json()).toEqual({ links: [] });
  });
  it("lists and unlinks for a verified bearer with no cookie and no Origin", async () => {
    const alice = await signup("alice");
    const service = getSurfaceLinkService()!;
    await service.redeem(tokenFrom(await service.issue(identity)), alice.user);
    const linked = new Hono();
    linked.use("*", async (c, next) => {
      c.set("multiUserAuthContext", { user: { id: alice.user.id } });
      c.set("multiUserBearerVerified", true);
      await next();
    });
    linked.route("/api", api);
    const list = await linked.request(new URL("/api/surface-links", baseUrl).href);
    expect(list.status).toBe(200);
    const { links } = await list.json() as { links: Array<{ id: string }> };
    expect(links).toHaveLength(1);
    expect((await linked.request(new URL(`/api/surface-links/${links[0]!.id}`, baseUrl).href, { method: "DELETE" })).status).toBe(200);
    expect(service.list(alice.user.id)).toEqual([]);
    // A request with no verified bearer still needs a session and a trusted Origin.
    expect((await request("/api/surface-links/x", { method: "DELETE" })).status).toBe(401);
  });
  it("requires login and trusted origins for redeem and unlink", async () => {
    const alice = await signup("alice");
    const service = getSurfaceLinkService()!;
    const url = await service.issue(identity);
    expect((await request("/api/surface-links")).status).toBe(401);
    expect((await request(url, { method: "POST" })).status).toBe(401);
    for (const origin of ["https://foreign.example.test", "null", ""]) {
      expect((await request(url, { method: "POST", headers: { cookie: alice.cookie, origin } })).status).toBe(403);
    }
    expect(service.resolve("threadit", identity.scope, "17")).toBeUndefined();
    await request(url, { method: "POST", headers: { cookie: alice.cookie, origin: baseUrl } });
    const id = service.list(alice.user.id)[0]!.id;
    expect((await request("/api/surface-links/" + id, { method: "DELETE", headers: { cookie: alice.cookie, origin: "https://foreign.example.test" } })).status).toBe(403);
    expect(service.resolve("threadit", identity.scope, "17")).toBe(alice.user.id);
  });
  it("checks current account eligibility despite an older approved session", async () => {
    const admin = await signup("admin");
    const alice = await signup("alice");
    const service = getSurfaceLinkService()!;
    const url = await service.issue(identity);
    const update = await request("/api/admin/users/" + alice.user.id, {
      method: "PATCH", headers: { cookie: admin.cookie, "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ approved: false }),
    });
    expect(update.status).toBe(200);
    expect((await request(url, { headers: { cookie: alice.cookie } })).status).toBe(403);
    expect((await request(url, { method: "POST", headers: { cookie: alice.cookie, origin: baseUrl } })).status).toBe(403);
    expect((await request("/api/surface-links", { headers: { cookie: alice.cookie } })).status).toBe(403);
    expect(service.resolve("threadit", identity.scope, "17")).toBeUndefined();
  });
  it("explains a mismatched or stale link and leaves a mismatch available to its owner", async () => {
    const bob = await signup("bob");
    const service = getSurfaceLinkService()!;
    const url = await service.issue(identity);
    const response = await request(url, { method: "POST", headers: { cookie: bob.cookie, origin: baseUrl } });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("This link was created for another Threadit account.");
    expect(service.inspect(tokenFrom(url))).toMatchObject({ externalId: "17" });
    const stale = await request("/api/surface-links/pair/" + "a".repeat(43));
    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain("expired or already been used");
  });
});
