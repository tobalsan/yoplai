import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import { OAuthService } from "./service.js";
import { OAuthConnectionStore } from "./store.js";
import { TokenCipher } from "./crypto.js";

function makeConfig(overrides: Partial<GatewayConfig["oauth"]> = {}): GatewayConfig {
  return {
    agents: [],
    extensions: {},
    oauth: {
      redirectBaseUrl: "http://localhost:4000",
      providers: {
        google: { clientId: "client-123", clientSecret: "secret-abc" },
      },
      ...overrides,
    },
  } as unknown as GatewayConfig;
}

describe("OAuthService", () => {
  let tmpDir: string;
  let store: OAuthConnectionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-test-"));
    // The store fails closed without a cipher; give it one so these service
    // tests exercise persistence (encryption itself is covered in store.test).
    store = new OAuthConnectionStore(tmpDir, new TokenCipher("service-test-key"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("startAuthorization builds a Google authorize URL with state + PKCE", async () => {
    const service = new OAuthService({
      store,
      loadConfig: () => makeConfig(),
    });

    const { authorizeUrl, state } = await service.startAuthorization({
      agentId: "a1",
      provider: "google",
    });

    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:4000/api/oauth/google/callback"
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  it("startAuthorization fails clearly when no client is configured", async () => {
    const service = new OAuthService({
      store,
      loadConfig: () => makeConfig({ providers: {} }),
    });
    await expect(
      service.startAuthorization({ agentId: "a1", provider: "google" })
    ).rejects.toThrow(/No OAuth client configured/);
  });

  it("callback exchanges the code against a faked Google token endpoint → connected", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      void _init;
      const urlStr = typeof input === "string" ? input : input.toString();
      if (urlStr.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({
            access_token: "ACCESS-1",
            refresh_token: "REFRESH-1",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/drive.readonly",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (urlStr.includes("oauth2/v2/userinfo")) {
        return new Response(JSON.stringify({ email: "alice@example.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch to ${urlStr}`);
    });

    const service = new OAuthService({
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadConfig: () => makeConfig(),
    });

    const { state } = await service.startAuthorization({
      agentId: "a1",
      provider: "google",
    });

    const connection = await service.handleCallback({
      provider: "google",
      code: "auth-code-xyz",
      state,
    });

    expect(connection.agentId).toBe("a1");
    expect(connection.provider).toBe("google");
    expect(connection.accessToken).toBe("ACCESS-1");
    expect(connection.account).toBe("alice@example.com");

    // Persisted, single connection scoped to (agent, provider).
    const stored = store.get("a1", "google");
    expect(stored?.accessToken).toBe("ACCESS-1");

    // Token exchange used the exact code + redirect + client secret.
    const tokenCall = fetchImpl.mock.calls.find((call) =>
      String(call[0]).includes("token")
    );
    const body = new URLSearchParams(
      (tokenCall?.[1] as RequestInit).body as string
    );
    expect(body.get("code")).toBe("auth-code-xyz");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_secret")).toBe("secret-abc");
    expect(body.get("code_verifier")).toBeTruthy();
  });

  it("resolves $env: refs in provider client credentials", async () => {
    process.env.OAUTH_TEST_SECRET = "resolved-secret";
    const config = makeConfig({
      providers: {
        google: { clientId: "cid", clientSecret: "$env:OAUTH_TEST_SECRET" },
      },
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      void _init;
      if (String(input).includes("token")) {
        return new Response(
          JSON.stringify({ access_token: "A1", token_type: "Bearer" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ email: "x@example.com" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const service = new OAuthService({
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadConfig: () => config,
    });
    const { state } = await service.startAuthorization({
      agentId: "a1",
      provider: "google",
    });
    await service.handleCallback({ provider: "google", code: "c", state });

    const tokenCall = fetchImpl.mock.calls.find((call) =>
      String(call[0]).includes("token")
    );
    const body = new URLSearchParams(
      (tokenCall?.[1] as RequestInit).body as string
    );
    expect(body.get("client_secret")).toBe("resolved-secret");
    delete process.env.OAUTH_TEST_SECRET;
  });

  it("callback rejects an unknown/expired state", async () => {
    const service = new OAuthService({ store, loadConfig: () => makeConfig() });
    await expect(
      service.handleCallback({ provider: "google", code: "c", state: "bogus" })
    ).rejects.toThrow(/Invalid or expired OAuth state/);
  });

  it("resolveToken returns a fresh access token when connected", async () => {
    store.save({
      agentId: "a1",
      provider: "google",
      accessToken: "ACCESS-1",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      account: "alice@example.com",
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const service = new OAuthService({ store, loadConfig: () => makeConfig() });
    const resolved = await service.resolveToken("a1", { provider: "google" });

    expect(resolved.connected).toBe(true);
    if (resolved.connected) {
      expect(resolved.accessToken).toBe("ACCESS-1");
      expect(resolved.account).toBe("alice@example.com");
    }
  });

  it("resolveToken returns not_connected (structured, not a throw) when no connection", async () => {
    const service = new OAuthService({ store, loadConfig: () => makeConfig() });
    const resolved = await service.resolveToken("a1", { provider: "google" });

    expect(resolved.connected).toBe(false);
    if (!resolved.connected) {
      expect(resolved.reason).toBe("not_connected");
      expect(resolved.authorizeUrl).toContain(
        "/api/oauth/google/authorize?agent=a1"
      );
      expect(resolved.message).toContain("not connected");
    }
  });

  it("resolveToken refreshes silently when the access token is expiring (refresh success path)", async () => {
    store.save({
      agentId: "a1",
      provider: "google",
      accessToken: "OLD",
      refreshToken: "REFRESH-1",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      expiresAt: Date.now() - 1000, // already expired
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      if (urlStr.includes("token")) {
        const body = new URLSearchParams((init?.body as string) ?? "");
        // Must be a refresh_token grant using the stored refresh token.
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("REFRESH-1");
        return new Response(
          JSON.stringify({
            access_token: "NEW-ACCESS",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`unexpected fetch to ${urlStr}`);
    });

    const service = new OAuthService({
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadConfig: () => makeConfig(),
    });
    const resolved = await service.resolveToken("a1", { provider: "google" });

    expect(resolved.connected).toBe(true);
    if (resolved.connected) expect(resolved.accessToken).toBe("NEW-ACCESS");
    // Refreshed token is persisted and the connection stays `connected`.
    const stored = store.get("a1", "google");
    expect(stored?.accessToken).toBe("NEW-ACCESS");
    expect(stored?.status).toBe("connected");
    expect(service.getConnectionState("a1", "google")).toBe("connected");
  });

  it("resolveToken flips to needs_reconnect when the refresh grant is unrecoverable (refresh failure path)", async () => {
    store.save({
      agentId: "a1",
      provider: "google",
      accessToken: "OLD",
      refreshToken: "DEAD-REFRESH",
      scopes: [],
      expiresAt: Date.now() - 1000,
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("token")) {
        return new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "revoked" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error("unexpected fetch");
    });

    const service = new OAuthService({
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadConfig: () => makeConfig(),
    });
    const resolved = await service.resolveToken("a1", { provider: "google" });

    expect(resolved.connected).toBe(false);
    if (!resolved.connected) {
      expect(resolved.reason).toBe("needs_reconnect");
      expect(resolved.authorizeUrl).toContain("/api/oauth/google/authorize");
    }
    // Connection is retained but flagged, so the UI can prompt a reconnect.
    expect(service.getConnectionState("a1", "google")).toBe("needs_reconnect");
    expect(store.get("a1", "google")?.status).toBe("needs_reconnect");
  });

  it("resolveToken flips to needs_reconnect when an expired token has no refresh token", async () => {
    store.save({
      agentId: "a1",
      provider: "google",
      accessToken: "OLD",
      scopes: [],
      expiresAt: Date.now() - 1000,
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const service = new OAuthService({ store, loadConfig: () => makeConfig() });
    const resolved = await service.resolveToken("a1", { provider: "google" });
    expect(resolved.connected).toBe(false);
    if (!resolved.connected) expect(resolved.reason).toBe("needs_reconnect");
    expect(service.getConnectionState("a1", "google")).toBe("needs_reconnect");
  });

  it("resolveToken keeps a still-valid grant on a transient (5xx) refresh failure", async () => {
    store.save({
      agentId: "a1",
      provider: "google",
      accessToken: "STILL-GOOD",
      refreshToken: "REFRESH-1",
      scopes: [],
      // Within skew window (expiring soon) but not yet expired.
      expiresAt: Date.now() + 30_000,
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("token")) {
        return new Response("upstream boom", { status: 503 });
      }
      throw new Error("unexpected fetch");
    });
    const service = new OAuthService({
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadConfig: () => makeConfig(),
    });
    const resolved = await service.resolveToken("a1", { provider: "google" });
    expect(resolved.connected).toBe(true);
    if (resolved.connected) expect(resolved.accessToken).toBe("STILL-GOOD");
    // Transient failure must not discard the grant.
    expect(service.getConnectionState("a1", "google")).toBe("connected");
  });

  it("disconnect revokes the grant at the provider then clears it (state -> disconnected)", async () => {
    store.save({
      agentId: "a1",
      provider: "google",
      accessToken: "A1",
      refreshToken: "REFRESH-1",
      scopes: [],
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("revoke");
      const body = new URLSearchParams((init?.body as string) ?? "");
      expect(body.get("token")).toBe("REFRESH-1");
      return new Response(null, { status: 200 });
    });
    const service = new OAuthService({
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadConfig: () => makeConfig(),
    });

    expect(service.getConnectionState("a1", "google")).toBe("connected");
    await service.disconnect("a1", "google");

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(store.get("a1", "google")).toBeUndefined();
    expect(service.getConnectionState("a1", "google")).toBe("disconnected");
  });

  it("disconnect still clears locally when the provider revoke fails", async () => {
    store.save({
      agentId: "a1",
      provider: "google",
      accessToken: "A1",
      scopes: [],
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const service = new OAuthService({
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadConfig: () => makeConfig(),
    });
    await service.disconnect("a1", "google");
    expect(store.get("a1", "google")).toBeUndefined();
    expect(service.getConnectionState("a1", "google")).toBe("disconnected");
  });

  it("resolveToken reports provider_not_configured when no client credentials", async () => {
    const service = new OAuthService({
      store,
      loadConfig: () => makeConfig({ providers: {} }),
    });
    const resolved = await service.resolveToken("a1", { provider: "google" });
    expect(resolved.connected).toBe(false);
    if (!resolved.connected) expect(resolved.reason).toBe("provider_not_configured");
  });
});
