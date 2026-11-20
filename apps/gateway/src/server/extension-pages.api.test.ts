import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Context } from "hono";
import type { Extension, ExtensionContext } from "@yoplai/shared";
import { writeTestV3Config } from "../test-utils/v3-config.js";

// ALG-708 Testing Decisions and Groom GO f321c105 approve the page-route HTTP
// seam: catches host mounting/authentication, misses browser sandbox execution.
describe("extension browser pages", () => {
  let home: string;
  const previousHome = process.env.YOPLAI_HOME;
  let app: typeof import("./index.js").app;
  let runtime: ReturnType<typeof import("../extensions/registry.js").getExtensionRuntime>;
  let stopAuth: (() => Promise<void>) | undefined;
  let context: ExtensionContext;
  let ownerUserId: string;
  let ownerCookie: string;
  const extension: Extension = {
    id: "questionnaire", displayName: "Questionnaire", description: "Fixture", dependencies: [],
    routePrefixes: [], configSchema: z.object({}), validateConfig: () => ({ valid: true, errors: [] }),
    registerRoutes() {}, async start(ctx) { context = ctx; }, async stop() {}, capabilities: () => [],
    tokenAuthenticatedRoutes: [{ method: "POST", path: "/:id/submit" }, { method: "POST", path: "/:id/access" }],
    registerPageRoutes(routes) {
      routes.get("/:id", (c: Context) => c.json({ id: c.req.param("id"), auth: c.get("multiUserAuthContext") ?? null }));
      routes.post("/:id/submit", async (c: Context) => {
        const body = JSON.parse(await c.req.text()) as { token?: string };
        if (body.token !== "fixture-form-token") return c.json({ error: "invalid_token" }, 401);
        return c.json({ submitted: c.req.param("id"), auth: c.get("multiUserAuthContext") ?? null }, 200, { "Access-Control-Allow-Origin": "*" });
      });
      routes.post("/:id/private", (c) => c.json({ ok: true }));
      routes.post("/:id/access", async (c) => {
        const body = JSON.parse(await c.req.text()) as { token?: string; userId: string };
        if (body.token !== "fixture-form-token") return c.json({ error: "invalid_token" }, 401);
        return c.json({ allowed: await context.canUserAccessAgent?.(body.userId, "main"), prefix: context.pageRoutePrefix, frames: context.supportsFrameViews });
      });
    },
  };
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-extension-pages-"));
    process.env.YOPLAI_HOME = home;
    await writeTestV3Config(home, { agents: [{ id: "main" }], extensions: { questionnaire: {} } });
    vi.resetModules();
    const registry = await import("../extensions/registry.js");
    runtime = registry.getExtensionRuntime();
    runtime.load([extension]);
    const { bindExtensionContext, createExtensionContext } = await import("../extensions/context.js");
    const { loadConfig } = await import("../config/index.js");
    await extension.start(bindExtensionContext(createExtensionContext(loadConfig()), extension));
    ({ app } = await import("./index.js"));
  });
  afterAll(async () => {
    await runtime?.unload();
    await stopAuth?.();
    if (previousHome === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
    vi.resetModules();
  });

  it("serves extension-owned pages on the fixed prefix in single-user mode", async () => {
    const response = await app.request("/x/questionnaire/form-one");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "form-one", auth: null });
  });

  it("provides the bound page prefix, frame support and local access check", async () => {
    const response = await app.request("/x/questionnaire/form-one/access", { method: "POST", body: JSON.stringify({ token: "fixture-form-token", userId: "local" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allowed: true, prefix: "/x/questionnaire", frames: true });
  });

  it("redirects an unauthenticated page to login and forwards a signed-in viewer", async () => {
    const { loadConfig, setLoadedConfig } = await import("../config/index.js");
    const { GatewayConfigSchema } = await import("@yoplai/shared");
    const config = GatewayConfigSchema.parse({ ...loadConfig(), extensions: {
      questionnaire: {}, multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: "extension-pages-fixture-session-secret-32" },
    } });
    setLoadedConfig(config);
    const { multiUserExtension } = await import("@yoplai/extension-multi-user");
    const { createExtensionContext } = await import("../extensions/context.js");
    await multiUserExtension.start(createExtensionContext(config));
    stopAuth = () => multiUserExtension.stop();
    runtime.load([extension, multiUserExtension]);
    const { api } = await import("./api.core.js");
    multiUserExtension.registerRoutes(api);
    const response = await app.request("/x/questionnaire/form-one?focus=scope");
    expect(response.status).toBe(302);
    const login = new URL(response.headers.get("location")!, "http://localhost:3000");
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("returnTo")).toBe("/x/questionnaire/form-one?focus=scope");
    const signedUp = await app.request("http://localhost:4000/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ name: "Sample Owner", email: "owner@forms.test", password: "fixture-password-123" }),
    });
    expect(signedUp.status).toBe(200);
    const account = await signedUp.json();
    ownerUserId = account.user.id;
    const cookie = signedUp.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    ownerCookie = cookie;
    const page = await app.request("/x/questionnaire/form-one", { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ id: "form-one", auth: { user: { id: account.user.id } } });
  });

  it("lets only declared token calls bypass cookies and leaves token validation to the extension", async () => {
    const post = (path: string, token: string) => app.request(path, {
      method: "POST", headers: { "content-type": "text/plain", Origin: "null" }, body: JSON.stringify({ token }),
    });
    const submitted = await post("/x/questionnaire/form-one/submit", "fixture-form-token");
    expect(submitted.status).toBe(200);
    expect(submitted.headers.get("access-control-allow-origin")).toBe("*");
    expect(await submitted.json()).toEqual({ submitted: "form-one", auth: null });
    expect((await post("/x/questionnaire/form-one/submit", "foreign-token")).status).toBe(401);
    expect((await post("/x/questionnaire/form-one/private", "fixture-form-token")).status).toBe(401);
    expect((await app.request("/x/questionnaire/form-one/submit")).status).toBe(302);
  });

  it("re-checks current account eligibility for cookie-free token calls", async () => {
    const check = async (userId: string) => (await app.request("/x/questionnaire/form-one/access", {
      method: "POST", body: JSON.stringify({ token: "fixture-form-token", userId }),
    })).json();
    expect(await check(ownerUserId)).toMatchObject({ allowed: true });
    expect(await check("missing-viewer")).toMatchObject({ allowed: false });
    const { getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
    const db = getMultiUserRuntime()!.db;
    db.prepare("UPDATE user SET banned = 1 WHERE id = ?").run(ownerUserId);
    try {
      expect(await check(ownerUserId)).toMatchObject({ allowed: false });
    } finally {
      db.prepare("UPDATE user SET banned = 0 WHERE id = ?").run(ownerUserId);
    }
  });

  it("stops serving cached pages and token routes when the extension is disabled", async () => {
    const { loadConfig, setLoadedConfig } = await import("../config/index.js");
    const config = loadConfig();
    setLoadedConfig({ ...config, extensions: { ...config.extensions, questionnaire: { enabled: false } } });
    for (const request of [
      new Request("http://localhost/x/questionnaire/form-one"),
      new Request("http://localhost/x/questionnaire/form-one/submit", { method: "POST", body: JSON.stringify({ token: "fixture-form-token" }) }),
    ]) {
      const response = await app.request(request);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "extension_disabled", extension: "questionnaire" });
    }
    setLoadedConfig(config);
  });

  it("forwards impersonation on page reads while keeping cookie-authenticated writes read-only", async () => {
    const signedUp = await app.request("http://localhost:4000/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ name: "Sample Member", email: "member@forms.test", password: "fixture-password-123" }),
    });
    expect(signedUp.status).toBe(200);
    const member = await signedUp.json();
    const headers = { Cookie: ownerCookie, "content-type": "application/json", Origin: "http://localhost:3000" };
    expect((await app.request(`/api/admin/users/${member.user.id}`, { method: "PATCH", headers, body: JSON.stringify({ approved: true }) })).status).toBe(200);
    expect((await app.request("/api/admin/impersonate/start", { method: "POST", headers, body: JSON.stringify({ targetUserId: member.user.id }) })).status).toBe(204);
    try {
      const page = await app.request("/x/questionnaire/form-one", { headers: { Cookie: ownerCookie } });
      expect(page.status).toBe(200);
      expect(await page.json()).toMatchObject({ auth: { user: { id: member.user.id }, impersonator: { id: ownerUserId } } });
      const write = await app.request("/x/questionnaire/form-one/private", { method: "POST", headers });
      expect(write.status).toBe(403);
      expect(await write.json()).toEqual({ error: "read_only_impersonation" });
    } finally {
      expect((await app.request("/api/admin/impersonate/end", { method: "POST", headers })).status).toBe(204);
    }
  });
});
