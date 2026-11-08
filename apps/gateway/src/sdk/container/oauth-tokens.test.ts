import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@yoplai/shared";
import {
  resolveOAuthToken,
  resolveOAuthTokens,
  type OAuthTokensDeps,
  type ResolveOAuthTokenDeps,
} from "./oauth-tokens.js";

const TEN_MINUTES_MS = 10 * 60 * 1000;

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "agent-1",
    name: "Agent One",
    workspace: "/tmp/agent-1",
    queueMode: "queue",
    model: { provider: "anthropic", model: "claude" },
    ...overrides,
  } as AgentConfig;
}

type StoredCred =
  | { type: "oauth"; access: string; expires: number }
  | { type: "api_key" };

/** Simulate the SDK persisting a refreshed credential in place. */
function markRefreshed(
  credentials: Record<string, StoredCred>,
  provider: string,
  access: string
): void {
  const cred = credentials[provider];
  if (cred?.type === "oauth") credentials[provider] = { ...cred, access };
}

function makeDeps(
  credentials: Record<string, StoredCred>,
  options: {
    authPath?: string;
    getAuthImpl?: (provider: string) => Promise<unknown>;
  } = {}
): OAuthTokensDeps & { getAuth: ReturnType<typeof vi.fn> } {
  const getAuth = vi.fn(
    options.getAuthImpl ??
      (async (provider: string) => {
        const cred = credentials[provider];
        if (cred?.type !== "oauth") return undefined;
        // Simulate a real refresh: the store gets a fresh access token,
        // independent of whatever shape getAuth itself returns.
        markRefreshed(credentials, provider, `${provider}-fresh-token`);
        return { auth: { apiKey: `${provider}-fresh-token` } };
      })
  );
  return {
    authPath: options.authPath ?? "/fake/auth.json",
    createRuntime: async () => ({ getAuth }),
    readCredential: async (provider) => credentials[provider],
    getAuth,
  };
}

function unreachableDeps(): OAuthTokensDeps {
  return {
    authPath: "/fake/auth.json",
    createRuntime: async () => {
      throw new Error("createRuntime must not be called for a non-oauth agent");
    },
    readCredential: async () => {
      throw new Error("readCredential must not be called for a non-oauth agent");
    },
  };
}

