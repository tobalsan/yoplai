import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import type { GatewayConfig } from "@yoplai/shared";
import { createOAuthRoutes } from "./routes.js";
import { OAuthService } from "./service.js";
import { OAuthConnectionStore } from "./store.js";
import { TokenCipher } from "./crypto.js";
const audit = vi.hoisted(() => vi.fn());
vi.mock("../audit/store.js", () => ({ recordSettingsChange: audit, getAuditActor: async () => ({ actorUserId: "alice", actorEmail: "alice@example.com", impersonatorUserId: "admin" }) }));

function makeConfig(): GatewayConfig {
  return {
    agents: [],
    extensions: {},
    oauth: {
      redirectBaseUrl: "http://localhost:4000",
      providers: { google: { clientId: "cid", clientSecret: "csecret" } },
    },
  } as unknown as GatewayConfig;
}

describe("oauth routes", () => {
  let tmpDir: string;
  let store: OAuthConnectionStore;

  beforeEach(() => {
    audit.mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-routes-"));
    store = new OAuthConnectionStore(
      tmpDir,
      new TokenCipher("routes-test-key")
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("authorize redirects to Google, then callback exchanges the code → connected", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes("token")) {
        return new Response(
          JSON.stringify({
            access_token: "A1",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ email: "alice@example.com" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const service = new OAuthService({
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadConfig: makeConfig,
    });
    const app = createOAuthRoutes(service);

    const authorizeRes = await app.request("/oauth/google/authorize?agent=a1&scope=team");
    expect(authorizeRes.status).toBe(302);
    const location = authorizeRes.headers.get("location")!;
    const state = new URL(location).searchParams.get("state")!;
    expect(location).toContain("accounts.google.com");

    const callbackRes = await app.request(
      `/oauth/google/callback?code=code-1&state=${state}`
    );
    expect(callbackRes.status).toBe(200);
    const html = await callbackRes.text();
    expect(html).toContain("Connected");
    expect(html).toContain("alice@example.com");

    expect(store.get("a1", "google")?.accessToken).toBe("A1");
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({ actorUserId: "alice", actorEmail: "alice@example.com", impersonatorUserId: "admin", action: "oauth.connect", agentId: "a1", targetType: "oauth", targetId: "google", scope: "team", changes: [{ field: "credentials", secret: "set" }] });
  });

  it("authorize requires an agent query param", async () => {
    const app = createOAuthRoutes(
      new OAuthService({ store, loadConfig: makeConfig })
    );
    const res = await app.request("/oauth/google/authorize");
    expect(res.status).toBe(400);
  });

  it("returns to the originating page after connecting, keeping its query and hash", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("token") ? { access_token: "A1", expires_in: 3600 } : { email: "alice@example.com" }
    ), { headers: { "Content-Type": "application/json" } }));
    const app = createOAuthRoutes(new OAuthService({ store, fetchImpl, loadConfig: makeConfig }));
    const authorization = await app.request(`/oauth/google/authorize?agent=a1&scope=team&returnTo=${encodeURIComponent("/agents/a1/extensions/google?view=settings#permissions")}`);
    const state = new URL(authorization.headers.get("location")!).searchParams.get("state");
    const callback = await app.request(`/oauth/google/callback?code=code-1&state=${state}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/agents/a1/extensions/google?view=settings&oauth=connected&oauth_scope=team#permissions");
  });

  it("returns a provider denial to the selected personal page and consumes the state", async () => {
    const app = createOAuthRoutes(new OAuthService({ store, loadConfig: makeConfig }), undefined, async () => "alice");
    const authorization = await app.request("/oauth/google/authorize?agent=a1&scope=personal&returnTo=%2Fconnections%3Fagent%3Da1");
    const state = new URL(authorization.headers.get("location")!).searchParams.get("state");
    const callback = await app.request(`/oauth/google/callback?error=access_denied&state=${state}`);
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location")!, "https://yoplai.invalid");
    expect(location.pathname).toBe("/connections");
    expect(location.searchParams.get("agent")).toBe("a1");
    expect(location.searchParams.get("oauth")).toBe("error");
    expect(location.searchParams.get("oauth_scope")).toBe("personal");
    expect(location.searchParams.get("oauth_error")).toContain("access_denied");
    const replay = await app.request(`/oauth/google/callback?error=access_denied&state=${state}`);
    expect(replay.status).toBe(400);
    expect(replay.headers.get("location")).toBeNull();
    expect(await replay.text()).toContain("Invalid or expired OAuth state");
  });

  it.each(["https://evil.example", "//evil.example", "/\t/evil.example", "/\n/evil.example", "/\\evil.example", "/agents/a1\u0000", "/safe/..//nested.example//evil.example"])("ignores unsafe return paths: %j", async (returnTo) => {
    const app = createOAuthRoutes(new OAuthService({ store, loadConfig: makeConfig }));
    const authorization = await app.request(`/oauth/google/authorize?agent=a1&scope=team&returnTo=${encodeURIComponent(returnTo)}`);
    const state = new URL(authorization.headers.get("location")!).searchParams.get("state");
    const callback = await app.request(`/oauth/google/callback?error=access_denied&state=${state}`);
    expect(callback.status).toBe(400);
    expect(callback.headers.get("location")).toBeNull();
    expect(await callback.text()).toContain("access_denied");
  });

  it("returns an exchange failure to the originating page without making the state reusable", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "The authorization code expired" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    }));
    const app = createOAuthRoutes(new OAuthService({ store, fetchImpl, loadConfig: makeConfig }));
    const authorization = await app.request("/oauth/google/authorize?agent=a1&scope=team&returnTo=%2Fagents%2Fa1%2Fedit");
    const state = new URL(authorization.headers.get("location")!).searchParams.get("state");
    const callback = await app.request(`/oauth/google/callback?code=expired&state=${state}`);
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location")!, "https://yoplai.invalid");
    expect(location.pathname).toBe("/agents/a1/edit");
    expect(location.searchParams.get("oauth")).toBe("error");
    expect(location.searchParams.get("oauth_scope")).toBe("team");
    expect(location.searchParams.get("oauth_error")).toContain("The authorization code expired");
    const replay = await app.request(`/oauth/google/callback?code=expired&state=${state}`);
    expect(replay.status).toBe(400);
    expect(replay.headers.get("location")).toBeNull();
    expect(await replay.text()).toContain("Invalid or expired OAuth state");
  });

  it("rejects callbacks from another provider without consuming or revealing the return page", async () => {
    const app = createOAuthRoutes(new OAuthService({ store, loadConfig: makeConfig }));
    const authorization = await app.request("/oauth/google/authorize?agent=a1&scope=team&returnTo=%2Fconnections");
    const state = new URL(authorization.headers.get("location")!).searchParams.get("state");
    for (const result of ["code=wrong-provider", "error=access_denied"]) {
      const callback = await app.request(`/oauth/zendesk/callback?${result}&state=${state}`);
      expect(callback.status).toBe(400);
      expect(callback.headers.get("location")).toBeNull();
      expect(await callback.text()).toContain("OAuth provider mismatch for state");
    }
    const callback = await app.request(`/oauth/google/callback?error=access_denied&state=${state}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("/connections?oauth=error");
  });

  it("keeps the popup result when a provider denies a flow without a return page", async () => {
    const app = createOAuthRoutes(new OAuthService({ store, loadConfig: makeConfig }));
    const authorization = await app.request("/oauth/google/authorize?agent=a1&scope=team");
    const state = new URL(authorization.headers.get("location")!).searchParams.get("state");
    const callback = await app.request(`/oauth/google/callback?error=access_denied&state=${state}`);
    expect(callback.status).toBe(400);
    expect(callback.headers.get("location")).toBeNull();
    expect(await callback.text()).toContain("You can close this window and return to Yoplai.");
  });

  it("offers Just me and Whole team when a connect link has no scope", async () => {
    const app = createOAuthRoutes(new OAuthService({ store, loadConfig: makeConfig }), undefined, async () => "alice");
    const response = await app.request("/oauth/google/authorize?agent=a1");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Just me");
  });

  it("keeps the return page through either scope choice", async () => {
    const app = createOAuthRoutes(new OAuthService({ store, loadConfig: makeConfig }), undefined, async () => "alice");
    const response = await app.request("/oauth/google/authorize?agent=a1&returnTo=%2Fconnections%3Fagent%3Da1%23google");
    const document = new JSDOM(await response.text()).window.document;
    for (const label of ["Just me", "Whole team"]) {
      const link = Array.from(document.links).find((entry) => entry.textContent === label)!;
      const authorization = await app.request(link.getAttribute("href")!.replace(/^\/api/, ""));
      const state = new URL(authorization.headers.get("location")!).searchParams.get("state");
      const callback = await app.request(`/oauth/google/callback?error=access_denied&state=${state}`);
      expect(callback.status).toBe(302);
      const location = new URL(callback.headers.get("location")!, "https://yoplai.invalid");
      expect(location.pathname).toBe("/connections");
      expect(location.searchParams.get("agent")).toBe("a1");
      expect(location.searchParams.get("oauth_scope")).toBe(label === "Just me" ? "personal" : "team");
      expect(location.hash).toBe("#google");
    }
  });

  it("restricts team connections to callers allowed to configure the team", async () => {
    const app = createOAuthRoutes(new OAuthService({ store, loadConfig: makeConfig }), undefined, async () => "alice", async () => false);
    const page = await (await app.request("/oauth/google/authorize?agent=a1")).text();
    expect(page).toContain("Just me");
    expect(page).not.toContain("Whole team");
    expect((await app.request("/oauth/google/authorize?agent=a1&scope=team")).status).toBe(403);
    expect((await app.request("/oauth/google/disconnect?agent=a1&scope=team", { method: "POST" })).status).toBe(403);
    expect(await (await app.request("/oauth/google/status?agent=a1&scope=personal")).json()).toMatchObject({ canConfigureTeam: false });
  });

  it("checks team connection permission for the requested agent while personal connections remain usable", async () => {
    const app = createOAuthRoutes(
      new OAuthService({ store, loadConfig: makeConfig }),
      undefined,
      async () => "admin",
      async (_c, agentId) => agentId === "owned"
    );
    for (const [agent, canManage, authorizeStatus, disconnectStatus] of [["foreign", false, 403, 403], ["owned", true, 302, 200]] as const) {
      expect(await (await app.request(`/oauth/google/status?agent=${agent}&scope=personal`)).json()).toMatchObject({ canConfigureTeam: canManage });
      const page = await (await app.request(`/oauth/google/authorize?agent=${agent}`)).text();
      expect(page.includes("Whole team")).toBe(canManage);
      expect((await app.request(`/oauth/google/authorize?agent=${agent}&scope=team`)).status).toBe(authorizeStatus);
      expect((await app.request(`/oauth/google/disconnect?agent=${agent}&scope=team`, { method: "POST" })).status).toBe(disconnectStatus);
      expect((await app.request(`/oauth/google/authorize?agent=${agent}&scope=personal`)).status).toBe(302);
      expect((await app.request(`/oauth/google/disconnect?agent=${agent}&scope=personal`, { method: "POST" })).status).toBe(200);
    }
  });

  it("binds personal callback ownership to the authenticated initiator, never query userId", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("token") ? { access_token: "alice-token", expires_in: 3600 } : { email: "alice@example.com" }
    ), { headers: { "Content-Type": "application/json" } }));
    const service = new OAuthService({ store, fetchImpl, loadConfig: makeConfig });
    const app = createOAuthRoutes(service, undefined, async (c) => c.req.header("test-user"));
    const authorization = await app.request("/oauth/google/authorize?agent=a1&scope=personal&userId=bob", {
      headers: { "test-user": "alice" },
    });
    const state = new URL(authorization.headers.get("location")!).searchParams.get("state");
    expect((await app.request(`/oauth/google/callback?code=dummy&state=${state}&userId=bob`)).status).toBe(200);
    expect(service.getConnection("a1", "google", "alice")?.account).toBe("alice@example.com");
    expect(service.getConnection("a1", "google", "bob")).toBeUndefined();
    const bob = await app.request("/oauth/google/status?agent=a1", { headers: { "test-user": "bob" } });
    expect(await bob.json()).toMatchObject({ connected: false });
    const alice = await app.request("/oauth/google/status?agent=a1&scope=personal", { headers: { "test-user": "alice" } });
    expect(await alice.json()).toMatchObject({ connected: true, scope: "personal", account: "alice@example.com" });
    await app.request("/oauth/google/disconnect?agent=a1&scope=personal&userId=alice", { method: "POST", headers: { "test-user": "bob" } });
    expect(service.getConnection("a1", "google", "alice")).toBeDefined();
  });

  it("requires a user account for personal operations and rejects invalid scopes", async () => {
    const app = createOAuthRoutes(new OAuthService({ store, loadConfig: makeConfig }));
    for (const [operation, method] of [["authorize", "GET"], ["status", "GET"], ["disconnect", "POST"]] as const) {
      const personal = await app.request(`/oauth/google/${operation}?agent=a1&scope=personal`, { method });
      expect(personal.status).toBe(401);
      expect(await personal.json()).toEqual({ error: "personal_requires_login" });
      const invalid = await app.request(`/oauth/google/${operation}?agent=a1&scope=other`, { method });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "invalid_scope" });
    }
  });

  it("status reports connected after a saved connection", async () => {
    store.save({
      agentId: "a1",
      provider: "google",
      accessToken: "A1",
      account: "alice@example.com",
      scopes: [],
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const app = createOAuthRoutes(
      new OAuthService({ store, loadConfig: makeConfig })
    );
    const res = await app.request("/oauth/google/status?agent=a1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      connected: boolean;
      account?: string;
    };
    expect(body.state).toBe("connected");
    expect(body.connected).toBe(true);
    expect(body.account).toBe("alice@example.com");
  });

  it("status surfaces a first-class needs_reconnect state", async () => {
    store.save({
      agentId: "a1",
      provider: "google",
      accessToken: "A1",
      account: "alice@example.com",
      scopes: [],
      status: "needs_reconnect",
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const app = createOAuthRoutes(
      new OAuthService({ store, loadConfig: makeConfig })
    );
    const res = await app.request("/oauth/google/status?agent=a1");
    const body = (await res.json()) as { state: string; connected: boolean };
    // needs_reconnect is distinct from connected: the account is retained but
    // `connected` is false so the agent gets the clean not-connected signal.
    expect(body.state).toBe("needs_reconnect");
    expect(body.connected).toBe(false);
  });

  it("status reports disconnected when nothing is stored", async () => {
    const app = createOAuthRoutes(
      new OAuthService({ store, loadConfig: makeConfig })
    );
    const res = await app.request("/oauth/google/status?agent=a1");
    const body = (await res.json()) as { state: string; connected: boolean };
    expect(body.state).toBe("disconnected");
    expect(body.connected).toBe(false);
  });

  it("disconnect clears the connection and returns disconnected", async () => {
    store.save({
      agentId: "a1",
      provider: "google",
      accessToken: "A1",
      scopes: [],
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const app = createOAuthRoutes(
      new OAuthService({
        store,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        loadConfig: makeConfig,
      })
    );
    const res = await app.request("/oauth/google/disconnect?agent=a1", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; connected: boolean };
    expect(body.state).toBe("disconnected");
    expect(store.get("a1", "google")).toBeUndefined();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({ actorUserId: "alice", actorEmail: "alice@example.com", impersonatorUserId: "admin", action: "oauth.disconnect", agentId: "a1", targetType: "oauth", targetId: "google", scope: "team", changes: [{ field: "credentials", secret: "removed" }] });
    await app.request("/oauth/google/disconnect?agent=a1", { method: "POST" });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("gates agent-scoped OAuth operations through the host access policy", async () => {
    store.save({
      agentId: "a1",
      provider: "google",
      accessToken: "A1",
      scopes: [],
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const canAccessAgent = vi.fn(async () => false);
    const app = createOAuthRoutes(
      new OAuthService({ store, loadConfig: makeConfig }),
      canAccessAgent
    );

    for (const [url, method] of [
      ["/oauth/google/authorize?agent=a1", "GET"],
      ["/oauth/google/status?agent=a1", "GET"],
      ["/oauth/google/disconnect?agent=a1", "POST"],
    ] as const) {
      const res = await app.request(url, { method });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }

    expect(canAccessAgent).toHaveBeenCalledTimes(3);
    expect(store.get("a1", "google")).toBeDefined();
  });

  it("callback surfaces a provider error page without throwing", async () => {
    const app = createOAuthRoutes(
      new OAuthService({ store, loadConfig: makeConfig })
    );
    const res = await app.request("/oauth/google/callback?error=access_denied");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("access_denied");
  });

  it("reports a personal grant connected on sally as connected on cira", async () => {
    const service = new OAuthService({ store, loadConfig: makeConfig });
    store.save({
      agentId: "sally", provider: "google", scope: "personal", userId: "alice", accessToken: "t",
      scopes: [], account: "alice@example.com", connectedAt: 1, updatedAt: 1,
    });
    const app = createOAuthRoutes(service, undefined, async (c) => c.req.header("test-user"));
    const status = await app.request("/oauth/google/status?agent=cira&scope=personal", { headers: { "test-user": "alice" } });
    expect(await status.json()).toMatchObject({ connected: true, scope: "personal", account: "alice@example.com" });
    const bob = await app.request("/oauth/google/status?agent=cira&scope=personal", { headers: { "test-user": "bob" } });
    expect(await bob.json()).toMatchObject({ connected: false });
  });

  it("reports disconnected on every agent after a personal disconnect", async () => {
    const service = new OAuthService({ store, fetchImpl: vi.fn(async () => new Response(null, { status: 200 })), loadConfig: makeConfig });
    store.save({
      agentId: "sally", provider: "google", scope: "personal", userId: "alice", accessToken: "t",
      scopes: [], connectedAt: 1, updatedAt: 1,
    });
    const app = createOAuthRoutes(service, undefined, async (c) => c.req.header("test-user"));
    const headers = { "test-user": "alice" };
    await app.request("/oauth/google/disconnect?agent=cira&scope=personal", { method: "POST", headers });
    for (const agent of ["sally", "cira"]) {
      const status = await app.request(`/oauth/google/status?agent=${agent}&scope=personal`, { headers });
      expect(await status.json()).toMatchObject({ connected: false });
    }
  });
});
