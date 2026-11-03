import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoutingHarness, routingRuntimes, barrier, poll, type RoutingHarness } from "./model-routing-harness.js";

// ALG-598 Testing Decisions explicitly approves REST -> runAgent with real Pi,
// the real classifier and quota reader/store. This catches integration wiring;
// it does not establish live-vendor acceptance or the ALG-608 container bridge.
let harness: RoutingHarness | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

const scenarios: Array<{ name: string; run: (h: RoutingHarness) => Promise<void>; reportRoundTrip?: boolean }> = [{
  name: "greeting then work routes once, replays history and keeps model and effort",
  run: async (h: RoutingHarness) => {
    h.classifier.predicate = false;
    await expect(h.send("hi")).resolves.toMatchObject({ status: 200, body: { payloads: [{ text: "answer:usual" }] } });
    expect(await h.lock()).toBeUndefined();
    expect(await h.attempts(1)).toMatchObject([{ predicate: { result: "no" } }]);
    h.classifier.predicate = true;
    const turn2Start = h.historyEvents.length;
    await expect(h.send("Build a report")).resolves.toMatchObject({ status: 200, body: { payloads: [{ text: "answer:chatgpt" }] } });
    expect(await h.lock()).toEqual({
      version: 1, kind: "routed", mode: "enforce", provider: "route-chatgpt", model: "chatgpt", effort: "high",
      category: "work", score: 0.9, tableVersion: "e2e-v1", pool: "chatgpt", reason: "preference", decidedAt: expect.any(String),
    });
    expect(h.modelCalls[1]?.messages).toContainEqual(expect.objectContaining({
      role: "user", content: expect.arrayContaining([expect.objectContaining({ type: "text", text: "hi" })]),
    }));
    const trace = h.historyEvents[turn2Start];
    expect(trace?.trace?.metadata).toMatchObject({ routingState: "locked-routed", routingProposed: "route-chatgpt/chatgpt" });
    await h.attempts(2);
    await h.send("continue");
    expect(h.modelCalls.map((call) => call.model)).toEqual(["usual", "chatgpt", "chatgpt"]);
    expect(h.adapterCalls.map((call) => call.thinkLevel)).toEqual(["low", "high", "high"]);
    expect(h.classifier.calls.map((call) => call.question)).toEqual(["work_request", "work_request", "category", "category"]);
    expect(await h.attempts(2)).toHaveLength(2);
  },
}, {
  name: "low confidence locks the usual model and bypasses later classification",
  run: async (h: RoutingHarness) => {
    h.classifier.score = 0.7;
    await h.send("Build a report");
    expect(await h.lock()).toMatchObject({ kind: "usual", model: "usual", score: 0.7, reason: "score<0.8" });
    await h.send("continue");
    expect(h.modelCalls.map((call) => call.model)).toEqual(["usual", "usual"]);
    expect(h.classifier.calls).toHaveLength(3);
    expect(h.adapterCalls.every((call) => call.fallback === undefined)).toBe(true);
  },
}, {
  name: "queued work routes once after greeting and locked follow-ups use native queueing",
  run: async (h: RoutingHarness) => {
    const greeting = barrier();
    const routed = barrier();
    h.gates.set("usual", greeting);
    h.gates.set("chatgpt", routed);
    h.classifier.predicate = false;
    const first = h.send("hi");
    await h.bounded(greeting.entered);
    h.classifier.predicate = true;
    const second = await h.send("Build a report");
    expect(second.body.meta).toMatchObject({ queued: true });
    expect(h.modelCalls.map((call) => call.model)).toEqual(["usual"]);
    greeting.release();
    await h.bounded(routed.entered);
    expect(await h.lock()).toMatchObject({ kind: "routed", model: "chatgpt" });
    expect((await h.send("third queued detail")).body.meta).toMatchObject({ queued: true });
    routed.release();
    await first;
    await poll(() => h.modelCalls.length, (value) => value === 3);
    await h.waitIdle();
    expect(h.modelCalls.map((call) => call.model)).toEqual(["usual", "chatgpt", "chatgpt"]);
    expect(h.modelCalls[2]?.messages).toContainEqual(expect.objectContaining({
      role: "user", content: expect.arrayContaining([expect.objectContaining({ type: "text", text: "third queued detail" })]),
    }));
    expect(h.adapterCalls).toHaveLength(2);
    expect(h.classifier.calls.map((call) => call.question)).toEqual(["work_request", "work_request", "category", "category"]);
    expect(await h.attempts(2)).toHaveLength(2);
  },
}, {
  name: "restart retains canonical lock and SDK history without classifying again",
  run: async (h: RoutingHarness) => {
    await h.send("Build a report");
    const lock = await h.lock();
    await h.attempts(1);
    await h.restart();
    await h.send("after restart");
    expect(await h.lock()).toEqual(lock);
    expect(h.modelCalls.map((call) => call.model)).toEqual(["chatgpt", "chatgpt"]);
    expect(h.classifier.calls).toHaveLength(3);
    expect(JSON.stringify(h.modelCalls[1]?.messages)).toContain("Build a report");
  },
}, {
  name: "compact route summarizes with usual model and preserves routing lock",
  run: async (h: RoutingHarness) => {
    await h.send("Build a report");
    const lock = await h.lock();
    expect((await h.compact()).status).toBe(200);
    expect(await h.lock()).toEqual(lock);
    await h.send("after compact");
    expect(h.modelCalls.map((call) => call.model)).toEqual(["chatgpt", "usual", "chatgpt"]);
    expect(h.classifier.calls).toHaveLength(3);
  },
}, {
  name: "new session key keeps the old lock while delete removes a session lock",
  run: async (h: RoutingHarness) => {
    const keyed = await h.send("Build a report", { sessionId: undefined, sessionKey: "topic" });
    const oldSession = keyed.body.meta.sessionId;
    expect(oldSession).toBeTypeOf("string");
    const oldLock = await h.lock(oldSession);
    h.classifier.predicate = false;
    const fresh = await h.send("/new hi", { sessionId: undefined, sessionKey: "topic" });
    expect(fresh.body.meta.sessionId).not.toBe(oldSession);
    expect(await h.lock(fresh.body.meta.sessionId)).toBeUndefined();
    expect(await h.lock(oldSession)).toEqual(oldLock);
    h.classifier.predicate = true;
    await h.send("Build a report");
    expect((await h.removeSession()).body).toEqual({ ok: true });
    h.classifier.predicate = false;
    expect((await h.send("hi after delete")).status).toBe(200);
    expect(await h.lock()).toBeUndefined();
    expect(h.modelCalls.map((call) => call.model)).toEqual(["chatgpt", "usual", "chatgpt", "usual"]);
  },
}, {
  name: "missing and empty classifier key keep chat available and setting it recovers",
  run: async (h: RoutingHarness) => {
    for (const key of [undefined, ""]) {
      if (key === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = key;
      const started = performance.now();
      expect((await h.send("Build a report")).status).toBe(200);
      expect(performance.now() - started).toBeLessThan(500);
      expect(await h.lock()).toBeUndefined();
    }
    expect(await h.attempts(2)).toMatchObject([
      { predicate: { result: "unavailable", reason: "no_key" } },
      { predicate: { result: "unavailable", reason: "no_key" } },
    ]);
    expect(h.classifier.creates).toBe(0);
    expect(h.modelCalls.map((call) => call.model)).toEqual(["usual", "usual"]);
    process.env.OPENAI_API_KEY = "fixture-classifier";
    await h.send("Build a report");
    expect(await h.lock()).toMatchObject({ kind: "routed", model: "chatgpt" });
    expect(h.classifier.creates).toBe(2);
  },
}, {
  name: "predicate and concurrent category hangs abort within budgets and recover",
  run: async (h: RoutingHarness) => {
    for (const phase of ["work_request", "category"] as const) {
      h.sessionId = `${h.id}-${phase}`;
      h.classifier.hang = phase;
      const before = h.classifier.calls.length;
      const started = performance.now();
      expect((await h.send("Build a report")).status).toBe(200);
      const elapsed = performance.now() - started;
      const budget = phase === "work_request" ? h.config.modelRouting.budgets.predicateMs
        : h.config.modelRouting.budgets.predicateMs + h.config.modelRouting.budgets.categoryMs;
      expect(elapsed).toBeLessThan(budget + 200);
      expect(await h.lock()).toBeUndefined();
      const hung = h.classifier.calls.slice(before).filter((call) => call.question === phase);
      expect(hung).toHaveLength(phase === "category" ? 2 : 1);
      expect(hung.every((call) => call.aborted)).toBe(true);
      const externalDelay = Math.max(...hung.map((call) => call.abortedAt ?? Infinity)) - Math.min(...hung.map((call) => call.startedAt));
      expect(externalDelay).toBeLessThan((phase === "category" ? h.config.modelRouting.budgets.categoryMs : budget) + 35);
      h.classifier.hang = undefined;
      await h.send("retry the work");
      expect(await h.lock()).toMatchObject({ kind: "routed", model: "chatgpt" });
      expect(h.modelCalls.at(-1)?.model).toBe("chatgpt");
    }
    expect(h.modelCalls.map((call) => call.model)).toEqual(["usual", "chatgpt", "usual", "chatgpt"]);
  },
}, {
  name: "production quota identity and policy handle exhaustion, unknown, stale, error and Pro",
  run: async (h: RoutingHarness) => {
    await h.seedQuota("exhausted");
    await h.send("Build a report");
    expect(await h.lock()).toMatchObject({ model: "chatgpt", pool: "chatgpt", reason: "5h-exhausted" });
    await h.changePool("either");
    for (const state of ["error", "expired"] as const) {
      h.sessionId = `${h.id}-${state}`;
      await h.seedQuota(state);
      expect((await h.send("Build a report")).status).toBe(200);
      const lock = await h.lock();
      expect(lock).toMatchObject({ kind: "usual", model: "usual", reason: state === "error" ? "quota-unknown" : "quota-stale" });
      expect(lock).not.toHaveProperty("pool");
    }
    h.sessionId = `${h.id}-read-error`;
    const warning = vi.spyOn(console, "log");
    h.failQuotaRead();
    try {
      expect((await h.send("Build a report")).status).toBe(200);
      expect(await h.lock()).toBeUndefined();
      expect(await h.attempts(1)).toMatchObject([{ noLockReason: "quota-read-failed" }]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('"reason":"quota-unavailable"'));
    } finally { warning.mockRestore(); h.restoreQuotaRead(); }
    h.sessionId = `${h.id}-pro`;
    await h.seedQuota("pro");
    await h.changePool("prefer_chatgpt");
    expect((await h.send("Build a report")).status).toBe(200);
    expect(await h.lock()).toMatchObject({ model: "chatgpt", pool: "chatgpt", reason: "preference" });
    expect(h.modelCalls.map((call) => call.model)).toEqual(["chatgpt", "usual", "usual", "usual", "chatgpt"]);
  },
}, {
  name: "terminal failures retain routed and usual locks while unlocked and shadow sessions fallback",
  run: async (h: RoutingHarness) => {
    for (const kind of ["routed", "usual"] as const) {
      h.sessionId = `${h.id}-${kind}`;
      h.classifier.score = kind === "routed" ? 0.9 : 0.7;
      await h.send("Build a report");
      const lock = await h.lock();
      const model = kind === "routed" ? "chatgpt" : "usual";
      const classifierBefore = h.classifier.calls.length;
      h.failures.add(model);
      expect((await h.send("continue with terminal failure")).status).toBe(500);
      expect(await h.lock()).toEqual(lock);
      expect(h.modelCalls.some((call) => call.model === "fallback")).toBe(false);
      const history = await h.history();
      expect(history.messages).toContainEqual(expect.objectContaining({
        role: "assistant", content: [{ type: "text", text: "Something went wrong, please try again." }],
        meta: expect.objectContaining({ stopReason: "error", failure: { kind: "generic" } }),
      }));
      h.failures.delete(model);
      expect((await h.send("retry")).status).toBe(200);
      expect(h.modelCalls.at(-1)?.model).toBe(model);
      expect(h.classifier.calls).toHaveLength(classifierBefore);
      expect(await h.lock()).toEqual(lock);
    }
    h.sessionId = `${h.id}-unlocked-control`;
    h.classifier.predicate = false;
    h.failures.add("usual");
    expect((await h.send("hi")).body.payloads).toEqual([{ text: "answer:fallback" }]);
    expect(await h.lock()).toBeUndefined();
    await h.changeMode("shadow");
    h.sessionId = `${h.id}-shadow-control`;
    h.classifier.predicate = true;
    h.classifier.score = 0.9;
    expect((await h.send("Build a report")).body.payloads).toEqual([{ text: "answer:fallback" }]);
    expect(await h.lock()).toMatchObject({ mode: "shadow", kind: "routed" });
    expect(h.adapterCalls.at(-1)).toMatchObject({ thinkLevel: "low", fallback: { provider: "route-fallback", model: "fallback" } });
    expect(h.modelCalls.filter((call) => call.model === "fallback")).toHaveLength(2);
  },
}, {
  name: "hot reload rolls shadow to enforce, off and back without promoting shadow locks",
  reportRoundTrip: true,
  run: async (h: RoutingHarness) => {
    await h.changeMode("shadow");
    const shadowSession = h.sessionId;
    await h.send("Build a report");
    const shadowLock = await h.lock();
    expect(shadowLock).toMatchObject({ mode: "shadow", kind: "routed", effort: "high" });
    expect(h.modelCalls.at(-1)?.model).toBe("usual");
    expect(h.adapterCalls.at(-1)).toMatchObject({ thinkLevel: "low", fallback: { provider: "route-fallback", model: "fallback" } });
    expect(await h.attempts(1)).toMatchObject([{ proposed: "route-chatgpt/chatgpt", actual: "route-usual/usual" }]);
    const waitingSession = `${h.id}-waiting`;
    h.sessionId = waitingSession;
    h.classifier.predicate = false;
    await h.send("hi");
    await h.attempts(1);
    expect(await h.lock()).toBeUndefined();
    await h.changeMode("enforce");
    h.sessionId = shadowSession;
    await h.send("continue after enforce");
    expect(h.modelCalls.at(-1)?.model).toBe("usual");
    expect(await h.lock()).toEqual(shadowLock);
    h.sessionId = waitingSession;
    h.classifier.predicate = true;
    await h.send("Build a report");
    expect(await h.lock()).toMatchObject({ mode: "enforce", model: "chatgpt" });
    await h.attempts(2);
    const enforcedSession = `${h.id}-enforced`;
    h.sessionId = enforcedSession;
    await h.send("Build a report");
    const enforcedLock = await h.lock();
    expect(enforcedLock).toMatchObject({ mode: "enforce", model: "chatgpt" });
    await h.attempts(1);
    const gate = barrier();
    h.gates.set("chatgpt", gate);
    let completed = false;
    const running = h.send("running during rollback").then((result) => { completed = true; return result; });
    await h.bounded(gate.entered);
    await h.changeMode("off");
    expect(completed).toBe(false);
    gate.release();
    expect((await running).body.payloads).toEqual([{ text: "answer:chatgpt" }]);
    const classified = h.classifier.calls.length;
    for (const session of [shadowSession, waitingSession, enforcedSession]) {
      h.sessionId = session;
      await h.send("off turn");
      expect(h.modelCalls.at(-1)?.model).toBe("usual");
    }
    h.sessionId = `${h.id}-no-routing-records`;
    await h.send("off without records");
    expect(await h.attempts(0)).toEqual([]);
    expect(h.classifier.calls).toHaveLength(classified);
    expect(await h.attempts(1, shadowSession)).toHaveLength(1);
    expect(await h.attempts(2, waitingSession)).toHaveLength(2);
    expect(await h.attempts(1, enforcedSession)).toHaveLength(1);
    await h.changeMode("enforce");
    h.sessionId = enforcedSession;
    await h.send("resume enforce lock");
    expect(h.modelCalls.at(-1)?.model).toBe("chatgpt");
    expect(await h.lock()).toEqual(enforcedLock);
    h.sessionId = shadowSession;
    await h.send("shadow lock remains usual");
    expect(h.modelCalls.at(-1)?.model).toBe("usual");
    expect(await h.lock()).toEqual(shadowLock);
    expect(h.classifier.calls).toHaveLength(classified);
  },
}];

for (const runtime of routingRuntimes) {
  describe(`model routing E2E (${runtime})`, () => {
    for (const scenario of scenarios) {
      it(scenario.name, async () => {
        harness = await createRoutingHarness(runtime);
        await harness.bounded(scenario.run(harness));
        if (runtime === "host" && scenario.reportRoundTrip) {
          const report = await harness.report();
          expect(report.window).toMatchObject({ shadow: 1, mixed: 1, enforced: 1, underSevenDays: true });
          expect(report.sessions).toHaveLength(3);
          expect(report.total.wouldBe.models).toEqual({ "route-chatgpt/chatgpt": { count: 1, denominator: 1, share: 1 } });
        }
      }, 10_000);
    }
  });
}
