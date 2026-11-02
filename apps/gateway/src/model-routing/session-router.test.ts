import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConfigSchema, ModelRoutingConfigSchema } from "@yoplai/shared";
import type { WorkRequestResult, CategoryResult } from "./classifier.js";

// Thinh explicitly approved the router seam on ALG-597, 2 Nov 2026:
// real canonical metadata catches durable behavior; fake providers miss vendors.
const state = vi.hoisted(() => ({ home: "", credential: vi.fn(), quota: vi.fn() }));
vi.mock("../config/index.js", () => ({ get CONFIG_DIR() { return state.home; } }));
vi.mock("../sessions/store.js", () => ({ getSessionCreatedAt: async () => 1 }));
vi.mock("../model-quota/runtime.js", () => ({ readQuotaCredential: state.credential, modelQuotaStore: { get: state.quota } }));

const agent = AgentConfigSchema.parse({ id: "router", name: "Router", workspace: "/tmp/router-fixture", model: { provider: "usual-provider", model: "usual-model" }, modelRouting: { enabled: true } });
const config = ModelRoutingConfigSchema.parse({ mode: "shadow", version: "fixture-v1", floor: [], table: [{
  id: "work", definition: "work", examples: ["build"], pool: "prefer_chatgpt",
  claude: { provider: "anthropic", model: "claude", effort: "medium" },
  chatgpt: { provider: "openai-codex", model: "gpt", effort: "high" },
}] });
const classifier = {
  checkWorkRequest: vi.fn(async (): Promise<WorkRequestResult> => ({ status: "ok" as const, isWorkRequest: false, probability: 0.01, latencyMs: 7 })),
  classifyCategory: vi.fn(async (): Promise<CategoryResult> => ({ status: "ok" as const, category: "work", score: 0.9, probabilities: { work: 0.9 }, latencyMs: 11, orders: [{ ms: 9, completed: true }, { ms: 11, completed: true }] as [{ms:number;completed:boolean},{ms:number;completed:boolean}] })),
};
const context = () => ({ agent, config, sdk: "pi", sessionId: "session", source: "web", message: "private message canary", userMessageAt: 1234 });

async function entries() {
  const { appendSessionMeta } = await import("../history/store.js");
  await appendSessionMeta(agent.id, "session", "barrier", true);
  const files = await fs.readdir(path.join(state.home, "history"));
  const lines = await fs.readFile(path.join(state.home, "history", files[0]), "utf8");
  return lines.trim().split("\n").map((line) => JSON.parse(line));
}

beforeEach(async () => {
  state.home = await fs.mkdtemp(path.join(os.tmpdir(), "routing-attempt-"));
  vi.resetModules();
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  classifier.checkWorkRequest.mockReset().mockResolvedValue({ status: "ok", isWorkRequest: false, probability: 0.01, latencyMs: 7 });
  classifier.classifyCategory.mockReset().mockResolvedValue({ status: "ok", category: "work", score: 0.9, probabilities: { work: 0.9 }, latencyMs: 11, orders: [{ ms: 9, completed: true }, { ms: 11, completed: true }] });
  state.credential.mockReset(); state.quota.mockReset();
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(state.home, { recursive: true, force: true }); });