describe("resolveOAuthTokens", () => {
  it("returns undefined when the agent is not in oauth auth mode", async () => {
    const deps = makeDeps({
      anthropic: { type: "oauth", access: "initial", expires: 123 },
    });
    const result = await resolveOAuthTokens(
      agent({ auth: { mode: "api_key" } }),
      undefined,
      deps
    );
    expect(result).toBeUndefined();
  });

  it("never touches auth storage for a non-oauth agent, so a missing auth.json doesn't block launch", async () => {
    const result = await resolveOAuthTokens(
      agent({ auth: undefined }),
      undefined,
      unreachableDeps()
    );
    expect(result).toBeUndefined();
  });

  it("resolves tokens for both primary and fallback providers, requesting the 10-minute minimum validity", async () => {
    const deps = makeDeps({
      anthropic: { type: "oauth", access: "initial", expires: 1000 },
      openai: { type: "oauth", access: "initial", expires: 2000 },
    });
    const result = await resolveOAuthTokens(
      agent({
        auth: { mode: "oauth" },
        fallback_model: { provider: "openai", model: "gpt-5" },
      }),
      undefined,
      deps
    );
    expect(result).toEqual({
      anthropic: { accessToken: "anthropic-fresh-token", expiresAt: 1000 },
      openai: { accessToken: "openai-fresh-token", expiresAt: 2000 },
    });
    expect(deps.getAuth).toHaveBeenCalledWith("anthropic", {
      minOAuthValidityMs: TEN_MINUTES_MS,
    });
    expect(deps.getAuth).toHaveBeenCalledWith("openai", {
      minOAuthValidityMs: TEN_MINUTES_MS,
    });
  });

  // ALG-594 Testing Decisions approve the token-resolver seam: it catches
  // provider credential access, but not a container's use of those tokens.
  it("requests only the locked provider token when the agent copy has no fallback", async () => {
    const configuredAgent = agent({
      auth: { mode: "oauth" },
      fallback_model: { provider: "openai", model: "gpt-5" },
    });
    const deps = makeDeps({
      anthropic: { type: "oauth", access: "initial", expires: 1000 },
      openai: { type: "oauth", access: "initial", expires: 2000 },
      "openai-codex": { type: "oauth", access: "initial", expires: 3000 },
    });
    const readCredential = vi.fn(deps.readCredential);
    const result = await resolveOAuthTokens(
      { ...configuredAgent, fallback_model: undefined },
      { provider: "openai-codex", model: "gpt-5.6" },
      { ...deps, readCredential }
    );

    expect(result).toEqual({
      "openai-codex": { accessToken: "openai-codex-fresh-token", expiresAt: 3000 },
    });
    expect(new Set(readCredential.mock.calls.map(([provider]) => provider)))
      .toEqual(new Set(["openai-codex"]));
    expect(deps.getAuth).toHaveBeenCalledWith("openai-codex", {
      minOAuthValidityMs: TEN_MINUTES_MS,
    });
    expect(deps.getAuth).not.toHaveBeenCalledWith("openai", expect.anything());
  });

  it("skips a provider whose stored credential is not oauth", async () => {
    const deps = makeDeps({ anthropic: { type: "api_key" } });
    const result = await resolveOAuthTokens(
      agent({ auth: { mode: "oauth" } }),
      undefined,
      deps
    );
    expect(result).toBeUndefined();
  });

  it("skips a provider whose refresh throws and still resolves a healthy one", async () => {
    const credentials: Record<string, StoredCred> = {
      anthropic: { type: "oauth", access: "initial", expires: 1000 },
      openai: { type: "oauth", access: "initial", expires: 2000 },
    };
    const deps = makeDeps(credentials, {
      authPath: "/fake/partial-failure.json",
      getAuthImpl: async (provider) => {
        if (provider === "anthropic") throw new Error("IdP unreachable");
        markRefreshed(credentials, provider, `${provider}-fresh-token`);
        return { auth: {} };
      },
    });
    const result = await resolveOAuthTokens(
      agent({
        auth: { mode: "oauth" },
        fallback_model: { provider: "openai", model: "gpt-5" },
      }),
      undefined,
      deps
    );
    expect(result).toEqual({
      openai: { accessToken: "openai-fresh-token", expiresAt: 2000 },
    });
  });

  it("returns undefined without throwing when every provider's refresh fails", async () => {
    const deps = makeDeps(
      { anthropic: { type: "oauth", access: "initial", expires: 1000 } },
      {
        authPath: "/fake/total-failure.json",
        getAuthImpl: async () => {
          throw new Error("IdP unreachable");
        },
      }
    );
    const result = await resolveOAuthTokens(
      agent({ auth: { mode: "oauth" } }),
      undefined,
      deps
    );
    expect(result).toBeUndefined();
  });

  it("takes both accessToken and expiresAt from the single post-refresh credential read, not from getAuth's return value", async () => {
    const credentials: Record<string, StoredCred> = {
      anthropic: { type: "oauth", access: "stale-token", expires: 1000 },
    };
    const getAuth = vi.fn(async () => {
      // A concurrent refresh (e.g. a host run) lands between our getAuth
      // call and the re-read: the store ends up with a token/expiry pair
      // that getAuth's own return value never reflects.
      credentials.anthropic = {
        type: "oauth",
        access: "rotated-token",
        expires: 9999,
      };
      return { auth: { apiKey: "stale-token" } };
    });
    const deps: OAuthTokensDeps = {
      authPath: "/fake/atomic-pair.json",
      createRuntime: async () => ({ getAuth }),
      readCredential: async (provider) => credentials[provider],
    };

    const result = await resolveOAuthTokens(
      agent({ auth: { mode: "oauth" } }),
      undefined,
      deps
    );

    expect(result).toEqual({
      anthropic: { accessToken: "rotated-token", expiresAt: 9999 },
    });
  });

  it("uses an explicit model override's OAuth credential independently of agent auth", async () => {
    const deps = makeDeps({
      anthropic: { type: "api_key" },
      "openai-codex": { type: "oauth", access: "initial", expires: 3000 },
    });

    const result = await resolveOAuthTokens(
      agent({ auth: { mode: "api_key" } }),
      { provider: "openai-codex", model: "gpt-5" },
      deps
    );

    expect(result).toEqual({
      "openai-codex": {
        accessToken: "openai-codex-fresh-token",
        expiresAt: 3000,
      },
    });
  });
});

