import { describe, expect, it, vi } from "vitest";
import { googleProvider, notionProvider } from "./test-providers.js";
import {
  OAuthRefreshError,
  exchangeCodeForTokens,
  refreshAccessToken,
  revokeToken,
} from "./exchange.js";

const credentials = { clientId: "cid", clientSecret: "csecret" };

describe("refreshAccessToken", () => {
  it("exchanges a refresh token for a fresh access token (faked Google endpoint)", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(googleProvider.tokenUrl);
      const body = new URLSearchParams((init?.body as string) ?? "");
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("REFRESH-1");
      expect(body.get("client_secret")).toBe("csecret");
      return new Response(
        JSON.stringify({ access_token: "NEW", expires_in: 3600, token_type: "Bearer" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await refreshAccessToken(
      { provider: googleProvider, credentials, refreshToken: "REFRESH-1" },
      fetchImpl as unknown as typeof fetch
    );
    expect(result.accessToken).toBe("NEW");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("marks a 4xx OAuth error (invalid_grant) as unrecoverable", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );
    await expect(
      refreshAccessToken(
        { provider: googleProvider, credentials, refreshToken: "DEAD" },
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toMatchObject({ name: "OAuthRefreshError", unrecoverable: true });
  });

  it("marks a transient 429 (rate limit) as recoverable, not a dead grant", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );
    await expect(
      refreshAccessToken(
        { provider: googleProvider, credentials, refreshToken: "R" },
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toMatchObject({ name: "OAuthRefreshError", unrecoverable: false });
  });

  it("marks a 5xx as transient (recoverable)", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 503 }));
    await expect(
      refreshAccessToken(
        { provider: googleProvider, credentials, refreshToken: "R" },
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toMatchObject({ name: "OAuthRefreshError", unrecoverable: false });
  });

  it("marks a network failure as transient (recoverable)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const error = await refreshAccessToken(
      { provider: googleProvider, credentials, refreshToken: "R" },
      fetchImpl as unknown as typeof fetch
    ).catch((e) => e);
    expect(error).toBeInstanceOf(OAuthRefreshError);
    expect((error as OAuthRefreshError).unrecoverable).toBe(false);
  });
});

describe("revokeToken", () => {
  it("posts the token to the provider revoke endpoint and returns true on 200", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(googleProvider.revokeUrl);
      const body = new URLSearchParams((init?.body as string) ?? "");
      expect(body.get("token")).toBe("TOK");
      return new Response(null, { status: 200 });
    });
    const ok = await revokeToken(
      googleProvider,
      "TOK",
      fetchImpl as unknown as typeof fetch
    );
    expect(ok).toBe(true);
  });

  it("never throws when revoke fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    });
    const ok = await revokeToken(
      googleProvider,
      "TOK",
      fetchImpl as unknown as typeof fetch
    );
    expect(ok).toBe(false);
  });
});

describe("tokenAuth basic", () => {
  const basic = `Basic ${Buffer.from("cid:csecret").toString("base64")}`;
  const tokenJson = {
    access_token: "A",
    refresh_token: "R",
    workspace_name: "Acme",
    owner: { user: { person: { email: "a@b.co" } } },
  };

  it("sends the code exchange client credentials as a Basic header, not in the body", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(basic);
      const body = new URLSearchParams(init?.body as string);
      expect(body.has("client_id")).toBe(false);
      expect(body.has("client_secret")).toBe(false);
      expect(body.get("code")).toBe("CODE");
      return Response.json(tokenJson);
    });
    const result = await exchangeCodeForTokens(
      { provider: notionProvider, credentials, code: "CODE", redirectUri: "https://x/cb", codeVerifier: "v" },
      fetchImpl as unknown as typeof fetch
    );
    expect(result.accessToken).toBe("A");
    expect(result.account).toBe("a@b.co");
  });

  it("falls back to workspace_name when the token response has no owner email", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "A", workspace_name: "Acme" }));
    const result = await exchangeCodeForTokens(
      { provider: notionProvider, credentials, code: "CODE", redirectUri: "https://x/cb", codeVerifier: "v" },
      fetchImpl as unknown as typeof fetch
    );
    expect(result.account).toBe("Acme");
  });

  it("sends refresh credentials as a Basic header", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(basic);
      const body = new URLSearchParams(init?.body as string);
      expect(body.has("client_secret")).toBe(false);
      return Response.json(tokenJson);
    });
    await refreshAccessToken(
      { provider: notionProvider, credentials, refreshToken: "R" },
      fetchImpl as unknown as typeof fetch
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends revoke credentials as a Basic header", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(basic);
      return new Response(null, { status: 200 });
    });
    const ok = await revokeToken(notionProvider, "TOK", fetchImpl as unknown as typeof fetch, credentials);
    expect(ok).toBe(true);
  });

  it("keeps credentials in the body for the default body auth", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
      expect(new URLSearchParams(init?.body as string).get("client_secret")).toBe("csecret");
      return Response.json(tokenJson);
    });
    await refreshAccessToken(
      { provider: googleProvider, credentials, refreshToken: "R" },
      fetchImpl as unknown as typeof fetch
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
