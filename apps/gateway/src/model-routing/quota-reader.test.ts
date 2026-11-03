import { beforeEach, expect, it, vi } from "vitest";
import type { QuotaSnapshot } from "@yoplai/shared";

const host = vi.hoisted(() => ({ credential: vi.fn(), get: vi.fn() }));
vi.mock("../model-quota/runtime.js", () => ({ readQuotaCredential: host.credential, modelQuotaStore: { get: host.get } }));
import { readRoutingQuota } from "./quota-reader.js";
import { QuotaStore } from "../model-quota/store.js";

const now = 1_800_000_000;
const fresh: QuotaSnapshot = {
  provider: "anthropic", accountRef: "private-account-canary", status: "known", stale: false,
  updatedAt: now - 30,
  windows: [
    { kind: "five-hour", usedPercent: 10, resetAt: now + 9000, windowSeconds: 18000 },
    { kind: "weekly", usedPercent: 25, resetAt: now + 302400, windowSeconds: 604800 },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  host.credential.mockImplementation((provider) => provider === "anthropic" ? { type: "oauth", access: "private-token-canary" } : undefined);
  host.get.mockReturnValue(fresh);
});

it("reads host quotas once and converts milliseconds to seconds without exposing credentials", async () => {
  expect(await readRoutingQuota({ now: now * 1000 })).toEqual({
    claude: { status: "known", exhausted: false, pace: 0.5,
      telemetry: { ageSeconds: 30, fiveHour: "ok", pace: 0.5 } },
    chatgpt: { status: "unknown", telemetry: { ageSeconds: null, fiveHour: "unknown", pace: null } },
  });
  expect(host.get).toHaveBeenCalledTimes(1);
});

it.each([
  ["past maximum age", { ...fresh, updatedAt: now - 1201 }, 1201],
  ["five-hour reset", { ...fresh, windows: [{ ...fresh.windows[0], resetAt: now }] }, 30],
  ["weekly reset", { ...fresh, windows: [{ ...fresh.windows[1], resetAt: now - 1 }] }, 30],
] as const)("marks a timestamped snapshot stale at %s", async (_name, snapshot, ageSeconds) => {
  host.get.mockReturnValue(snapshot);
  expect((await readRoutingQuota({ now: now * 1000 })).claude).toEqual({
    status: "unknown", reason: "stale",
    telemetry: { ageSeconds, fiveHour: "unknown", pace: null },
  });
});

it.each([
  ["exhausted", [{ ...fresh.windows[0], usedPercent: 100 }, fresh.windows[1]],
    { status: "known", exhausted: true, pace: 0.5, telemetry: { ageSeconds: 30, fiveHour: "exhausted", pace: 0.5 } }],
  ["absent", [fresh.windows[1]],
    { status: "known", exhausted: false, pace: 0.5, telemetry: { ageSeconds: 30, fiveHour: "absent", pace: 0.5 } }],
  ["no weekly pace", [fresh.windows[0]],
    { status: "known", exhausted: false, telemetry: { ageSeconds: 30, fiveHour: "ok", pace: null } }],
  ["unrecognized reset", [...fresh.windows, { kind: "other", usedPercent: 100, resetAt: now - 1, windowSeconds: 10 }],
    { status: "known", exhausted: false, pace: 0.5, telemetry: { ageSeconds: 30, fiveHour: "ok", pace: 0.5 } }],
])("projects %s observations without changing pool policy", async (_name, windows, expected) => {
  host.get.mockReturnValue({ ...fresh, windows });
  expect((await readRoutingQuota({ now: now * 1000 })).claude).toEqual(expected);
});

it.each([
  ["no snapshot", undefined],
  ["never seen", { provider: "anthropic", accountRef: "private-account-canary", status: "unknown", stale: true, windows: [], errorKind: "never_seen" }],
])("keeps %s unknown without marking it stale", async (_name, snapshot) => {
  host.get.mockReturnValue(snapshot);
  expect((await readRoutingQuota({ now: now * 1000 })).claude).toEqual({
    status: "unknown", telemetry: { ageSeconds: null, fiveHour: "unknown", pace: null },
  });
});

it("keeps the timestamp of a recent failed source without calling it stale", async () => {
  const store = new QuotaStore({ now: () => now, isLoginActive: () => true });
  const identity = { provider: "anthropic", accountRef: "host" };
  store.record(identity, "headers", fresh.windows, now - 30);
  store.markError(identity, "headers", "timeout");
  host.get.mockImplementation((login) => store.get(login));
  expect((await readRoutingQuota({ now: now * 1000 })).claude).toEqual({
    status: "unknown", telemetry: { ageSeconds: 30, fiveHour: "unknown", pace: null },
  });
});

it("does not query the store without a resolvable host credential", async () => {
  host.credential.mockReturnValue({ type: "api_key", access: "private-token-canary" });
  expect(await readRoutingQuota({ now: now * 1000 })).toEqual({
    claude: { status: "unknown", telemetry: { ageSeconds: null, fiveHour: "unknown", pace: null } },
    chatgpt: { status: "unknown", telemetry: { ageSeconds: null, fiveHour: "unknown", pace: null } },
  });
  expect(host.get).not.toHaveBeenCalled();
});

it("uses the Codex token identity for the ChatGPT pool and never returns it", async () => {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "private-account-canary" } })).toString("base64url");
  host.credential.mockImplementation((provider) => provider === "openai-codex" ? { type: "oauth", access: `fixture.${payload}.fixture` } : undefined);
  expect((await readRoutingQuota({ now: now * 1000 })).chatgpt).toEqual({
    status: "known", exhausted: false, pace: 0.5, telemetry: { ageSeconds: 30, fiveHour: "ok", pace: 0.5 },
  });
  expect(host.get).toHaveBeenCalledWith({ provider: "openai-codex", accountRef: expect.stringMatching(/^[0-9a-f]{16}$/) });
});