describe("resolveOAuthToken", () => {
  function makeResolveDeps(
    credentials: Record<string, StoredCred>,
    options: Parameters<typeof makeDeps>[1] = {}
  ): ResolveOAuthTokenDeps & { getAuth: ReturnType<typeof vi.fn> } {
    return makeDeps(credentials, options);
  }

  it("returns forbidden when the provider was not seeded for the run", async () => {
    const deps = makeResolveDeps({
      anthropic: { type: "oauth", access: "initial", expires: 1000 },
    });
    const result = await resolveOAuthToken("anthropic", [], deps);
    expect(result).toEqual({ status: "forbidden" });
  });

  it("returns forbidden when the provider differs from the run-scoped provider", async () => {
    const deps = makeResolveDeps({
      anthropic: { type: "oauth", access: "initial", expires: 1000 },
    });
    const result = await resolveOAuthToken("openai", ["anthropic"], deps);
    expect(result).toEqual({ status: "forbidden" });
  });

  it("returns not_found when there is no stored oauth credential", async () => {
    const deps = makeResolveDeps({ anthropic: { type: "api_key" } });
    const result = await resolveOAuthToken("anthropic", ["anthropic"], deps);
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns a fresh token on success, requesting the 10-minute minimum validity", async () => {
    const deps = makeResolveDeps(
      { anthropic: { type: "oauth", access: "initial", expires: 5000 } },
      { authPath: "/fake/renewal-success.json" }
    );
    const result = await resolveOAuthToken("anthropic", ["anthropic"], deps);
    expect(result).toEqual({
      status: "ok",
      accessToken: "anthropic-fresh-token",
      expiresAt: 5000,
    });
    expect(deps.getAuth).toHaveBeenCalledWith("anthropic", {
      minOAuthValidityMs: TEN_MINUTES_MS,
    });
  });

  it("takes both accessToken and expiresAt from the single post-refresh credential read, not from getAuth's return value", async () => {
    const credentials: Record<string, StoredCred> = {
      anthropic: { type: "oauth", access: "stale-token", expires: 1000 },
    };
    const getAuth = vi.fn(async () => {
      credentials.anthropic = {
        type: "oauth",
        access: "rotated-token",
        expires: 9999,
      };
      return { auth: { apiKey: "stale-token" } };
    });
    const deps: ResolveOAuthTokenDeps = {
      authPath: "/fake/renewal-atomic-pair.json",
      createRuntime: async () => ({ getAuth }),
      readCredential: async (provider) => credentials[provider],
    };

    const result = await resolveOAuthToken("anthropic", ["anthropic"], deps);

    expect(result).toEqual({
      status: "ok",
      accessToken: "rotated-token",
      expiresAt: 9999,
    });
  });

  it("propagates a refresh failure instead of masking it as not_found", async () => {
    const deps = makeResolveDeps(
      { anthropic: { type: "oauth", access: "initial", expires: 5000 } },
      {
        authPath: "/fake/renewal-failure.json",
        getAuthImpl: async () => {
          throw new Error("IdP unreachable");
        },
      }
    );
    await expect(resolveOAuthToken("anthropic", ["anthropic"], deps)).rejects.toThrow(
      "IdP unreachable"
    );
  });

  it("coalesces concurrent renewals of the same provider into a single refresh", async () => {
    let releaseGetAuth: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGetAuth = resolve;
    });
    const credentials: Record<string, StoredCred> = {
      anthropic: { type: "oauth", access: "initial", expires: 5000 },
    };
    const deps = makeResolveDeps(
      credentials,
      {
        authPath: "/fake/renewal-dedupe.json",
        getAuthImpl: async (provider) => {
          await gate;
          markRefreshed(credentials, provider, `${provider}-fresh-token`);
          return { auth: { apiKey: `${provider}-fresh-token` } };
        },
      }
    );

    // Fire both requests before either's getAuth call resolves, so the
    // second must observe the first's in-flight refresh instead of starting
    // its own.
    const firstPromise = resolveOAuthToken("anthropic", ["anthropic"], deps);
    const secondPromise = resolveOAuthToken("anthropic", ["anthropic"], deps);
    await Promise.resolve();
    await Promise.resolve();
    releaseGetAuth();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first).toEqual({
      status: "ok",
      accessToken: "anthropic-fresh-token",
      expiresAt: 5000,
    });
    expect(second).toEqual(first);
    expect(deps.getAuth).toHaveBeenCalledTimes(1);
  });
});

