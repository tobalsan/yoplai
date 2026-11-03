import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { buildRoutingReport } from "../../../apps/gateway/src/model-routing/report.js";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, vi } from "vitest";
import { AgentConfigSchema, type RunAgentResult, type ThinkLevel, type ModelRoutingConfig, type FullHistoryMessage } from "@yoplai/shared";
import type { ClassifierModel, ClassifierResult, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ClassifierRuntime } from "../../../apps/gateway/src/model-routing/classifier.js";
import { startGatewayHotReload } from "../../../apps/gateway/src/config/hot-reload.js";
import { CONFIG_DIR, reloadConfig } from "../../../apps/gateway/src/config/index.js";
import { api } from "../../../apps/gateway/src/server/api.core.js";
import { readSessionMeta } from "../../../apps/gateway/src/history/store.js";
import { readRoutingSessions } from "../../../apps/gateway/src/model-routing/session-reader.js";
import { agentEventBus, type AgentHistoryEvent } from "../../../apps/gateway/src/agents/events.js";
import { deleteSession, isStreaming } from "../../../apps/gateway/src/agents/sessions.js";
import { piAdapter } from "../../../apps/gateway/src/sdk/pi/adapter.js";
import { modelQuotaStore } from "../../../apps/gateway/src/model-quota/runtime.js";
import { resolveLoginIdentity } from "../../../apps/gateway/src/model-quota/identity.js";
import { setSessionAutoTitleDepsForTests, resetSessionAutoTitleDepsForTests } from "../../../apps/gateway/src/maintenance/session-auto-title.js";

const setup = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(process.cwd(), ".routing-e2e-"));
  const previous = { HOME: process.env.HOME, YOPLAI_HOME: process.env.YOPLAI_HOME, OPENAI_API_KEY: process.env.OPENAI_API_KEY, PI_OFFLINE: process.env.PI_OFFLINE };
  process.env.HOME = home;
  process.env.YOPLAI_HOME = path.join(home, "config");
  process.env.PI_OFFLINE = "1";
  const { fauxProvider } = await import("@earendil-works/pi-ai/providers/faux");
  return {
    home, previous,
    providers: ["usual", "claude", "chatgpt", "fallback"].map((id) => fauxProvider({ provider: `route-${id}`, models: [{ id, reasoning: true }] })),
    classifier: undefined as ClassifierRuntime | undefined,
    classifierCreates: 0,
  };
});

// Real chat runtime; only its external providers are replaced.
vi.mock("../../../apps/gateway/node_modules/@earendil-works/pi-coding-agent", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...sdk,
    ModelRuntime: {
      create: async (...args: Parameters<typeof sdk.ModelRuntime.create>) => {
        const runtime = await sdk.ModelRuntime.create({ ...args[0], modelsPath: null, refreshOnCreate: false });
        for (const faux of setup.providers) runtime.registerNativeProvider({
          ...faux.provider,
          auth: { apiKey: { name: "Synthetic", resolve: async () => ({ auth: { apiKey: "fixture-chat" } }) } },
        });
        return runtime;
      },
    },
  };
});

// Preserve key checks, deadline/abort handling, category averaging and mapping.
vi.mock("../../../apps/gateway/src/model-routing/classifier.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../apps/gateway/src/model-routing/classifier.js")>();
  return {
    ...original,
    createRoutingClassifier: (config: ModelRoutingConfig) => original.createRoutingClassifier(config, {
      createRuntime: async () => {
        setup.classifierCreates++;
        if (!setup.classifier) throw new Error("No classifier fixture");
        return setup.classifier;
      },
    }),
  };
});