describe("durable routing telemetry", () => {
  it("records a greeting against its human timestamp without retaining message text", async () => {
    const { routeSession } = await import("./session-router.js");
    expect(await routeSession(context(), { classifier })).toEqual({ deferQueue: true });
    const persisted = await entries();
    expect(persisted.find((entry) => entry.key === "modelRouteAttempt")?.value).toEqual({
      v: 1, at: expect.any(Number), mode: "shadow", tableVersion: "fixture-v1", threshold: 0.8, seq: 1,
      userMessageAt: 1234, predicate: { result: "no", probability: 0.01, latencyMs: 7 },
      decision: "none", noLockReason: "predicate-no", actual: "usual-provider/usual-model", totalMs: expect.any(Number),
    });
    expect(JSON.stringify(persisted)).not.toContain("private message canary");
  });
  it("records a greeting then a routed lock, publishes the shadow pick, and stops attempts when locked", async () => {
    const { routeSession } = await import("./session-router.js");
    const trace = vi.fn();
    await routeSession({ ...context(), onTraceMetadata: trace }, { classifier });
    await entries();
    classifier.checkWorkRequest.mockResolvedValue({ status: "ok", isWorkRequest: true, probability: 0.99, latencyMs: 7 });
    const deps = { classifier, readQuota: async () => ({
      claude: { status: "known" as const, exhausted: false, pace: 0.8, telemetry: { ageSeconds: 15, fiveHour: "ok" as const, pace: 0.8 } },
      chatgpt: { status: "known" as const, exhausted: false, pace: 0.5, telemetry: { ageSeconds: 10, fiveHour: "absent" as const, pace: 0.5 } },
    }) };
    expect(await routeSession({ ...context(), userMessageAt: 2345, onTraceMetadata: trace }, deps)).toEqual({});
    let persisted = await entries();
    const attempts = persisted.filter((entry) => entry.key === "modelRouteAttempt").map((entry) => entry.value);
    const lock = persisted.find((entry) => entry.key === "modelRoute").value;
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ seq: 2, userMessageAt: 2345, decision: "routed", poolReason: "preference", pool: "chatgpt", proposed: "openai-codex/gpt", effort: "high", actual: "usual-provider/usual-model",
      classify: { result: "ok", category: "work", score: 0.9, latencyMs: 11, orders: [{ ms: 9, completed: true }, { ms: 11, completed: true }] },
      quota: { claude: { ageSeconds: 15, fiveHour: "ok", pace: 0.8 }, chatgpt: { ageSeconds: 10, fiveHour: "absent", pace: 0.5 } } });
    expect(lock).toMatchObject({ mode: "shadow", tableVersion: "fixture-v1", category: "work", score: 0.9, pool: "chatgpt" });
    expect(trace).toHaveBeenLastCalledWith({ routingMode: "shadow", routingTableVersion: "fixture-v1", routingState: "locked-routed", routingActual: "usual-provider/usual-model", routingProposed: "openai-codex/gpt", routingCategory: "work", routingScore: 0.9, routingPool: "chatgpt" });
    await routeSession({ ...context(), onTraceMetadata: trace }, deps);
    persisted = await entries();
    expect(persisted.filter((entry) => entry.key === "modelRouteAttempt")).toHaveLength(2);
  });

  it("uses host quota by default so an exhausted ChatGPT pool changes the enforced pick", async () => {
    const { routeSession } = await import("./session-router.js");
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const access = "header." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "private-account-canary" } })).toString("base64url") + ".sig";
    state.credential.mockImplementation((provider) => ({ type: "oauth", access: provider === "anthropic" ? "private-token-canary" : access }));
    state.quota.mockImplementation(({ provider }) => ({ provider, accountRef: "private-account-canary", status: "known", stale: false, updatedAt: now - 30,
      windows: [{ kind: "five-hour", usedPercent: provider === "anthropic" ? 10 : 100, resetAt: now + 1000, windowSeconds: 18000 }] }));
    classifier.checkWorkRequest.mockResolvedValue({ status: "ok", isWorkRequest: true, probability: 0.99, latencyMs: 7 });
    expect(await routeSession({ ...context(), config: { ...config, mode: "enforce" } }, { classifier })).toEqual({ model: { provider: "anthropic", model: "claude" }, effort: "medium", suppressFallback: true });
    const persisted = await entries();
    expect(persisted.find((entry) => entry.key === "modelRouteAttempt").value).toMatchObject({ decision: "routed", pool: "claude", poolReason: "5h-exhausted", proposed: "anthropic/claude", actual: "anthropic/claude", quota: {
      claude: { ageSeconds: 30, fiveHour: "ok", pace: null }, chatgpt: { ageSeconds: 30, fiveHour: "exhausted", pace: null },
    } });
    expect(JSON.stringify(persisted)).not.toContain("private-account-canary");
    expect(JSON.stringify(persisted)).not.toContain("private-token-canary");
  });

  it.each([
    ["low score", 0.7999, "unknown", "usual", undefined],
    ["unknown quota", 0.8, "unknown", "usual", "quota-unknown"],
    ["stale quota", 0.9, "stale", "usual", "quota-stale"],
    ["both exhausted", 0.9, "exhausted", "none", "both-5h-exhausted"],
  ] as const)("records the %s outcome and agrees with its lock", async (_label, score, quotaState, decision, poolReason) => {
    const { routeSession } = await import("./session-router.js");
    classifier.checkWorkRequest.mockResolvedValue({ status: "ok", isWorkRequest: true, probability: 0.99, latencyMs: 7 });
    classifier.classifyCategory.mockResolvedValue({ status: "ok", category: "work", score, probabilities: { work: score }, latencyMs: 11, orders: [null, null] });
    await routeSession({ ...context(), config: { ...config, table: config.table.map((row) => ({ ...row, pool: "either" })) } }, { classifier, readQuota: async () => {
      const value = quotaState === "exhausted" ? { status: "known" as const, exhausted: true } : { status: "unknown" as const, ...(quotaState === "stale" ? { reason: "stale" } : {}) };
      return { claude: value, chatgpt: value };
    } });
    const persisted = await entries();
    const attempt = persisted.find((entry) => entry.key === "modelRouteAttempt").value;
    const lock = persisted.find((entry) => entry.key === "modelRoute")?.value;
    expect(attempt).toMatchObject({ decision, classify: { score }, actual: "usual-provider/usual-model" });
    expect(attempt.poolReason).toBe(poolReason);
    if (decision === "none") {
      expect(attempt.noLockReason).toBe("both-5h-exhausted");
      expect(attempt.quota).toBeDefined();
      expect(lock).toBeUndefined();
    } else {
      expect(lock).toMatchObject({ kind: "usual", mode: attempt.mode, tableVersion: attempt.tableVersion, category: "work", score });
      expect(attempt.pool).toBeUndefined();
    }
  });

  it.each(["predicate", "category"] as const)("records unavailable %s independently from a real no and retries next message", async (step) => {
    const { routeSession } = await import("./session-router.js");
    classifier.checkWorkRequest.mockResolvedValue({ status: "ok", isWorkRequest: true, probability: 0.99, latencyMs: 7 });
    if (step === "predicate") classifier.checkWorkRequest.mockResolvedValueOnce({ status: "unavailable", reason: "no_key", latencyMs: 2 });
    else classifier.classifyCategory.mockResolvedValueOnce({ status: "unavailable", reason: "timeout", latencyMs: 50, orders: [{ ms: 10, completed: true }, { ms: 50, completed: false }] });
    await routeSession(context(), { classifier });
    const first = (await entries()).find((entry) => entry.key === "modelRouteAttempt").value;
    expect(first).toMatchObject({ decision: "none", noLockReason: step === "predicate" ? "predicate-unavailable" : "classify-unavailable" });
    expect(step === "predicate" ? first.predicate : first.classify).toMatchObject({ result: "unavailable", reason: step === "predicate" ? "no_key" : "timeout" });
    await routeSession(context(), { classifier });
    expect((await entries()).filter((entry) => entry.key === "modelRouteAttempt")).toHaveLength(2);
  });

  it.each(["predicate", "category"] as const)("projects an unexpected %s exception to provider_error without its text", async (step) => {
    const { routeSession } = await import("./session-router.js");
    classifier.checkWorkRequest.mockResolvedValue({ status: "ok", isWorkRequest: true, probability: 0.99, latencyMs: 7 });
    if (step === "predicate") classifier.checkWorkRequest.mockRejectedValueOnce(new Error("private error canary"));
    else classifier.classifyCategory.mockRejectedValueOnce(new Error("private error canary"));
    await routeSession(context(), { classifier });
    const attempt = (await entries()).find((entry) => entry.key === "modelRouteAttempt").value;
    expect(step === "predicate" ? attempt.predicate : attempt.classify).toMatchObject({ result: "unavailable", reason: "provider_error", latencyMs: expect.any(Number) });
    expect(JSON.stringify(attempt)).not.toContain("private error canary");
  });

  it("keeps an unknown classified category distinct from classifier failure", async () => {
    const { routeSession } = await import("./session-router.js");
    classifier.checkWorkRequest.mockResolvedValue({ status: "ok", isWorkRequest: true, probability: 0.99, latencyMs: 7 });
    classifier.classifyCategory.mockResolvedValue({ status: "ok", category: "removed-category", score: 0.9, probabilities: {}, latencyMs: 11, orders: [null, null] });
    await routeSession(context(), { classifier });
    expect((await entries()).find((entry) => entry.key === "modelRouteAttempt").value).toMatchObject({ decision: "none", noLockReason: "category-not-in-table", classify: { result: "ok", category: "removed-category" } });
  });

  it("records quota-read failure without fabricating selection facts", async () => {
    const { routeSession } = await import("./session-router.js");
    classifier.checkWorkRequest.mockResolvedValue({ status: "ok", isWorkRequest: true, probability: 0.99, latencyMs: 7 });
    await routeSession(context(), { classifier, readQuota: async () => { throw new Error("quota account canary"); } });
    const attempt = (await entries()).find((entry) => entry.key === "modelRouteAttempt").value;
    expect(attempt).toMatchObject({ decision: "none", noLockReason: "quota-read-failed", classify: { result: "ok" } });
    expect(attempt.quota).toBeUndefined();
    expect(attempt.proposed).toBeUndefined();
  });

  it("keeps proposed and quota facts when lock persistence fails", async () => {
    const { routeSession } = await import("./session-router.js");
    classifier.checkWorkRequest.mockResolvedValue({ status: "ok", isWorkRequest: true, probability: 0.99, latencyMs: 7 });
    const append = fs.appendFile.bind(fs);
    vi.spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (String(args[1]).includes('"key":"modelRoute"')) throw new Error("lock disk failure");
      return append(...args);
    });
    expect(await routeSession({ ...context(), config: { ...config, mode: "enforce" } }, { classifier })).toEqual({ deferQueue: true });
    expect((await entries()).find((entry) => entry.key === "modelRouteAttempt").value).toMatchObject({ decision: "none", noLockReason: "lock-write-failed", pool: "chatgpt", proposed: "openai-codex/gpt", actual: "usual-provider/usual-model", quota: { claude: { ageSeconds: null } } });
  });

  it("keeps its own measured facts when another writer's lock wins", async () => {
    const { routeSession } = await import("./session-router.js");
    const { appendSessionMeta } = await import("../history/store.js");
    classifier.checkWorkRequest.mockResolvedValue({ status: "ok", isWorkRequest: true, probability: 0.99, latencyMs: 7 });
    classifier.classifyCategory.mockImplementationOnce(async () => {
      await appendSessionMeta(agent.id, "session", "modelRoute", { version: 1, kind: "routed", mode: "enforce", provider: "winner", model: "winner-model", category: "work", score: 0.95, tableVersion: "fixture-v1", pool: "claude", reason: "pace", decidedAt: "2026-11-01T00:00:00.000Z" });
      return { status: "ok", category: "work", score: 0.9, probabilities: {}, latencyMs: 11, orders: [null, null] };
    });
    expect(await routeSession({ ...context(), config: { ...config, mode: "enforce" } }, { classifier })).toMatchObject({ model: { provider: "winner", model: "winner-model" } });
    expect((await entries()).find((entry) => entry.key === "modelRouteAttempt").value).toMatchObject({ decision: "none", noLockReason: "lock-lost", classify: { score: 0.9 }, pool: "chatgpt", proposed: "openai-codex/gpt", actual: "winner/winner-model" });
  });

  it("returns the enforced decision before a pending attempt append and tolerates its rejection", async () => {
    const { routeSession } = await import("./session-router.js");
    classifier.checkWorkRequest.mockResolvedValue({ status: "ok", isWorkRequest: true, probability: 0.99, latencyMs: 7 });
    const append = fs.appendFile.bind(fs);
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(fs, "appendFile").mockImplementation(async (...args) => String(args[1]).includes('"key":"modelRouteAttempt"') ? pending : append(...args));
    expect(await routeSession({ ...context(), config: { ...config, mode: "enforce" } }, { classifier })).toMatchObject({ model: { provider: "openai-codex", model: "gpt" }, effort: "high", suppressFallback: true });
    reject(new Error("private disk error canary"));
    await entries();
    expect(warning).toHaveBeenCalledWith(JSON.stringify({ level: "warn", msg: "[model-routing] telemetry write failed" }));
  });

  it.each(["off", "scheduler", "scheduler-id", "dream", "compact", "agent", "background", "blank", "opt-out", "model", "non-pi"] as const)("writes nothing and publishes no trace for %s runs", async (kind) => {
    const { routeSession } = await import("./session-router.js");
    const trace = vi.fn();
    const input = { ...context(), onTraceMetadata: trace };
    if (kind === "off") input.config = { ...config, mode: "off" };
    if (kind === "scheduler") input.source = "scheduler";
    if (kind === "scheduler-id") input.sessionId = "scheduler-job";
    if (kind === "blank") input.message = "  ";
    if (kind === "dream") input.sessionId = "dream:session";
    if (kind === "compact") input.sessionId = "compact:session";
    if (kind === "opt-out") input.agent = { ...agent, modelRouting: { enabled: false } };
    if (kind === "non-pi") input.sdk = "openclaw";
    const extra = kind === "agent" ? { sender: { kind: "agent" } } : kind === "background" ? { background: true } : kind === "model" ? { model: { provider: "usual-provider", model: "usual-model" } } : {};
    expect(await routeSession({ ...input, ...extra }, { classifier })).toEqual({});
    expect((await entries()).filter((entry) => entry.key === "modelRouteAttempt")).toHaveLength(0);
    expect(trace).not.toHaveBeenCalled();
  });

  it("does no classifier work or attempt write when reading the lock fails", async () => {
    const { routeSession } = await import("./session-router.js");
    const read = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith(".jsonl")) throw new Error("private read error canary");
      return read(...args);
    });
    expect(await routeSession(context(), { classifier })).toEqual({ deferQueue: true });
    expect(classifier.checkWorkRequest).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect((await entries()).filter((entry) => entry.key === "modelRouteAttempt")).toHaveLength(0);
  });

  it("publishes a usual lock's stored table version after a mode flip without inventing a pool", async () => {
    const { routeSession } = await import("./session-router.js");
    classifier.checkWorkRequest.mockResolvedValue({ status: "ok", isWorkRequest: true, probability: 0.99, latencyMs: 7 });
    const trace = vi.fn();
    await routeSession({ ...context(), onTraceMetadata: trace, config: { ...config, table: config.table.map((row) => ({ ...row, pool: "either" })) } }, { classifier });
    await entries();
    await routeSession({ ...context(), onTraceMetadata: trace, config: { ...config, mode: "enforce", version: "fixture-v2" } }, { classifier });
    expect(trace).toHaveBeenLastCalledWith({ routingMode: "enforce", routingTableVersion: "fixture-v1", routingState: "locked-usual", routingActual: "usual-provider/usual-model", routingProposed: "usual-provider/usual-model", routingCategory: "work", routingScore: 0.9 });
    expect((await entries()).filter((entry) => entry.key === "modelRouteAttempt")).toHaveLength(1);
  });

});
