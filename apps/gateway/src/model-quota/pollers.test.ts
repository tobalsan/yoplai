import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuotaPollers } from "./pollers.js";
import { QuotaStore } from "./store.js";

const access = `e30.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
  })
).toString("base64url")}.fixture`;
const usage = {
  plan_type: "pro",
  rate_limit: {
    primary_window: {
      used_percent: 21,
      limit_window_seconds: 604800,
      reset_at: 1800000000,
    },
    secondary_window: null,
  },
};

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(1790000000000);
  const now = () => Date.now() / 1000;
  const store = new QuotaStore({ now, isLoginActive: () => true });
  const readCredential = vi.fn((provider: string) =>
    provider === "openai-codex" ? { type: "oauth", access } : undefined
  );
  const resolveToken = vi.fn(async () => ({
    status: "ok" as const,
    accessToken: access,
    expiresAt: 1800000000000,
  }));
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(usage))
  );
  const log = vi.fn();
  const pollers = createQuotaPollers({
    store,
    readCredential,
    resolveToken,
    fetch: fetcher,
    now,
    log,
  });
  return { store, readCredential, resolveToken, fetcher, log, pollers };
}

afterEach(() => vi.useRealTimers());

describe("host quota polling lifecycle", () => {
  it("ignores a late 429 from a request that timed out before a newer success", async () => {
    const { store, fetcher, pollers } = setup();
    let release!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const starting = pollers.start(true);
    await vi.advanceTimersByTimeAsync(10000);
    await starting;
    await vi.advanceTimersByTimeAsync(290000);
    expect(store.list()[0].status).toBe("known");
    release(
      new Response("ignored", {
        status: 429,
        headers: { "Retry-After": "3600" },
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(store.list()[0].status).toBe("known");
    pollers.stop();
  });

  it("polls immediately and every five minutes with account and snapshot from the same token", async () => {
    const { store, fetcher, pollers } = setup();
    await pollers.start(true);
    expect(fetcher).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${access}`,
          "ChatGPT-Account-Id": "fixture-account",
        }),
      })
    );
    expect(store.list()).toEqual([
      expect.objectContaining({
        provider: "openai-codex",
        planLabel: "pro",
        source: "wham-usage",
        status: "known",
        windows: [
          {
            kind: "weekly",
            usedPercent: 21,
            resetAt: 1800000000,
            windowSeconds: 604800,
          },
        ],
      }),
    ]);
    await vi.advanceTimersByTimeAsync(300000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    pollers.stop();
    await vi.advanceTimersByTimeAsync(300000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds a hung request at ten seconds and allows the next poll to recover", async () => {
    const { store, fetcher, pollers, log } = setup();
    fetcher.mockImplementationOnce(async () => new Promise<Response>(() => {}));
    const starting = pollers.start(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(store.list()).toEqual([
      expect.objectContaining({
        status: "unknown",
        stale: true,
        errorKind: "timeout",
      }),
    ]);
    await starting;
    expect(log).toHaveBeenCalledWith({
      provider: "openai-codex",
      source: "wham-usage",
      outcome: "error",
      errorKind: "timeout",
    });
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(290000);
    expect(store.list()[0]).toMatchObject({ status: "known", stale: false });
    pollers.stop();
  }, 500);

  it.each(["900", new Date(1790000900000).toUTCString()])(
    "honors Retry-After %s before polling again",
    async (retryAfter) => {
      const { store, fetcher, pollers } = setup();
      fetcher.mockResolvedValueOnce(
        new Response("not logged", {
          status: 429,
          headers: { "Retry-After": retryAfter },
        })
      );
      await pollers.start(true);
      expect(store.list()[0]).toMatchObject({
        status: "unknown",
        errorKind: "rate_limited",
      });
      await vi.advanceTimersByTimeAsync(600000);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(300000);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(store.list()[0]).toMatchObject({ status: "known" });
      pollers.stop();
    }
  );

  it("backs off 5, 10, 20, 40, 60 minutes without Retry-After and resets on success", async () => {
    const { store, fetcher, pollers } = setup();
    fetcher.mockImplementation(
      async () => new Response("ignored", { status: 429 })
    );
    await pollers.start(true);
    for (const [delay, count] of [
      [300000, 2],
      [600000, 3],
      [1200000, 4],
      [2400000, 5],
      [3600000, 6],
    ]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetcher).toHaveBeenCalledTimes(count - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher).toHaveBeenCalledTimes(count);
    }
    fetcher.mockImplementation(async () => new Response(JSON.stringify(usage)));
    await vi.advanceTimersByTimeAsync(3600000);
    expect(store.list()[0].status).toBe("known");
    fetcher.mockImplementation(
      async () => new Response("ignored", { status: 429 })
    );
    await vi.advanceTimersByTimeAsync(600000);
    expect(fetcher).toHaveBeenCalledTimes(9);
    pollers.stop();
  });

  it.each([
    ["network", "network"],
    ["http", "http_error"],
    ["json", "invalid_payload"],
    ["shape", "invalid_payload"],
    ["token", "token_error"],
  ])(
    "keeps %s failures out of chat and logs while marking only quota stale",
    async (failure, errorKind) => {
      const { store, fetcher, pollers, log, resolveToken } = setup();
      await pollers.start(true);
      const secret = "RAW_RESPONSE_TOKEN_SENTINEL";
      if (failure === "network") fetcher.mockRejectedValue(new Error(secret));
      if (failure === "token")
        resolveToken.mockRejectedValue(new Error(secret));
      if (failure === "http")
        fetcher.mockResolvedValue(new Response(secret, { status: 503 }));
      if (failure === "json") fetcher.mockResolvedValue(new Response(secret));
      if (failure === "shape")
        fetcher.mockResolvedValue(new Response(JSON.stringify({ secret })));
      await vi.advanceTimersByTimeAsync(300000);
      expect(store.list()[0]).toMatchObject({
        status: "unknown",
        stale: true,
        errorKind,
      });
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).not.toContain(secret);
      expect(logged).not.toContain(access);
      expect(logged).not.toContain("fixture-account");
      pollers.stop();
    }
  );

  it("polls Claude only without recent headers, using its OAuth usage headers", async () => {
    const { store, readCredential, fetcher, pollers } = setup();
    readCredential.mockReturnValue({ type: "oauth", access });
    fetcher.mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes("anthropic")
              ? {
                  five_hour: {
                    utilization: 66,
                    resets_at: "2026-11-01T19:00:00Z",
                  },
                  seven_day: {
                    utilization: 50,
                    resets_at: "2026-11-03T06:00:00Z",
                  },
                }
              : usage
          )
        )
    );
    await pollers.start(true);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          "anthropic-beta": "oauth-2025-04-20",
          Accept: "application/json",
          "User-Agent": expect.stringMatching(/^claude-cli\//),
        }),
      })
    );
    const claude = store
      .list()
      .find((snapshot) => snapshot.provider === "anthropic")!;
    expect(claude).toMatchObject({
      source: "usage-endpoint",
      windows: [{ usedPercent: 66 }, { usedPercent: 50 }],
    });
    store.record(claude, "headers", claude.windows, Date.now() / 1000);
    await vi.advanceTimersByTimeAsync(600000);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("anthropic"))
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300000);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("anthropic"))
    ).toHaveLength(2);
    pollers.stop();
  });

  it("warns without polling or storing a Codex token that has no account claim", async () => {
    const { store, fetcher, pollers, log, resolveToken } = setup();
    resolveToken.mockResolvedValue({
      status: "ok",
      accessToken: "e30.e30.fixture",
      expiresAt: 1800000000000,
    });
    await pollers.start(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
    expect(log).toHaveBeenCalledWith({
      provider: "openai-codex",
      source: "wham-usage",
      outcome: "error",
      errorKind: "no_account",
    });
    pollers.stop();
  });

  it.each(["disabled", "missing", "api-key"])(
    "makes no vendor calls when %s",
    async (mode) => {
      const { store, fetcher, pollers, resolveToken, readCredential } = setup();
      if (mode === "missing") readCredential.mockReturnValue(undefined);
      if (mode === "api-key")
        readCredential.mockReturnValue({
          type: "api_key",
          access: "not-a-token",
        });
      await pollers.start(mode !== "disabled");
      await vi.advanceTimersByTimeAsync(900000);
      expect(fetcher).not.toHaveBeenCalled();
      expect(resolveToken).not.toHaveBeenCalled();
      expect(store.list()).toEqual([]);
      if (mode === "disabled") expect(vi.getTimerCount()).toBe(0);
      pollers.stop();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("bounds a stalled token resolver and does not fetch when its late token arrives", async () => {
    const { store, fetcher, pollers, resolveToken } = setup();
    let release!: (token: Awaited<ReturnType<typeof resolveToken>>) => void;
    resolveToken.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const starting = pollers.start(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(store.list()[0]).toMatchObject({
      status: "unknown",
      errorKind: "timeout",
    });
    await starting;
    release({ status: "ok", accessToken: access, expiresAt: 1800000000000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(290000);
    expect(store.list()[0].status).toBe("known");
    pollers.stop();
  });
});