afterAll(async () => {
  for (const [key, value] of Object.entries(setup.previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(setup.home, { recursive: true, force: true });
});

export const routingRuntimes = ["host"] as const;
export type RoutingRuntime = typeof routingRuntimes[number];
export type ProviderCall = { provider: string; model: string; messages: Message[]; thinking: unknown };
export type AdapterCall = { sessionId: string; model: { provider?: string; model?: string }; thinkLevel?: ThinkLevel; fallback: unknown };
export type ClassifierCall = { question: string; text: string; aborted: boolean; startedAt: number; abortedAt?: number };
const classifierModel: ClassifierModel<"openai-decisions"> = {
  type: "classifier", api: "openai-decisions", provider: "openai", id: "gpt-6-luna", name: "Fixture classifier",
  baseUrl: "https://invalid.test", input: ["text"], contextWindow: 10000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export async function bounded<T>(promise: Promise<T>, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Routing E2E exceeded ${ms} ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export async function poll<T>(read: () => Promise<T> | T, ready: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 4000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (performance.now() >= deadline) throw new Error("Routing E2E poll exceeded 4000 ms");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function barrier() {
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, wait: async () => { enter(); await released; } };
}

let serial = 0;
export type RoutingHarness = Awaited<ReturnType<typeof createRoutingHarness>>;
export async function createRoutingHarness(runtime: RoutingRuntime) {
  if (runtime !== "host") throw new Error(`Unsupported runtime ${runtime}`);
  const id = `routing${++serial}`;
  const workspace = path.join(CONFIG_DIR, "agents", id);
  await fs.mkdir(workspace, { recursive: true });
  const agent = AgentConfigSchema.parse({
    id, name: "Routing E2E", sdk: "pi", workspace, model: { provider: "route-usual", model: "usual" },
    fallback_model: { provider: "route-fallback", model: "fallback" }, thinkLevel: "low", modelRouting: { enabled: true },
    retryMaxAttempts: 1, retryBaseDelay: 0.001,
  });
  await fs.writeFile(path.join(workspace, "agent.yaml"), JSON.stringify(agent));
  for (const name of ["AGENTS.md", "USER.md"]) await fs.writeFile(path.join(workspace, name), "Isolated routing fixture.");
  let config = {
    version: 3, agents: [workspace], extensions: {},
    modelRouting: {
      mode: "enforce", version: "e2e-v1", floor: [],  maxRetries: 0,
      budgets: { predicateMs: 35, categoryMs: 55 },
      table: ["work", "other"].map((category) => ({
        id: category, definition: `Tasks for ${category}`, examples: [`Example ${category} task`], pool: "prefer_chatgpt",
        claude: { provider: "route-claude", model: "claude", effort: "medium" },
        chatgpt: { provider: "route-chatgpt", model: "chatgpt", effort: "high" },
      })),
    },
  };
  await fs.writeFile(path.join(CONFIG_DIR, "yoplai.json"), JSON.stringify(config));
  reloadConfig();
  process.env.OPENAI_API_KEY = "fixture-classifier";
  const now = Date.now;
  let offset = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + offset);
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url");
  const credentials = {
    anthropic: { type: "oauth", access: "fixture-claude", refresh: "fixture-refresh", expires: 1_900_000_000_000 },
    "openai-codex": { type: "oauth", access: `fixture.${payload}.fixture`, refresh: "fixture-refresh", expires: 1_900_000_000_000 },
  };
  const authPath = path.join(CONFIG_DIR, "auth.json");
  async function seedQuota(state: "fresh" | "exhausted" | "error" | "expired" | "pro") {
    // Evict prior observations through the production credential-removal path.
    await fs.writeFile(authPath, "{}");
    for (const provider of ["anthropic", "openai-codex"] as const) {
      const identity = resolveLoginIdentity(provider, credentials[provider]);
      if (!identity) throw new Error("Synthetic credential identity missing");
      modelQuotaStore.get(identity);
    }
    await fs.writeFile(authPath, JSON.stringify(credentials));
    for (const provider of ["anthropic", "openai-codex"] as const) {
      const identity = resolveLoginIdentity(provider, credentials[provider]);
      if (!identity) throw new Error("Synthetic credential identity missing");
      const source = provider === "anthropic" ? "headers" : "wham-usage";
      if (state === "error") { modelQuotaStore.markError(identity, source, "timeout"); continue; }
      const seconds = Date.now() / 1000;
      modelQuotaStore.record(identity, source, [
        ...(state === "pro" && provider === "openai-codex" ? [] : [{
          kind: "five-hour" as const, usedPercent: state === "exhausted" && provider === "anthropic" ? 100 : 10,
          resetAt: seconds + 9000, windowSeconds: 18000,
        }]),
        { kind: "weekly", usedPercent: state === "pro" && provider === "openai-codex" ? 30 : 20,
          resetAt: seconds + 302400, windowSeconds: 604800 },
      ], seconds);
    }
    if (state === "expired") offset += 1_201_000;
  }
  await seedQuota("fresh");
  let quotaReadFailure: ReturnType<typeof vi.spyOn> | undefined;
  setup.classifierCreates = 0;
  const classifier = {
    predicate: true, score: 0.9, hang: undefined as "work_request" | "category" | undefined,
    calls: [] as ClassifierCall[],
    get creates() { return setup.classifierCreates; },
  };
  setup.classifier = {
    getModelOfType: () => classifierModel,
    classify: async (_model, context, options): Promise<ClassifierResult> => {
      const question = Object.keys(context.questions)[0];
      const call: ClassifierCall = { question, text: String(context.state?.text), aborted: false, startedAt: performance.now() };
      classifier.calls.push(call);
      if (classifier.hang === question) await new Promise<void>((resolve) => {
        options?.signal?.addEventListener("abort", () => { call.aborted = true; call.abortedAt = performance.now(); resolve(); }, { once: true });
      });
      return {
        api: "openai-decisions", provider: "openai", model: "gpt-6-luna", stopReason: call.aborted ? "aborted" : "stop", timestamp: Date.now(),
        answers: question === "work_request" ? { work_request: { type: "bool", probability: classifier.predicate ? 0.99 : 0.01 } }
          : { category: { type: "choice", choice: "work", confidence: classifier.score, probabilities: { work: classifier.score, other: 1 - classifier.score } } },
      };
    },
  };
  const modelCalls: ProviderCall[] = [];
  const adapterCalls: AdapterCall[] = [];
  const historyEvents: AgentHistoryEvent[] = [];
  const gates = new Map<string, ReturnType<typeof barrier>>();
  const failures = new Set<string>();
  const reply: FauxResponseFactory = async (context, options, _state, model) => {
    modelCalls.push({ provider: model.provider, model: model.id, messages: structuredClone(context.messages), thinking: options?.reasoning });
    await gates.get(model.id)?.wait();
    return failures.has(model.id)
      ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 invalid_request_error: request rejected" })
      : fauxAssistantMessage(`answer:${model.id}`);
  };
  for (const faux of setup.providers) faux.setResponses(Array.from({ length: 80 }, () => reply));
  setSessionAutoTitleDepsForTests({ complete: async () => "Routing E2E" });
  const run = piAdapter.run.bind(piAdapter);
  const adapterSpy = vi.spyOn(piAdapter, "run").mockImplementation(async (params) => {
    adapterCalls.push({ sessionId: params.sessionId, model: params.model ?? params.agent.model, thinkLevel: params.thinkLevel, fallback: params.agent.fallback_model });
    return run(params);
  });
  const off = agentEventBus.onHistoryEvent((event) => { if (event.agentId === id) historyEvents.push(event); });
  let hotReload: NodeJS.Timeout | undefined;
  let pendingReload: { resolve: () => void; reject: (error: unknown) => void } | undefined;
  let mtimeTick = now();
  const sessionIds = new Set<string>();
  let sessionId = `${id}-session`;
  const waitIdle = async (session = sessionId) => { await poll(() => isStreaming(id, session), (value) => !value); };
  const records = async () => readRoutingSessions(CONFIG_DIR, [id]);
  const attempts = async (count: number, session = sessionId) => {
    return poll(async () => (await records()).find((row) => row.session === session)?.attempts ?? [], (value) => value.length >= count);
  };
  const request = async (suffix: string, method: string, body?: unknown) => {
    const response = await bounded(api.request(`/agents/${id}${suffix}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
    return { status: response.status, body: await response.json() as RunAgentResult & { error?: string; ok?: boolean } };
  };
  return {
    runtime, id, agent, workspace, classifier, modelCalls, adapterCalls, historyEvents, bounded, waitIdle, attempts, failures, gates, seedQuota,
    failQuotaRead() { quotaReadFailure = vi.spyOn(modelQuotaStore, "get").mockImplementation(() => { throw new Error("Synthetic quota read unavailable"); }); },
    restoreQuotaRead() { quotaReadFailure?.mockRestore(); quotaReadFailure = undefined; },
    async changePool(pool: "either" | "prefer_chatgpt") {
      config = { ...config, modelRouting: { ...config.modelRouting, table: config.modelRouting.table.map((row) => ({ ...row, pool })) } };
      await fs.writeFile(path.join(CONFIG_DIR, "yoplai.json"), JSON.stringify(config));
      reloadConfig();
    },
    get config() { return config; },
    get home() { return CONFIG_DIR; },
    get sessionId() { return sessionId; },
    set sessionId(value: string) { sessionId = value; sessionIds.add(value); },
    async send(message: string, extra: Record<string, unknown> = {}) {
      sessionIds.add(sessionId);
      const result = await request("/messages", "POST", { sessionId, message, ...extra });
      if (result.body.meta?.sessionId) sessionIds.add(result.body.meta.sessionId);
      return result;
    },
    async report() {
      await waitIdle();
      const { stdout } = await promisify(execFile)(process.execPath, [
        "--import", "tsx", path.resolve("apps/gateway/src/cli/index.ts"),
        "model-routing", "report", "--since", "2026-11-01", "--agent", id, "--json",
      ], { env: { ...process.env, NODE_OPTIONS: "--conditions=development" }, timeout: 4000 });
      return JSON.parse(stdout) as ReturnType<typeof buildRoutingReport>;
    },
    async changeMode(mode: "off" | "shadow" | "enforce") {
      hotReload ??= startGatewayHotReload(reloadConfig(), {
        intervalMs: 10,
        onReload: () => { pendingReload?.resolve(); pendingReload = undefined; },
        onError: (error) => { pendingReload?.reject(error); pendingReload = undefined; },
      });
      const applied = new Promise<void>((resolve, reject) => { pendingReload = { resolve, reject }; });
      config = { ...config, modelRouting: { ...config.modelRouting, mode } };
      const file = path.join(CONFIG_DIR, "yoplai.json");
      await fs.writeFile(file, JSON.stringify(config));
      mtimeTick += 10;
      await fs.utimes(file, mtimeTick / 1000, mtimeTick / 1000);
      await bounded(applied);
    },
    async history() {
      const response = await api.request(`/agents/${id}/history?sessionId=${sessionId}&view=full`);
      return await response.json() as { messages: FullHistoryMessage[] };
    },
    async compact() { return request("/compact", "POST", { sessionId }); },
    async removeSession() { return request(`/sessions/${sessionId}`, "DELETE"); },
    async restart() {
      await waitIdle();
      const existing = (await records()).find((row) => row.session === sessionId)?.attempts.length ?? 0;
      await attempts(existing);
      deleteSession(id, sessionId);
      reloadConfig();
    },
    async lock(session = sessionId) { return readSessionMeta(id, session, "modelRoute"); },
    async close() {
      clearInterval(hotReload);
      for (const gate of gates.values()) gate.release();
      try {
        for (const session of sessionIds) { await waitIdle(session); deleteSession(id, session); }
      } finally {
        quotaReadFailure?.mockRestore(); adapterSpy.mockRestore(); off(); clock.mockRestore(); resetSessionAutoTitleDepsForTests();
      }
    },
  };
}
