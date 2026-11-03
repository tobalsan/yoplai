import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConfigSchema, GatewayConfigSchema } from "@yoplai/shared";
import type { ThinkLevel } from "@yoplai/shared";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { CONFIG_DIR, setLoadedConfig } from "../config/index.js";
import { runAgent, type InternalRunAgentParams } from "./runner.js";
import { appendCanonicalCompaction, appendSessionMeta, readSessionMeta, getFullHistory } from "../history/store.js";
import { deleteSession } from "./sessions.js";
import { resetSession } from "../sessions/persistence.js";
import { resetSessionAutoTitleDepsForTests, setSessionAutoTitleDepsForTests } from "../maintenance/session-auto-title.js";
import { getMediaInboundDir } from "../media/metadata.js";
import { piAdapter } from "../sdk/pi/adapter.js";
import * as containerAdapterModule from "../sdk/container/adapter.js";
import type { SdkRunParams } from "../sdk/types.js";
import { openclawAdapter } from "../sdk/openclaw/adapter.js";
import { agentEventBus, type AgentHistoryEvent } from "./events.js";
import type { WorkRequestResult, CategoryResult } from "../model-routing/classifier.js";

// ALG-594 Testing Decisions explicitly approve the ALG-492 public runAgent seam:
// real Pi + faux provider catch model/effort/history/queue wiring, not live auth.
const setup = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(process.cwd(), ".routing-test-"));
  process.env.HOME = home;
  const { fauxProvider } = await import("@earendil-works/pi-ai/providers/faux");
  return {
    home, previousHome,
    faux: fauxProvider({ provider: "routing-test", models: [
      { id: "usual", reasoning: true }, { id: "selected", reasoning: true, input: ["text", "image"] }, { id: "other", reasoning: true },
    ] }),
    fallback: fauxProvider({ provider: "routing-fallback", models: [{ id: "fallback", input: ["text"] }] }),
    efforts: [] as Array<ThinkLevel | undefined>,
    beforeCreate: undefined as (() => Promise<void>) | undefined,
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...sdk,
    readStoredCredential: (...args: Parameters<typeof sdk.readStoredCredential>) => args[0] === "routing-test"
      ? { type: "oauth", access: "faux-access", refresh: "faux-refresh", expires: Date.now() + 3_600_000 }
      : sdk.readStoredCredential(...args),
    ModelRuntime: {
      create: async (...args: Parameters<typeof sdk.ModelRuntime.create>) => {
        const runtime = await sdk.ModelRuntime.create(...args);
        runtime.registerNativeProvider({
          ...setup.faux.provider,
          auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
        });
        runtime.registerNativeProvider({
          ...setup.fallback.provider,
          auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
        });
        return runtime;
      },
    },
    createAgentSession: async (...args: Parameters<typeof sdk.createAgentSession>) => {
      setup.efforts.push(args[0]?.thinkingLevel);
      await setup.beforeCreate?.();
      return sdk.createAgentSession(...args);
    },
  };
});

const defaultAgent = AgentConfigSchema.parse({
  id: "routing", name: "Routing", sdk: "pi", workspace: path.join(setup.home, "workspace"),
  model: { provider: "routing-test", model: "usual" }, modelRouting: { enabled: true },
  thinkLevel: "low", retryMaxAttempts: 1, retryBaseDelay: 0.001,
});
let agent = defaultAgent;
const routingConfig = {
  mode: "enforce", version: "fixture-v1", floor: [],
  table: [{ id: "work", definition: "Real work", examples: ["Build a report"], pool: "prefer_chatgpt",
    claude: { provider: "routing-test", model: "other", effort: "medium" },
    chatgpt: { provider: "routing-test", model: "selected", effort: "high" },
  }],
};
let sessionNumber = 0;
let sessionId: string;
let models: string[];
const classifier = {
  checkWorkRequest: vi.fn(async (_input: { text: string; signal?: AbortSignal }): Promise<WorkRequestResult> => ({ status: "ok", latencyMs: 3, isWorkRequest: true, probability: 0.99 })),
  classifyCategory: vi.fn(async (): Promise<CategoryResult> => ({ status: "ok", latencyMs: 3, category: "work", score: 0.9, probabilities: { work: 0.9 }, orders: [{ ms: 2, completed: true }, { ms: 3, completed: true }] })),
};

