import { expect, it } from "vitest";
import { QuotaStore } from "./store.js";
const claude = { provider: "anthropic", accountRef: "local" };
const windows = [
  {
    kind: "five-hour" as const,
    usedPercent: 66,
    resetAt: 20000,
    windowSeconds: 18000,
  },
];
it("records a per-login observation and lists the same sanitized effective snapshot", () => {
  const store = new QuotaStore({ now: () => 1000, isLoginActive: () => true });
  store.record(claude, "headers", windows, 1000);
  expect(store.get(claude)).toEqual({
    ...claude,
    status: "known",
    windows,
    source: "headers",
    updatedAt: 1000,
    stale: false,
  });
  expect(store.list()).toEqual([
    {
      ...claude,
      status: "known",
      windows,
      source: "headers",
      updatedAt: 1000,
      stale: false,
    },
  ]);
});
it("keeps accounts separate and discards old account readings at read time, including late arrivals", () => {
  let active = "account-a";
  const store = new QuotaStore({
    now: () => 1000,
    isLoginActive: (identity) => identity.accountRef === active,
  });
  const a = { provider: "openai-codex", accountRef: "account-a" };
  const b = { provider: "openai-codex", accountRef: "account-b" };
  store.record(a, "wham-usage", windows, 1000, "plus");
  expect(store.get(b).status).toBe("unknown");
  active = "account-b";
  store.record(a, "wham-usage", windows, 1001, "plus");
  expect(store.get(a).status).toBe("unknown");
  expect(store.list()).toEqual([]);
  store.record(b, "wham-usage", [], 1000, "pro");
  expect(store.get(b)).toEqual({
    ...b,
    status: "known",
    windows: [],
    source: "wham-usage",
    updatedAt: 1000,
    stale: false,
    planLabel: "pro",
  });
});
it("rejects late records within each source and selects the newest source's own plan", () => {
  const store = new QuotaStore({ now: () => 1000, isLoginActive: () => true });
  store.record(claude, "headers", windows, 900, "header-plan");
  store.record(
    claude,
    "usage-endpoint",
    [{ ...windows[0], usedPercent: 20 }],
    950,
    "endpoint-plan"
  );
  store.record(
    claude,
    "usage-endpoint",
    [{ ...windows[0], usedPercent: 80 }],
    920,
    "old-plan"
  );
  expect(store.get(claude)).toMatchObject({
    source: "usage-endpoint",
    updatedAt: 950,
    planLabel: "endpoint-plan",
    windows: [{ usedPercent: 20 }],
  });
});
it("isolates source errors, falls back to healthy observations and clears only the recovering source", () => {
  let now = 1000;
  const store = new QuotaStore({ now: () => now, isLoginActive: () => true });
  store.record(claude, "headers", windows, 900);
  store.record(claude, "usage-endpoint", [], 950);
  store.markError(claude, "usage-endpoint", "timeout");
  expect(store.get(claude)).toMatchObject({
    status: "known",
    source: "headers",
    updatedAt: 900,
    stale: false,
  });
  now = 1001;
  store.markError(claude, "headers", "invalid_payload");
  expect(store.get(claude)).toMatchObject({
    status: "unknown",
    stale: true,
    errorKind: "invalid_payload",
  });
  store.record(claude, "usage-endpoint", [], 1002);
  expect(store.get(claude)).toMatchObject({
    status: "known",
    source: "usage-endpoint",
    stale: false,
  });
  store.markError(claude, "usage-endpoint", "network");
  expect(store.get(claude)).toMatchObject({
    status: "unknown",
    errorKind: "network",
  });
});
it("expires readings after twenty minutes while preserving header update time for idle polling", () => {
  let now = 1000;
  const store = new QuotaStore({ now: () => now, isLoginActive: () => true });
  expect(store.latestHeaderAt(claude)).toBeUndefined();
  store.record(claude, "headers", windows, 1000);
  store.record(claude, "usage-endpoint", [], 1100);
  expect(store.latestHeaderAt(claude)).toBe(1000);
  now = 2300;
  expect(store.get(claude).status).toBe("known");
  now = 2301;
  expect(store.get(claude)).toMatchObject({
    status: "unknown",
    stale: true,
    errorKind: "never_seen",
  });
});
it("lists expired data with its original timestamp and preserves error-only state", () => {
  let now = 1000;
  const store = new QuotaStore({ now: () => now, isLoginActive: () => true });
  store.record(claude, "headers", windows, 1000);
  now = 2201;
  expect(store.list()).toEqual([
    {
      ...claude,
      status: "unknown",
      windows,
      source: "headers",
      updatedAt: 1000,
      stale: true,
      errorKind: "never_seen",
    },
  ]);
  const other = { provider: "openai-codex", accountRef: "other" };
  store.markError(other, "wham-usage", "token");
  expect(store.get(other)).toEqual({
    ...other,
    status: "unknown",
    windows: [],
    source: "wham-usage",
    stale: true,
    errorKind: "token",
  });
});
it("allows idle polling immediately after an invalid header observation", () => {
  const store = new QuotaStore({ now: () => 1000, isLoginActive: () => true });
  store.record(claude, "headers", windows, 1000);
  store.markError(claude, "headers", "invalid_payload");
  expect(store.latestHeaderAt(claude)).toBeUndefined();
});
it("keeps simultaneous active logins' readings and errors separate", () => {
  const store = new QuotaStore({ now: () => 1000, isLoginActive: () => true });
  const a = { provider: "openai-codex", accountRef: "first" };
  const b = { provider: "openai-codex", accountRef: "second" };
  store.record(
    a,
    "wham-usage",
    [{ ...windows[0], usedPercent: 10 }],
    1000,
    "plus"
  );
  store.record(
    b,
    "wham-usage",
    [{ ...windows[0], usedPercent: 90 }],
    1000,
    "pro"
  );
  expect(store.get(a)).toMatchObject({
    status: "known",
    windows: [{ usedPercent: 10 }],
    planLabel: "plus",
  });
  expect(store.get(b)).toMatchObject({
    status: "known",
    windows: [{ usedPercent: 90 }],
    planLabel: "pro",
  });
  store.markError(a, "wham-usage", "timeout");
  expect(store.get(a).status).toBe("unknown");
  expect(store.get(b)).toMatchObject({
    status: "known",
    windows: [{ usedPercent: 90 }],
  });
  expect(store.list()).toHaveLength(2);
});
