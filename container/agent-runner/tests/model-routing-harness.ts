import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import http from "node:http";
import { promisify } from "node:util";
import type { buildRoutingReport } from "../../../apps/gateway/src/model-routing/report.js";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, expect, vi } from "vitest";
import { AgentConfigSchema, type ContainerInput, type RunAgentResult, type ThinkLevel, type ModelRoutingConfig, type FullHistoryMessage } from "@yoplai/shared";
import type { ClassifierModel, ClassifierResult, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ClassifierRuntime } from "../../../apps/gateway/src/model-routing/classifier.js";
import { startGatewayHotReload } from "../../../apps/gateway/src/config/hot-reload.js";
import { CONFIG_DIR, reloadConfig } from "../../../apps/gateway/src/config/index.js";
import { api } from "../../../apps/gateway/src/server/api.core.js";
import { readSessionMeta } from "../../../apps/gateway/src/history/store.js";
import { readRoutingSessions } from "../../../apps/gateway/src/model-routing/session-reader.js";
import { agentEventBus, type AgentHistoryEvent } from "../../../apps/gateway/src/agents/events.js";
import { abortSession, deleteSession, isStreaming } from "../../../apps/gateway/src/agents/sessions.js";
import { piAdapter } from "../../../apps/gateway/src/sdk/pi/adapter.js";
import { modelQuotaStore } from "../../../apps/gateway/src/model-quota/runtime.js";
import { resolveLoginIdentity } from "../../../apps/gateway/src/model-quota/identity.js";
import { setSessionAutoTitleDepsForTests, resetSessionAutoTitleDepsForTests } from "../../../apps/gateway/src/maintenance/session-auto-title.js";
import { runAgentRunner, writeProtocolOutput } from "../src/index.js";

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
    activeRuntime: undefined as string | undefined,
    dockerErrors: [] as Error[],
    spawnDocker: undefined as ((args: string[]) => ChildProcess) | undefined,
    execDocker: undefined as ((args: string[]) => Promise<string>) | undefined,
  };
});

// Never let Docker escape to the host, even when production catches an error.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  function intercept(method: "spawn" | "execFile" | "execFileSync") {
    const wrapped = (...args: unknown[]) => {
      if (args[0] !== "docker") return Reflect.apply(original[method], original, args);
      const command = args[1] as string[];
      const allowed = method === "spawn" ? command[0] === "run"
        : (command[0] === "network" && command[1] === "connect" && command.length === 4)
          || (command[0] === "inspect" && command[1] === "--format" && command[2] === "{{.State.Running}}" && command.length === 4)
          || (["stop", "kill"].includes(command[0]) && command.length === 2);
      if (setup.activeRuntime !== "container" || !allowed) {
        const error = new Error(`Unexpected Docker ${method}: ${command.join(" ")} (${setup.activeRuntime})`);
        setup.dockerErrors.push(error);
        throw error;
      }
      if (method === "spawn") return setup.spawnDocker!(command);
      // No synchronous lifecycle operation is needed by this bridge.
      if (method === "execFileSync") {
        const error = new Error(`Unexpected synchronous Docker command: ${command.join(" ")}`);
        setup.dockerErrors.push(error);
        throw error;
      }
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      void setup.execDocker!(command).then((stdout) => callback(null, stdout, ""), (error: Error) => callback(error, "", ""));
      return new EventEmitter();
    };
    if (method === "execFile") Object.defineProperty(wrapped, promisify.custom, {
      value: (...args: unknown[]) => new Promise((resolve, reject) => {
        wrapped(...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }));
      }),
    });
    return wrapped;
  }
  return { ...original, spawn: intercept("spawn"), execFile: intercept("execFile"), execFileSync: intercept("execFileSync") };
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