function configure(mode = "enforce", pool = "prefer_chatgpt") {
  setLoadedConfig(GatewayConfigSchema.parse({ agents: [agent], extensions: {}, modelRouting: { ...routingConfig, mode, table: routingConfig.table.map((row) => ({ ...row, pool })) } }));
}

function send(message: string, extra: Partial<InternalRunAgentParams> = {}) {
  return runAgent({ agentId: agent.id, sessionId, source: "web", message, routingDependencies: { classifier }, ...extra });
}

function barrier() {
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, wait: async () => { enter(); await released; } };
}

beforeEach(async () => {
  // Title generation is a separate external model call, outside the chat turn.
  setSessionAutoTitleDepsForTests({ complete: async () => "Routing test" });
  agent = structuredClone(defaultAgent);
  sessionId = `route-${++sessionNumber}`;
  models = [];
  setup.efforts.length = 0;
  setup.beforeCreate = undefined;
  classifier.checkWorkRequest.mockReset().mockResolvedValue({ status: "ok", latencyMs: 3, isWorkRequest: true, probability: 0.99 });
  classifier.classifyCategory.mockReset().mockResolvedValue({ status: "ok", latencyMs: 3, category: "work", score: 0.9, probabilities: { work: 0.9 }, orders: [{ ms: 2, completed: true }, { ms: 3, completed: true }] });
  await fs.mkdir(agent.workspace, { recursive: true });
  for (const name of ["AGENTS.md", "USER.md"]) await fs.writeFile(path.join(agent.workspace, name), "Routing test workspace.");
  const reply: FauxResponseFactory = (_context, _options, _state, model) => {
    models.push(model.id);
    return fauxAssistantMessage(`answered by ${model.id}`);
  };
  setup.faux.setResponses(Array.from({ length: 20 }, () => reply));
  setup.fallback.setResponses([fauxAssistantMessage("fallback answer")]);
  configure();
  await appendSessionMeta(agent.id, sessionId, "title", "Routing test");
});

