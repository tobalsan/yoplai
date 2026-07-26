import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import { createOAuthRoutes } from "./routes.js";
import { OAuthService } from "./service.js";
import { OAuthConnectionStore } from "./store.js";
import { TokenCipher } from "./crypto.js";

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-routes-"));
    store = new OAuthConnectionStore(tmpDir, new TokenCipher("routes-test-key"));
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
          JSON.stringify({ access_token: "A1", expires_in: 3600, token_type: "Bearer" }),
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

    const authorizeRes = await app.request(
      "/oauth/google/authorize?agent=a1"
    );
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
  });

  it("authorize requires an agent query param", async () => {
    const app = createOAuthRoutes(
      new OAuthService({ store, loadConfig: makeConfig })
    );
    const res = await app.request("/oauth/google/authorize");
    expect(res.status).toBe(400);
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
  });

  it("callback surfaces a provider error page without throwing", async () => {
    const app = createOAuthRoutes(
      new OAuthService({ store, loadConfig: makeConfig })
    );
    const res = await app.request("/oauth/google/callback?error=access_denied");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("access_denied");
  });
});