// pnpm resolves a separate SDK for the runner; keep both real runtimes offline.
vi.mock("../node_modules/@earendil-works/pi-coding-agent", async (importOriginal) => {
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

export const routingRuntimes = ["host", "container"] as const;
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
  setup.activeRuntime = runtime;
  setup.dockerErrors = [];
  const id = `routing${++serial}`;
  const workspace = path.join(CONFIG_DIR, "agents", id);
  await fs.mkdir(workspace, { recursive: true });
  const agent = AgentConfigSchema.parse({
    id, name: "Routing E2E", sdk: "pi", workspace, model: { provider: "route-usual", model: "usual" },
    fallback_model: { provider: "route-fallback", model: "fallback" }, thinkLevel: "low", modelRouting: { enabled: true },
    retryMaxAttempts: 1, retryBaseDelay: 0.001,
    ...(runtime === "container" ? { sandbox: { enabled: true } } : {}),
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
  const containerInputs: ContainerInput[] = [];
  const children = new Map<string, { done: Promise<void>; running: boolean }>();
  let runnerTail = Promise.resolve();
  const bridgeErrors: Error[] = [];
  const receivedFollowUps = new Set<string>();
  const gateway = runtime === "container" ? http.createServer((_request, response) => {
    bridgeErrors.push(new Error("Unexpected gateway call from chat fixture"));
    response.writeHead(500).end();
  }) : undefined;
  if (gateway) await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway?.address();
  const gatewayUrl = address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : "";
  setup.spawnDocker = (args) => {
    const mounts = args.flatMap((arg, index) => {
      if (arg !== "--mount") return [];
      const fields = Object.fromEntries(args[index + 1].split(",").map((field) => field.split("=")));
      if (fields.type !== "bind" || !fields.source || !fields.target) throw new Error("Invalid bind mount");
      const relative = path.relative(setup.home, fields.source);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Mount outside temporary HOME");
      return [{ source: fields.source, target: fields.target }];
    }).sort((a, b) => b.target.length - a.target.length);
    const mapPath = (value: string) => {
      const mount = mounts.find(({ target }) => value === target || value.startsWith(`${target}/`));
      if (!mount) throw new Error(`Unmapped runner path: ${value}`);
      return path.join(mount.source, value.slice(mount.target.length));
    };
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null,
    });
    const name = args[args.indexOf("--name") + 1];
    const state = { done: Promise.resolve(), running: true };
    children.set(name, state);
    let raw = "";
    const stdin = new Writable({
      write(chunk, _encoding, callback) { raw += chunk.toString(); callback(); },
      final(callback) {
        state.done = runnerTail.then(async () => {
          const keys = ["YOPLAI_GATEWAY_URL", "YOPLAI_AGENT_TOKEN", "YOPLAI_DASHBOARD_URL_PREFIX", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"];
          const previous = keys.map((key) => [key, process.env[key]] as const);
          try {
            const input = JSON.parse(raw) as ContainerInput;
            containerInputs.push(input);
            adapterCalls.push({ sessionId: input.sessionId, model: input.sdkConfig.model, thinkLevel: input.thinkLevel, fallback: input.sdkConfig.fallbackModel });
            const mapped = { ...input, workspaceDir: mapPath(input.workspaceDir), sessionDir: mapPath(input.sessionDir), ipcDir: mapPath(input.ipcDir), gatewayUrl };
            await runAgentRunner({
              readStdin: async () => JSON.stringify(mapped),
              writeStdout: (chunk) => { child.stdout.write(chunk); },
              writeStderr: (chunk) => {
                if (chunk.startsWith("[agent-runner] Received follow-up IPC message")) receivedFollowUps.add(input.sessionId);
                child.stderr.write(chunk);
              },
            }).catch((error: unknown) => {
              // Match index.ts's executable-entry catch: fatal errors are frames.
              writeProtocolOutput({ text: "", error: error instanceof Error ? error.message : String(error) }, (chunk) => { child.stdout.write(chunk); });
              child.exitCode = 1;
            });
            child.exitCode ??= 0;
          } catch (error) {
            bridgeErrors.push(error instanceof Error ? error : new Error(String(error)));
            child.exitCode = 1;
          } finally {
            for (const [key, value] of previous) {
              if (value === undefined) delete process.env[key];
              else process.env[key] = value;
            }
            state.running = false;
          }
        });
        runnerTail = state.done;
        void state.done.then(() => {
          child.stdout.end(); child.stderr.end();
          child.emit("close", child.exitCode);
        });
        callback();
      },
    });
    return Object.assign(child, { stdin }) as unknown as ChildProcess;
  };
  setup.execDocker = async (args) => {
    const child = children.get(args.at(-1)!);
    if (!child) throw new Error("Unknown fake container");
    if (args[0] === "inspect") return String(child.running);
    if (args[0] !== "network") await bounded(child.done);
    return "";
  };
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
    async waitForFollowUp() {
      if (runtime === "container") await poll(() => receivedFollowUps.has(sessionId), Boolean);
    },
    assertContainerInput(expected: { model: string; thinkLevel: ThinkLevel; fallback: boolean }) {
      if (runtime !== "container") return;
      const input = containerInputs.filter((input) => input.sessionId === sessionId).at(-1);
      expect(input).toMatchObject({ sdkConfig: { model: { provider: `route-${expected.model}`, model: expected.model } }, thinkLevel: expected.thinkLevel });
      if (expected.fallback) expect(input?.sdkConfig.fallbackModel).toEqual({ provider: "route-fallback", model: "fallback" });
      else expect(input?.sdkConfig).not.toHaveProperty("fallbackModel");
    },
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
      for (const session of sessionIds) abortSession(id, session);
      for (const gate of gates.values()) gate.release();
      try {
        for (const session of sessionIds) { await waitIdle(session); deleteSession(id, session); }
      } finally {
        try {
          await bounded(runnerTail);
        } finally {
          gateway?.closeAllConnections();
          if (gateway) await new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
          setup.activeRuntime = undefined;
          setup.spawnDocker = undefined; setup.execDocker = undefined;
          quotaReadFailure?.mockRestore(); adapterSpy.mockRestore(); off(); clock.mockRestore(); resetSessionAutoTitleDepsForTests();
        }
      }
      const errors = [...setup.dockerErrors, ...bridgeErrors];
      if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
    },
  };
}