afterAll(async () => {
  resetSessionAutoTitleDepsForTests();
  if (setup.previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = setup.previousHome;
  await fs.rm(setup.home, { recursive: true, force: true });
});

describe("session model routing through runAgent", () => {
  it("answers a greeting normally, routes the first work request, and keeps the durable pick", async () => {
    classifier.checkWorkRequest.mockResolvedValueOnce({ status: "ok", latencyMs: 3, isWorkRequest: false, probability: 0.01 });
    await expect(send("hi")).resolves.toMatchObject({ payloads: [{ text: "answered by usual" }] });
    expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toBeUndefined();
    await send("Build a report");
    expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toEqual({
      version: 1, kind: "routed", mode: "enforce", provider: "routing-test", model: "selected", effort: "high",
      category: "work", score: 0.9, tableVersion: "fixture-v1", pool: "chatgpt", reason: "quota-unknown", decidedAt: expect.any(String),
    });
    await send("continue");
    expect(models).toEqual(["usual", "selected", "selected"]);
    expect(setup.efforts).toEqual(["low", "high", "high"]);
    expect(classifier.checkWorkRequest).toHaveBeenCalledTimes(2);
    expect(classifier.classifyCategory).toHaveBeenCalledTimes(1);
  });

  it("locks a low score to the usual snapshot and does not classify again", async () => {
    classifier.classifyCategory.mockResolvedValueOnce({ status: "ok", latencyMs: 3, category: "work", score: 0.79, probabilities: { work: 0.79 }, orders: [{ ms: 2, completed: true }, { ms: 3, completed: true }] });
    await send("Build a report");
    expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toMatchObject({
      kind: "usual", provider: "routing-test", model: "usual", score: 0.79, reason: "score<0.8",
    });
    await send("continue");
    expect(models).toEqual(["usual", "usual"]);
    expect(setup.efforts).toEqual(["low", "low"]);
    expect(classifier.checkWorkRequest).toHaveBeenCalledTimes(1);
    agent.model = { provider: "routing-test", model: "other" };
    configure();
    await send("keep the usual snapshot");
    expect(models).toEqual(["usual", "usual", "usual"]);
    expect(classifier.checkWorkRequest).toHaveBeenCalledTimes(1);
  });

  it.each(["predicate", "category"] as const)("keeps chat available after %s failure, without locking the failure", async (stage) => {
    for (const reason of ["timeout", "no_key", "malformed"] as const) {
      if (stage === "predicate") classifier.checkWorkRequest.mockResolvedValueOnce({ status: "unavailable", latencyMs: 3, reason });
      else classifier.classifyCategory.mockResolvedValueOnce({ status: "unavailable", latencyMs: 3, reason, orders: [null, null] });
      await expect(send("Build a report")).resolves.toMatchObject({ payloads: [{ text: "answered by usual" }] });
      expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toBeUndefined();
    }
    await send("try again");
    expect(models).toEqual(["usual", "usual", "usual", "selected"]);
    expect(classifier.checkWorkRequest).toHaveBeenCalledTimes(4);
  });

  it.each(["streaming", "startup"])("defers work arriving during greeting %s so it gets its own routed run", async (phase) => {
    const gate = barrier();
    classifier.checkWorkRequest.mockResolvedValueOnce({ status: "ok", latencyMs: 3, isWorkRequest: false, probability: 0.01 });
    setup.faux.setResponses([
      async () => { models.push("usual"); if (phase === "streaming") await gate.wait(); return fauxAssistantMessage("hello"); },
      (_context, _options, _state, model) => { models.push(model.id); return fauxAssistantMessage("report"); },
    ]);
    if (phase === "startup") setup.beforeCreate = gate.wait;
    const greeting = send("hi");
    try {
      await gate.entered;
      await expect(send("Build a report")).resolves.toMatchObject({ meta: { queued: true } });
    } finally {
      gate.release();
    }
    await greeting;
    expect(models).toEqual(["usual", "selected"]);
    expect(classifier.checkWorkRequest).toHaveBeenCalledTimes(2);
    expect(classifier.classifyCategory).toHaveBeenCalledTimes(1);
    expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toMatchObject({ model: "selected" });
  });

  it("decides simultaneous work once and restores native queueing when the lock is stored", async () => {
    const gate = barrier();
    let received = "";
    classifier.checkWorkRequest.mockImplementationOnce(async () => {
      await gate.wait();
      return { status: "ok", latencyMs: 3, isWorkRequest: true, probability: 0.99 };
    });
    setup.faux.setResponses([(context, _options, _state, model) => {
      received = context.messages.filter((message) => message.role === "user")
        .map((message) => typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("")).join("|");
      models.push(model.id);
      return fauxAssistantMessage("combined");
    }]);
    const first = send("Build a report");
    try {
      await gate.entered;
      await send("and add a chart");
    } finally { gate.release(); }
    await first;
    expect(models).toEqual(["selected"]);
    expect(received).toContain("Build a report");
    expect(received).toContain("and add a chart");
    expect(classifier.checkWorkRequest).toHaveBeenCalledTimes(1);
    expect(classifier.classifyCategory).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicit /think level when work is deferred behind the greeting", async () => {
    agent.auth = { mode: "oauth" };
    configure();
    const gate = barrier();
    classifier.checkWorkRequest.mockResolvedValueOnce({ status: "ok", latencyMs: 3, isWorkRequest: false, probability: 0.01 });
    setup.faux.setResponses([
      async () => { await gate.wait(); return fauxAssistantMessage("hello"); },
      fauxAssistantMessage("report"),
    ]);
    const greeting = send("hi");
    try {
      await gate.entered;
      await send("/think medium Build a report");
    } finally { gate.release(); }
    await greeting;
    expect(setup.efforts).toEqual(["low", "medium"]);
    expect(classifier.checkWorkRequest).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Build a report" }));
  });

  it("passes Stop to the classifier and completes through the normal abort path", async () => {
    const gate = barrier();
    classifier.checkWorkRequest.mockImplementationOnce(async ({ signal }) => {
      await Promise.race([gate.wait(), new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))]);
      return { status: "unavailable", latencyMs: 3, reason: "aborted" };
    });
    const first = send("Build a report");
    await gate.entered;
    await send("/abort");
    gate.release();
    await expect(first).resolves.toMatchObject({ meta: { aborted: true } });
    expect(models).toEqual([]);
    expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toBeUndefined();
    await send("try again");
    expect(models).toEqual(["selected"]);
  });

  it("records shadow decisions without applying effort, then never promotes the old lock", async () => {
    configure("shadow");
    await send("Build a report");
    const lock = await readSessionMeta(agent.id, sessionId, "modelRoute");
    expect(lock).toMatchObject({ mode: "shadow", kind: "routed", model: "selected" });
    configure("enforce");
    await send("continue");
    expect(models).toEqual(["usual", "usual"]);
    expect(setup.efforts).toEqual(["low", "low"]);
    expect(classifier.checkWorkRequest).toHaveBeenCalledTimes(1);
    expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toEqual(lock);
  });

  it("rolls back immediately in off mode and resumes the same lock on enforce", async () => {
    await send("Build a report");
    const lock = await readSessionMeta(agent.id, sessionId, "modelRoute");
    configure("off");
    await send("continue");
    configure("enforce");
    await send("continue again");
    expect(models).toEqual(["selected", "usual", "selected"]);
    expect(classifier.checkWorkRequest).toHaveBeenCalledTimes(1);
    expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toEqual(lock);
  });

  it("keeps the lock after dropping runtime state and appending canonical compaction", async () => {
    await send("Build a report");
    const lock = await readSessionMeta(agent.id, sessionId, "modelRoute");
    deleteSession(agent.id, sessionId);
    await appendCanonicalCompaction({ agentId: agent.id, sessionId, id: "fixture-compaction", summary: "A report was requested.", recentMessages: [], coveredThrough: 1 });
    await send("continue");
    expect(models).toEqual(["selected", "selected"]);
    expect(classifier.checkWorkRequest).toHaveBeenCalledTimes(1);
    expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toEqual(lock);
  });

  it("starts unrouted after /new through a session key and after direct resetSession", async () => {
    const first = await send("Build a report", { sessionId: undefined, sessionKey: `key-${sessionNumber}` });
    expect(first.payloads).toEqual([{ text: "answered by selected" }]);
    const oldId = first.meta.sessionId!;
    classifier.checkWorkRequest.mockResolvedValueOnce({ status: "ok", latencyMs: 3, isWorkRequest: false, probability: 0.01 });
    const fresh = await send("/new hi", { sessionId: undefined, sessionKey: `key-${sessionNumber}` });
    expect(fresh.payloads).toEqual([{ text: "answered by usual" }]);
    expect(fresh.meta.sessionId).not.toBe(oldId);
    expect(await readSessionMeta(agent.id, fresh.meta.sessionId!, "modelRoute")).toBeUndefined();
    await resetSession(agent.id, oldId);
    expect(await readSessionMeta(agent.id, oldId, "modelRoute")).toBeUndefined();
    await expect(send("Build another report", { sessionId: oldId })).resolves.toMatchObject({ payloads: [{ text: "answered by selected" }] });
    expect(classifier.checkWorkRequest).toHaveBeenCalledTimes(3);
  });

  it.each(["routed", "usual", "unlocked", "shadow"])("keeps the terminal-failure fallback policy for %s sessions", async (kind) => {
    agent.fallback_model = { provider: "routing-fallback", model: "fallback" };
    configure(kind === "shadow" ? "shadow" : "enforce");
    if (kind === "usual") classifier.classifyCategory.mockResolvedValueOnce({ status: "ok", latencyMs: 3, category: "work", score: 0.7, probabilities: { work: 0.7 }, orders: [{ ms: 2, completed: true }, { ms: 3, completed: true }] });
    if (kind === "unlocked") classifier.checkWorkRequest.mockResolvedValueOnce({ status: "ok", latencyMs: 3, isWorkRequest: false, probability: 0.01 });
    const failureReply: FauxResponseFactory = (_context, _options, _state, model) => {
      models.push(model.id);
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 invalid_request_error: request rejected" });
    };
    setup.faux.setResponses([failureReply, failureReply]);
    const fallbackBefore = setup.fallback.state.callCount;
    const onEvent = vi.fn();
    if (kind === "routed" || kind === "usual") {
      await expect(send("Build a report", { onEvent })).rejects.toThrow("request rejected");
      const lock = await readSessionMeta(agent.id, sessionId, "modelRoute");
      expect(lock).toMatchObject({ kind, mode: "enforce" });
      expect(setup.fallback.state.callCount).toBe(fallbackBefore);
      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "error", userMessage: expect.any(String) }));
      await expect(send("retry")).rejects.toThrow("request rejected");
      expect(models).toEqual(kind === "routed" ? ["selected", "selected"] : ["usual", "usual"]);
      expect(classifier.checkWorkRequest).toHaveBeenCalledTimes(1);
      expect(setup.fallback.state.callCount).toBe(fallbackBefore);
      expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toEqual(lock);
    } else {
      await expect(send("Build a report")).resolves.toMatchObject({ payloads: [{ text: "fallback answer" }] });
      expect(setup.fallback.state.callCount).toBe(fallbackBefore + 1);
    }
    expect(agent.fallback_model).toEqual({ provider: "routing-fallback", model: "fallback" });
  });

  it("never runs an unrecorded model when the lock write fails", async () => {
    const append = fs.appendFile.bind(fs);
    const failure = vi.spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (typeof args[1] === "string" && args[1].includes('"key":"modelRoute"')) throw new Error("disk unavailable");
      return append(...args);
    });
    try {
      await expect(send("Build a report")).resolves.toMatchObject({ payloads: [{ text: "answered by usual" }] });
      expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toBeUndefined();
    } finally { failure.mockRestore(); }
    await send("try again");
    expect(models).toEqual(["usual", "selected"]);
  });

  it("locks the agent's own model when either has no comparable quota", async () => {
    configure("enforce", "either");
    await send("Build a report");
    expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toMatchObject({ kind: "usual", model: "usual", reason: "quota-unknown" });
    await send("continue");
    expect(models).toEqual(["usual", "usual"]);
    expect(classifier.checkWorkRequest).toHaveBeenCalledTimes(1);
  });

  it.each(["both-exhausted", "reader-failed"])("leaves the session unrouted when quota is %s", async (failure) => {
    const readQuota = vi.fn(async () => {
      if (failure === "reader-failed") throw new Error("quota store unavailable");
      return { claude: { status: "known" as const, exhausted: true }, chatgpt: { status: "known" as const, exhausted: true } };
    });
    await expect(send("Build a report", { routingDependencies: { classifier, readQuota } })).resolves.toMatchObject({ payloads: [{ text: "answered by usual" }] });
    expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toBeUndefined();
    await send("try again");
    expect(models).toEqual(["usual", "selected"]);
    expect(classifier.checkWorkRequest).toHaveBeenCalledTimes(2);
  });

  it.each(["scheduler", "dream", "heartbeat", "webhook", "orchestrator", "agent", "component", "sender", "background", "compact", "scheduler-id", "dream-id", "explicit-model", "opt-out", "off", "missing-source"])("keeps %s runs outside routing even with a stored lock", async (exclusion) => {
    await send("Build a report");
    const lock = await readSessionMeta(agent.id, sessionId, "modelRoute");
    classifier.checkWorkRequest.mockClear();
    classifier.classifyCategory.mockClear();
    const params: Partial<InternalRunAgentParams> = {};
    if (exclusion === "sender") params.sender = { kind: "agent", agentId: "another-agent" };
    else if (exclusion === "background") params.background = true;
    else if (exclusion === "explicit-model") params.model = { provider: "routing-test", model: "other" };
    else if (exclusion === "missing-source") params.source = undefined;
    else if (["compact", "scheduler-id", "dream-id"].includes(exclusion)) {
      sessionId = `${exclusion === "compact" ? "compact:" : exclusion === "scheduler-id" ? "scheduler" : "dream:"}${sessionId}`;
      await appendSessionMeta(agent.id, sessionId, "title", "Excluded session");
      await appendSessionMeta(agent.id, sessionId, "modelRoute", lock);
    } else if (exclusion === "opt-out") {
      agent.modelRouting = { enabled: false };
      configure();
    } else if (exclusion === "off") configure("off");
    else params.source = exclusion;
    await expect(send("continue", params)).resolves.toMatchObject({ payloads: [{ text: exclusion === "explicit-model" ? "answered by other" : "answered by usual" }] });
    expect(classifier.checkWorkRequest).not.toHaveBeenCalled();
    expect(classifier.classifyCategory).not.toHaveBeenCalled();
    expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toEqual(lock);
  });

  it("keeps chat available when stored routing metadata is malformed", async () => {
    await appendSessionMeta(agent.id, sessionId, "modelRoute", { kind: "routed", mode: "enforce", model: "selected" });
    await expect(send("Build a report")).resolves.toMatchObject({ payloads: [{ text: "answered by usual" }] });
    expect(classifier.checkWorkRequest).not.toHaveBeenCalled();
  });

  it.each(["slack", "discord", "telegram", "mattermost", "irc"])("routes %s human chat through the same hook", async (source) => {
    await send("Build a report", { source });
    expect(models).toEqual(["selected"]);
    expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toMatchObject({ kind: "routed", model: "selected" });
  });

  it.each([
    ["Build a report", "medium", "medium"],
    ["/think medium Build a report", undefined, "medium"],
    ["/think medium Build a report", "low", "low"],
  ] as const)("honors explicit effort for %s with API effort %s", async (message, thinkLevel, expected) => {
    agent.auth = { mode: "oauth" };
    configure();
    classifier.classifyCategory.mockResolvedValueOnce({ status: "ok", latencyMs: 3, category: "work", score: 0.8, probabilities: { work: 0.8 }, orders: [{ ms: 2, completed: true }, { ms: 3, completed: true }] });
    await send(message, { thinkLevel });
    expect(models).toEqual(["selected"]);
    expect(setup.efforts).toEqual([expected]);
    expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toMatchObject({ effort: "high", score: 0.8 });
  });

  it("preserves image input for a locked vision model despite a text-only configured fallback", async () => {
    agent.fallback_model = { provider: "routing-fallback", model: "fallback" };
    configure();
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCVEAAAAASUVORK5CYII=";
    await fs.writeFile(path.join(CONFIG_DIR, "settings.json"), JSON.stringify({ images: { autoResize: false } }));
    await fs.mkdir(getMediaInboundDir(), { recursive: true });
    const file = path.join(getMediaInboundDir(), "pixel.png");
    await fs.writeFile(file, Buffer.from(data, "base64"));
    const images: unknown[] = [];
    setup.faux.setResponses([(context) => {
      for (const message of context.messages) {
        if (message.role === "user" && Array.isArray(message.content)) images.push(...message.content.filter((part) => part.type === "image"));
      }
      return fauxAssistantMessage("image received");
    }]);
    await send("Describe this image", { attachments: [{ path: file, filename: "pixel.png", mimeType: "image/png", size: Buffer.from(data, "base64").length }] });
    expect(images).toEqual([{ type: "image", data, mimeType: "image/png" }]);
  });

  it("uses the durable winner when another writer claims the lock during classification", async () => {
    const winner = {
      version: 1, kind: "routed", mode: "enforce", provider: "routing-test", model: "other", effort: "medium",
      category: "work", score: 0.95, tableVersion: "fixture-v1", pool: "claude", reason: "pace", decidedAt: "2026-11-01T00:00:00.000Z",
    };
    classifier.classifyCategory.mockImplementationOnce(async () => {
      await appendSessionMeta(agent.id, sessionId, "modelRoute", winner);
      return { status: "ok", latencyMs: 3, category: "work", score: 0.9, probabilities: { work: 0.9 }, orders: [{ ms: 2, completed: true }, { ms: 3, completed: true }] };
    });
    await send("Build a report");
    expect(models).toEqual(["other"]);
    expect(setup.efforts).toEqual(["medium"]);
    expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toEqual(winner);
  });

  it("keeps non-Pi SDK runs on the configured model", async () => {
    const config = GatewayConfigSchema.parse({ agents: [agent], extensions: {}, modelRouting: routingConfig });
    // Exercise the runtime guard even if an opted-in agent changes SDK.
    config.agents[0].sdk = "openclaw";
    setLoadedConfig(config);
    const run = vi.spyOn(openclawAdapter, "run").mockImplementation(async (params) => {
      models.push((params.model ?? params.agent.model).model);
      return { text: "non-Pi answer" };
    });
    try {
      await expect(send("Build a report")).resolves.toMatchObject({ payloads: [{ text: "non-Pi answer" }] });
      expect(models).toEqual(["usual"]);
      expect(classifier.checkWorkRequest).not.toHaveBeenCalled();
      expect(await readSessionMeta(agent.id, sessionId, "modelRoute")).toBeUndefined();
    } finally { run.mockRestore(); }
  });
  it("correlates the attempt with the persisted human timestamp and exposes routing on the first traced event", async () => {
    configure("shadow");
    const events: AgentHistoryEvent[] = [];
    let clock = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock++);
    const off = agentEventBus.onHistoryEvent((event) => { if (event.sessionId === sessionId) events.push(event); });
    try { await send("Build a report", { trace: { enabled: true } }); } finally { off(); now.mockRestore(); }
    await appendSessionMeta(agent.id, sessionId, "barrier", true);
    const attempt = await readSessionMeta(agent.id, sessionId, "modelRouteAttempt");
    const human = (await getFullHistory(agent.id, sessionId)).find((entry) => entry.role === "user");
    expect(attempt).toMatchObject({ userMessageAt: human?.timestamp, actual: "routing-test/usual", proposed: "routing-test/selected" });
    expect(events[0]?.trace?.metadata).toMatchObject({ routingMode: "shadow", routingState: "locked-routed", routingActual: "routing-test/usual", routingProposed: "routing-test/selected", routingTableVersion: "fixture-v1" });
  });

  it.each(["host", "container"] as const)("publishes routing metadata before %s trace creation across unrouted, locked and mode-flipped turns", async (kind) => {
    const traces: Array<Record<string, unknown> | undefined> = [];
    const events: AgentHistoryEvent[] = [];
    const fakeRun = async (params: SdkRunParams) => {
      const user = { type: "user" as const, text: params.message, timestamp: Date.now() };
      const system = { type: "system_context" as const, context: { kind: "web" as const }, rendered: "context", timestamp: Date.now() };
      for (const event of kind === "host" ? [system, user] : [user, system]) params.onHistoryEvent(event);
      params.onHistoryEvent({ type: "assistant_text", text: "fake answer", timestamp: Date.now() });
      params.onEvent({ type: "text", data: "fake answer" });
      return { text: "fake answer" };
    };
    const adapter = kind === "host" ? vi.spyOn(piAdapter, "run").mockImplementation(fakeRun)
      : vi.spyOn(containerAdapterModule, "getContainerAdapter").mockReturnValue({ ...piAdapter, run: fakeRun });
    if (kind === "container") agent.sandbox = AgentConfigSchema.parse({ ...agent, sandbox: { enabled: true } }).sandbox;
    const unsubscribe = agentEventBus.onHistoryEvent((event) => events.push(event));
    const turn = async (message: string, extra: Partial<InternalRunAgentParams> = {}) => {
      events.length = 0;
      await send(message, { trace: { enabled: true }, ...extra });
      traces.push(events[0]?.trace?.metadata);
      expect(events.every((event) => event.trace?.metadata?.routingMode === events[0]?.trace?.metadata?.routingMode)).toBe(true);
    };
    try {
      configure("shadow");
      classifier.checkWorkRequest.mockResolvedValueOnce({ status: "ok", isWorkRequest: false, probability: 0.01, latencyMs: 3 });
      await turn("hi");
      await turn("Build a report");
      await turn("continue");
      configure("enforce");
      await turn("continue in enforce");
      sessionId += "-fresh";
      await turn("Build a report");
      configure("shadow");
      await turn("continue in shadow");
      await turn("scheduler work", { source: "scheduler" });
      expect(traces.map((trace) => trace && { mode: trace.routingMode, state: trace.routingState, actual: trace.routingActual })).toEqual([
        { mode: "shadow", state: "unrouted", actual: "routing-test/usual" },
        { mode: "shadow", state: "locked-routed", actual: "routing-test/usual" },
        { mode: "shadow", state: "locked-routed", actual: "routing-test/usual" },
        { mode: "enforce", state: "locked-routed", actual: "routing-test/usual" },
        { mode: "enforce", state: "locked-routed", actual: "routing-test/selected" },
        { mode: "shadow", state: "locked-routed", actual: "routing-test/usual" },
        { mode: undefined, state: undefined, actual: undefined },
      ]);
      expect(traces[0]?.routingProposed).toBeUndefined();
      expect(traces[1]).toMatchObject({ routingProposed: "routing-test/selected", routingCategory: "work", routingScore: 0.9, routingPool: "chatgpt", routingTableVersion: "fixture-v1" });
      expect(classifier.checkWorkRequest).toHaveBeenCalledTimes(3);
    } finally { adapter.mockRestore(); unsubscribe(); }
  });

  it.each(["routed", "greeting", "low-score", "predicate-unavailable", "classify-unavailable", "category-missing", "quota-unknown", "quota-stale", "both-exhausted", "quota-failed", "lock-write-failed", "lock-lost"] as const)("shadow passes the same model, thinking and fallback to the adapter as off for %s", async (outcome) => {
    agent.fallback_model = { provider: "routing-fallback", model: "fallback" };
    const received: unknown[] = [];
    let restoreDisk = () => {};
    const adapter = vi.spyOn(piAdapter, "run").mockImplementation(async (params) => {
      received.push({ model: params.model ?? params.agent.model, thinkLevel: params.thinkLevel, fallback: params.agent.fallback_model });
      params.onHistoryEvent({ type: "user", text: params.message, timestamp: Date.now() });
      params.onHistoryEvent({ type: "assistant_text", text: "fake answer", timestamp: Date.now() });
      params.onEvent({ type: "text", data: "fake answer" });
      return { text: "fake answer" };
    });
    try {
      configure("off");
      await send("Build a report");
      if (outcome === "greeting") classifier.checkWorkRequest.mockResolvedValueOnce({ status: "ok", isWorkRequest: false, probability: 0.01, latencyMs: 3 });
      if (outcome === "lock-write-failed") {
        const append = fs.appendFile.bind(fs);
        const disk = vi.spyOn(fs, "appendFile").mockImplementation(async (...args) => {
          if (String(args[1]).includes('"key":"modelRoute"')) throw new Error("lock write failed");
          return append(...args);
        });
        restoreDisk = () => disk.mockRestore();
      }
      if (outcome === "lock-lost") classifier.classifyCategory.mockImplementationOnce(async () => {
        await appendSessionMeta(agent.id, sessionId, "modelRoute", { version: 1, kind: "routed", mode: "enforce", provider: "routing-test", model: "other", category: "work", score: 0.95, tableVersion: "fixture-v1", pool: "claude", reason: "pace", decidedAt: "2026-11-01T00:00:00.000Z" });
        return { status: "ok", category: "work", score: 0.9, probabilities: {}, latencyMs: 3, orders: [null, null] };
      });
      if (outcome === "low-score") classifier.classifyCategory.mockResolvedValueOnce({ status: "ok", category: "work", score: 0.79, probabilities: {}, latencyMs: 3, orders: [null, null] });
      if (outcome === "predicate-unavailable") classifier.checkWorkRequest.mockResolvedValueOnce({ status: "unavailable", reason: "timeout", latencyMs: 3 });
      if (outcome === "classify-unavailable") classifier.classifyCategory.mockResolvedValueOnce({ status: "unavailable", reason: "malformed", latencyMs: 3, orders: [null, null] });
      if (outcome === "category-missing") classifier.classifyCategory.mockResolvedValueOnce({ status: "ok", category: "missing", score: 0.9, probabilities: {}, latencyMs: 3, orders: [null, null] });
      configure("shadow", outcome.startsWith("quota-") ? "either" : "prefer_chatgpt");
      await send("Build a report", { routingDependencies: { classifier, readQuota: async () => {
        if (outcome === "quota-failed") throw new Error("fake unavailable quota");
        if (outcome === "both-exhausted") return { claude: { status: "known", exhausted: true }, chatgpt: { status: "known", exhausted: true } };
        return { claude: { status: "unknown", ...(outcome === "quota-stale" ? { reason: "stale" } : {}) }, chatgpt: { status: "unknown" } };
      } } });
      expect(received).toEqual([
        { model: { provider: "routing-test", model: "usual" }, thinkLevel: "low", fallback: { provider: "routing-fallback", model: "fallback" } },
        { model: { provider: "routing-test", model: "usual" }, thinkLevel: "low", fallback: { provider: "routing-fallback", model: "fallback" } },
      ]);
    } finally { adapter.mockRestore(); restoreDisk(); }
  });

  it("keeps an enforced model running when only the telemetry append rejects", async () => {
    const append = fs.appendFile.bind(fs);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = vi.spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (String(args[1]).includes('"key":"modelRouteAttempt"')) throw new Error("private disk failure canary");
      return append(...args);
    });
    try {
      await expect(send("Build a report")).resolves.toMatchObject({ payloads: [{ text: "answered by selected" }] });
      await appendSessionMeta(agent.id, sessionId, "barrier", true);
      expect(models).toEqual(["selected"]);
      expect(setup.efforts).toEqual(["high"]);
      expect(warning).toHaveBeenCalledWith(JSON.stringify({ level: "warn", msg: "[model-routing] telemetry write failed" }));
    } finally { failure.mockRestore(); warning.mockRestore(); }
  });

});