// ALG-658 Testing Decisions (token-resolver seam with injected deps, emitted
// log JSON) approved at grooming by Thinh ("Groom: GO" on the issue).
describe("dead OAuth login logging", () => {
  // Shape of the installed pi SDK error: the outer message is generic, the
  // Anthropic response body with `invalid_grant` sits in the cause chain.
  function invalidGrantError(): Error {
    return new Error("OAuth refresh failed for anthropic", {
      cause: new Error(
        'Anthropic token refresh request failed. url=https://auth.example.test/token; details=Error: HTTP request failed. status=400; body={"error":"invalid_grant","error_description":"Refresh token not found or invalid","refresh_token":"fake-refresh-canary"}'
      ),
    });
  }

  function failingDeps(authPath: string, getAuthImpl: () => Promise<unknown>) {
    return makeDeps(
      { anthropic: { type: "oauth", access: "fake-access", expires: 5000 } },
      { authPath, getAuthImpl }
    );
  }

  function loudLogs(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((entry) => String(entry.msg).includes("login expired, re-auth needed"));
  }

  it("logs one loud error with the refresh error text and rethrows", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = failingDeps("/fake/dead-login.json", async () => {
      throw invalidGrantError();
    });

    await expect(resolveOAuthToken("anthropic", ["anthropic"], deps)).rejects.toThrow(
      "OAuth refresh failed for anthropic"
    );
    await expect(resolveOAuthToken("anthropic", ["anthropic"], deps)).rejects.toThrow(
      "OAuth refresh failed for anthropic"
    );

    const logs = loudLogs(stderr);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "error",
      msg: "[oauth-tokens] anthropic login expired, re-auth needed",
      provider: "anthropic",
    });
    expect(String(logs[0].message)).toContain("OAuth refresh failed for anthropic");
    expect(String(logs[0].message)).toContain('"error":"invalid_grant"');
    expect(JSON.stringify(logs)).not.toContain("fake-access");
    expect(JSON.stringify(logs)).not.toContain("fake-refresh-canary");
    stderr.mockRestore();
  });

  it("keeps tokens out of the log when the outer error itself carries the body", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = failingDeps("/fake/dead-login-top-level.json", async () => {
      throw new Error(
        'Token refresh failed. body={"error":"invalid_grant","refresh_token":"fake-refresh-canary"}'
      );
    });

    await expect(resolveOAuthToken("anthropic", ["anthropic"], deps)).rejects.toThrow(
      "fake-refresh-canary"
    );

    expect(loudLogs(stderr)).toHaveLength(1);
    expect(stderr.mock.calls.join("\n")).not.toContain("fake-refresh-canary");
    stderr.mockRestore();
  });

  it("also logs when a container launch hits the dead login", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = failingDeps("/fake/dead-login-launch.json", async () => {
      throw invalidGrantError();
    });

    await expect(
      resolveOAuthTokens(agent({ auth: { mode: "oauth" } }), undefined, deps)
    ).resolves.toBeUndefined();

    expect(loudLogs(stderr)).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("does not log loudly for a refresh failure that is not invalid_grant", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = failingDeps("/fake/idp-blip.json", async () => {
      throw new Error("OAuth refresh failed for anthropic", {
        cause: new Error("fetch failed: ECONNRESET"),
      });
    });

    await expect(resolveOAuthToken("anthropic", ["anthropic"], deps)).rejects.toThrow();

    expect(loudLogs(stderr)).toHaveLength(0);
    stderr.mockRestore();
  });

  it("logs again after a successful refresh", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    let dead = true;
    const deps = failingDeps("/fake/dead-then-renewed.json", async () => {
      if (dead) throw invalidGrantError();
      return { auth: {} };
    });

    await expect(resolveOAuthToken("anthropic", ["anthropic"], deps)).rejects.toThrow();
    dead = false;
    await expect(resolveOAuthToken("anthropic", ["anthropic"], deps)).resolves.toMatchObject({
      status: "ok",
    });
    dead = true;
    await expect(resolveOAuthToken("anthropic", ["anthropic"], deps)).rejects.toThrow();

    expect(loudLogs(stderr)).toHaveLength(2);
    stderr.mockRestore();
  });

  it("logs again once the one-hour cool-down has passed", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.now();
    const deps = failingDeps("/fake/dead-cooldown.json", async () => {
      throw invalidGrantError();
    });

    try {
      await expect(resolveOAuthToken("anthropic", ["anthropic"], deps)).rejects.toThrow();
      vi.setSystemTime(startedAt + 59 * 60 * 1000);
      await expect(resolveOAuthToken("anthropic", ["anthropic"], deps)).rejects.toThrow();
      expect(loudLogs(stderr)).toHaveLength(1);
      vi.setSystemTime(startedAt + 61 * 60 * 1000);
      await expect(resolveOAuthToken("anthropic", ["anthropic"], deps)).rejects.toThrow();
      expect(loudLogs(stderr)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      stderr.mockRestore();
    }
  });
});
