import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import fs from "node:fs/promises";
import { z } from "zod";
import type { ExtensionContext, FeedWindow, JobTickInput } from "@yoplai/shared";
import { expect, it, vi } from "vitest";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const feed = "/api/agents/pilot/feed";
const tick: JobTickInput = {
  agentId: "pilot", owner: "local", jobId: "orchard", jobName: "Orchard inventory",
  tickTime: 1_790_000_000_000, prompt: "Count the pear crates.",
  signal: new AbortController().signal,
};

it("seeds a tick from Main and publishes one digest after retries and restart", async () => {
  let ctx!: ExtensionContext;
  const gateway = await startDurableTestGateway({ startChannels(context) { ctx = context; } });
  try {
    const main = await gateway.send("local", "The green crates belong to the north orchard.", { clientSendId: "orchard-main" });
    expect(main.status).toBe(200);
    gateway.script("Three pear crates.");
    const result = await ctx.runJobTick?.(tick);
    expect(result).toMatchObject({
      status: "done",
      result: { payloads: [{ text: "Three pear crates." }], meta: { sessionId: "job:orchard:1790000000000" } },
    });
    const messages = JSON.stringify(gateway.requests[1]?.messages);
    expect(messages).toContain("The green crates belong to the north orchard.");
    expect(messages.indexOf("The green crates belong to the north orchard.")).toBeLessThan(messages.indexOf(tick.prompt));
    expect(gateway.offeredTools(1)).not.toContain("plan_update");
    expect(await ctx.runJobTick?.(tick)).toEqual(result);
    await gateway.restart();
    expect(await ctx.runJobTick?.(tick)).toEqual(result);
    const window: FeedWindow = await (await gateway.request("local", feed)).json();
    expect(window.items.filter(({ role }) => role === "user")).toMatchObject([
      { surface: "web", text: "The green crates belong to the north orchard." },
      { surface: "job", sender: "Orchard inventory", text: expect.stringContaining("Three pear crates.") },
    ]);
    expect(JSON.stringify(window)).not.toContain(tick.prompt);
    expect(gateway.callCount()).toBe(2);
  } finally {
    await gateway.close();
  }
});

it("recovers a settled tick digest on restart without re-dispatching the tick", async () => {
  let ctx!: ExtensionContext;
  let interrupt = true;
  const gateway = await startDurableTestGateway({
    startChannels(context) { ctx = context; },
    afterChildSettlement() {
      if (!interrupt) return;
      interrupt = false;
      throw new Error("Fixture stopped before digest");
    },
  });
  try {
    gateway.script("Pears ready.");
    await expect(ctx.runJobTick!(tick)).rejects.toThrow("Fixture stopped before digest");
    const read = async () => (await (await gateway.request("local", feed)).json() as FeedWindow).items;
    expect(await read()).toEqual([]);
    await gateway.restart();
    await vi.waitFor(async () => expect(await read()).toMatchObject([
      { role: "user", surface: "job", text: "Orchard inventory completed: Pears ready." },
    ]));
    expect(gateway.callCount()).toBe(1);
  } finally {
    await gateway.close();
  }
});

async function webhookGateway(options: Parameters<typeof startDurableTestGateway>[0] = {}) {
  let secretFor!: (name: string) => string;
  const gateway = await startDurableTestGateway({
    extraYaml: `webhooks:
  dispatch:
    prompt: "Hook URL=$WEBHOOK_ORIGIN_URL Headers=$WEBHOOK_HEADERS Body=$WEBHOOK_PAYLOAD"`,
    legacyAnswer: "Legacy webhook answer.",
    ...options,
    async fixtureExtensions() {
      const extensions = options.fixtureExtensions;
      const { webhooksExtension } = await import("@yoplai/extension-webhooks");
      const { api } = await import("./api.core.js");
      webhooksExtension.registerRoutes(api);
      return [webhooksExtension, ...(typeof extensions === "function" ? await extensions() : extensions ?? [])];
    },
    async startChannels(ctx) {
      const { webhooksExtension, ensureWebhookSecrets, webhookSecretKey } = await import("@yoplai/extension-webhooks");
      const { secrets } = ensureWebhookSecrets(ctx.getDataDir(), ctx.getAgents());
      secretFor = (name) => secrets[webhookSecretKey("pilot", name)]!;
      await webhooksExtension.start({ ...ctx, logger: { ...ctx.logger, info() {} } });
      const stop = await options.startChannels?.(ctx, ctx.getDataDir());
      return async () => { await stop?.(); await webhooksExtension.stop(); };
    },
  });
  return {
    ...gateway, secretFor,
    hook(name: string, headers?: Record<string, string>, body = "delivery body") {
      return gateway.request("local", "/hooks/pilot/" + encodeURIComponent(name) + "/" + secretFor(name) + "?query=omitted",
        { method: "POST", body, headers });
    },
  };
}

it("admits real webhook deliveries in seeded children and dedupes by delivery id", async () => {
  const gateway = await webhookGateway({
    extraYaml: `toolDeferral: { enabled: false }
webhooks:
  dispatch:
    prompt: "Hook URL=$WEBHOOK_ORIGIN_URL Headers=$WEBHOOK_HEADERS Body=$WEBHOOK_PAYLOAD"`,
    async fixtureExtensions() {
      return [(await import("../relay/device-extension.js")).deviceToolsExtension];
    },
  });
  try {
    await gateway.connectDevice("local");
    gateway.script("Main reply.", "First event handled.", "Second event handled.", "Third event handled.", "Fourth event handled.");
    expect((await gateway.send("local", "The dispatch belongs to the orchard.", { clientSendId: "dispatch-main" })).status).toBe(200);
    const read = async () => (await (await gateway.request("local", feed)).json() as FeedWindow).items
      .filter((item) => item.role === "user" && item.surface === "webhook");
    const headers = { "x-github-delivery": "delivery:one", authorization: "Bearer fixture-canary", "x-hub-signature-256": "fixture-signature" };
    const payload = "a".repeat(4_020) + "private tail";
    const response = await gateway.hook("dispatch", headers, payload);
    expect(response.status).toBe(200);
    const first = await response.json();
    await vi.waitFor(async () => expect(await read()).toMatchObject([
      { sender: "dispatch", text: "dispatch completed: First event handled." },
    ]));
    expect(await (await gateway.hook("dispatch", headers, payload)).json()).toEqual(first);
    expect(await (await gateway.hook("dispatch", { "webhook-id": "another" }, payload)).json()).not.toEqual(first);
    await vi.waitFor(async () => expect(await read()).toHaveLength(2));
    const noId = await (await gateway.hook("dispatch", {}, payload)).json();
    expect(await (await gateway.hook("dispatch", {}, payload)).json()).not.toEqual(noId);
    await vi.waitFor(async () => expect(await read()).toHaveLength(4));
    const messages = JSON.stringify(gateway.requests[1]?.messages);
    expect(messages).toContain("The dispatch belongs to the orchard.");
    expect(messages).toContain("[from dispatch via webhook]");
    expect(messages).toContain("/hooks/pilot/dispatch Headers=");
    expect(messages).toContain("[+32 chars]");
    for (const omitted of [gateway.secretFor("dispatch"), "fixture-canary", "fixture-signature", "query=omitted", "private tail"]) {
      expect(messages.includes(omitted)).toBe(false);
    }
    expect(gateway.offeredTools(0)).toContain("device_read");
    expect(gateway.offeredTools(1).filter((name) => name.startsWith("device_"))).toEqual([]);
    expect(gateway.callCount()).toBe(5);
  } finally {
    await gateway.close();
  }
});

it("runs the real scheduler, delivers the answer, and keeps the shared cron file status-only", async () => {
  const posts: string[] = [];
  const gateway = await startDurableTestGateway({
    extraConfig: { enableCronMonitoring: true },
    legacyAnswer: "Legacy scheduler answer.",
    async fixtureExtensions() {
      const { schedulerExtension } = await import("@yoplai/extension-scheduler");
      const { api } = await import("./api.core.js");
      schedulerExtension.registerRoutes(api);
      return [schedulerExtension];
    },
    async startChannels(ctx) {
      const { schedulerExtension } = await import("@yoplai/extension-scheduler");
      ctx.registerDeliverySink("fixture", async ({ text }) => { posts.push(text); });
      await schedulerExtension.start(ctx);
      return () => schedulerExtension.stop();
    },
  });
  try {
    gateway.script("Main reply.", "Private pear inventory.");
    expect((await gateway.send("local", "The orchard inventory is private.", { clientSendId: "scheduler-main" })).status).toBe(200);
    const created = await gateway.request("local", "/api/schedules", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "pilot", name: "Orchard sweep", schedule: { cron: "0 0 * * *", tz: "UTC" },
        payload: { message: "Count the orchard's pears." }, deliver: [{ target: "fixture", channel: "orchard" }],
      }),
    });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const schedule = "/api/schedules/pilot/" + id;
    expect((await gateway.request("local", schedule + "/run", { method: "POST" })).status).toBe(202);
    await vi.waitFor(() => expect(posts).toEqual(["Private pear inventory."]));
    await vi.waitFor(async () => {
      const { runs } = await (await gateway.request("local", schedule + "/runs")).json();
      expect(runs).toMatchObject([{ status: "ok", sessionId: expect.stringMatching(/^job:/), outputPath: expect.any(String) }]);
      const artifact = await fs.readFile(runs[0].outputPath, "utf8");
      expect(artifact).toContain(runs[0].sessionId);
      expect(artifact).toContain("Count the orchard's pears.");
      expect(artifact).not.toContain("Private pear inventory.");
    });
    expect((await (await gateway.request("local", feed)).json() as FeedWindow).items).toContainEqual(
      expect.objectContaining({ surface: "job", text: "Orchard sweep completed: Private pear inventory." }),
    );
    const timed = await gateway.request("local", schedule, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeoutMs: 250 }),
    });
    expect(timed.status).toBe(200);
    const providerAborted = latch();
    gateway.script((_model, signal) => new Promise<string>((resolve) => {
      signal?.addEventListener("abort", () => {
        providerAborted.release();
        resolve("Partial private reply");
      }, { once: true });
    }));
    const started = await gateway.request("local", schedule + "/run", { method: "POST" });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ sessionId: expect.stringMatching(/^scheduler:/) });
    await vi.waitFor(async () => {
      const { runs } = await (await gateway.request("local", schedule + "/runs")).json();
      const stopped = runs.find((run: { status: string }) => run.status === "error");
      expect(stopped).toMatchObject({ sessionId: expect.stringMatching(/^job:/), error: "Job timed out after 250ms" });
      const artifact = await fs.readFile(stopped.outputPath, "utf8");
      expect(artifact).toContain(stopped.sessionId);
      expect(artifact).not.toContain("Partial private reply");
    });
    await providerAborted.promise;
    await vi.waitFor(async () => {
      const window: FeedWindow = await (await gateway.request("local", feed)).json();
      expect(window.items.filter(({ text }) => text === "Orchard sweep stopped.")).toHaveLength(1);
    });

  } finally {
    await gateway.close();
  }
});

it("keeps a webhook digest out of a human turn that is still running", async () => {
  const toolStarted = latch();
  const toolFinished = latch();
  const childSettled = latch();
  const finishMain = latch();
  const gateway = await webhookGateway({
    afterChildSettlement: childSettled.release,
    fixture: { extension: defineExtension({
      name: "orchard-background-fixture",
      tools: [defineTool({
        name: "check_shed", description: "Check the shed", parameters: { type: "object" },
        async execute() {
          toolStarted.release();
          await toolFinished.promise;
          return { output: [{ type: "text", text: "The shed is locked." }] };
        },
      })],
    }) },
  });
  try {
    gateway.script({ tool: "check_shed", id: "shed" }, "Webhook reaction.", async () => {
      await finishMain.promise;
      return "The human request is done.";
    });
    const running = gateway.send("local", "Check whether the shed is locked.", { clientSendId: "active-shed" });
    await toolStarted.promise;
    expect((await gateway.hook("dispatch", { "idempotency-key": "during-main" })).status).toBe(200);
    await childSettled.promise;
    // Let the child enqueue its digest while the Main tool remains in flight.
    await new Promise((resolve) => setTimeout(resolve, 50));
    toolFinished.release();
    await vi.waitFor(() => expect(gateway.requests).toHaveLength(3));
    expect(JSON.stringify(gateway.requests[2]?.messages)).not.toContain("Webhook reaction.");
    const read = async () => (await (await gateway.request("local", feed)).json() as FeedWindow).items;
    expect((await read()).some((item) => item.role === "user" && item.surface === "webhook")).toBe(false);
    finishMain.release();
    expect((await running).status).toBe(200);
    await vi.waitFor(async () => expect(await read()).toMatchObject([
      { text: "Check whether the shed is locked." },
      { text: "The human request is done." },
      { surface: "webhook", text: "dispatch completed: Webhook reaction." },
    ]));
    expect(gateway.callCount()).toBe(3);
  } finally {
    toolFinished.release();
    finishMain.release();
    await gateway.close();
  }
});

it("resumes a tick whose model request was in flight at restart", async () => {
  let ctx!: ExtensionContext;
  const entered = latch();
  const gateway = await startDurableTestGateway({ startChannels(context) { ctx = context; } });
  try {
    gateway.script((_model, signal) => new Promise<string>((resolve) => {
      entered.release();
      signal?.addEventListener("abort", () => resolve("Interrupted draft"), { once: true });
    }), "Recovered pear count.");
    const pending = ctx.runJobTick!(tick).catch(() => undefined);
    await entered.promise;
    await gateway.restart();
    await pending;
    await vi.waitFor(async () => {
      const window: FeedWindow = await (await gateway.request("local", feed)).json();
      expect(window.items).toMatchObject([{ surface: "job", text: "Orchard inventory completed: Recovered pear count." }]);
    });
    expect(gateway.callCount()).toBe(2);
    expect(JSON.stringify(gateway.requests[1]?.messages)).toContain(tick.prompt);
  } finally {
    await gateway.close();
  }
});

it("keeps a webhook's first owner after reassignment and leaves ownerless team routes on legacy", async () => {
  const routes = (owner = "") => `
webhooks:
  dispatch:
    prompt: "Check the orchard dispatch"
    credentialMode: owner${owner ? "\n    ownerUserId: " + owner : ""}
  service:
    prompt: "Check the team dispatch"
    credentialMode: team`;
  const gateway = await webhookGateway({ multiUser: true, extraYaml: routes() });
  try {
    const invalid = await gateway.hook("dispatch", { "x-github-delivery": "first" });
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toEqual({ error: "Webhook owner is missing; assign an owner before running it" });
    expect((await gateway.hook("service")).status).toBe(200);
    const read = async (user: "alice" | "bob") => (await (await gateway.request(user, feed)).json() as FeedWindow).items;
    expect(await read("alice")).toEqual([]);
    expect(await read("bob")).toEqual([]);
    expect(gateway.callCount()).toBe(0);

    await gateway.configure("fixture", routes(gateway.accountId("alice")));
    gateway.script("Alice's dispatch checked.", "Bob's dispatch checked.");
    const headers = { "x-github-delivery": "first" };
    const first = await (await gateway.hook("dispatch", headers)).json();
    await vi.waitFor(async () => expect(await read("alice")).toMatchObject([{ text: "dispatch completed: Alice's dispatch checked." }]));
    expect(await read("bob")).toEqual([]);

    await gateway.configure("fixture", routes(gateway.accountId("bob")));
    expect(await (await gateway.hook("dispatch", headers)).json()).toEqual(first);
    expect((await gateway.hook("dispatch", { "x-github-delivery": "second" })).status).toBe(200);
    await vi.waitFor(async () => expect(await read("bob")).toMatchObject([{ text: "dispatch completed: Bob's dispatch checked." }]));
    expect(await read("alice")).toHaveLength(1);
    expect(gateway.callCount()).toBe(2);
  } finally {
    await gateway.close();
  }
});

it("keeps webhook identities distinct when a route name or delivery id contains a colon", async () => {
  const gateway = await webhookGateway({ extraYaml: `webhooks:
  "a:b":
    prompt: "Check the north plot"
  a:
    prompt: "Check the south plot"` });
  try {
    gateway.script("North plot checked.", "South plot checked.");
    const first = await (await gateway.hook("a:b", { "webhook-id": "c" })).json();
    const second = await (await gateway.hook("a", { "webhook-id": "b:c" })).json();
    expect(first).toEqual({ ok: true, requestId: "webhook:a%3Ab:c" });
    expect(second).toEqual({ ok: true, requestId: "webhook:a:b%3Ac" });
    await vi.waitFor(async () => {
      const { items }: FeedWindow = await (await gateway.request("local", feed)).json();
      expect(items.map((item) => item.role === "user" && item.sender).sort()).toEqual(["a", "a:b"]);
    });
    expect(gateway.callCount()).toBe(2);
  } finally {
    await gateway.close();
  }
});

it("dispatches webhooks through the legacy session with Durable mode off", async () => {
  const gateway = await webhookGateway({ enableDurableMode: false });
  try {
    const headers = { "x-github-delivery": "legacy-retry" };
    const first = await gateway.hook("dispatch", headers);
    const second = await gateway.hook("dispatch", headers);
    expect([first.status, second.status]).toEqual([200, 200]);
    const [firstAck, secondAck] = await Promise.all([first.json(), second.json()]);
    expect(firstAck.requestId).not.toBe(secondAck.requestId);
    for (const { requestId } of [firstAck, secondAck]) {
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      await vi.waitFor(async () => {
        expect(await gateway.history("local", "?sessionKey=" + encodeURIComponent("webhook:pilot:dispatch:" + requestId)))
          .toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ role: "assistant", content: "Legacy webhook answer." })]) });
      });
    }
    expect(gateway.callCount()).toBe(0);
  } finally {
    await gateway.close();
  }
});

it("keeps a tick's transcript and tools private while the owner sees one live digest and can still read threads", async () => {
  let ctx!: ExtensionContext;
  const entered = latch();
  const finish = latch();
  const gateway = await startDurableTestGateway({
    multiUser: true, extraYaml: "toolDeferral: { enabled: false }",
    startChannels(context) { ctx = context; },
    async fixtureExtensions() {
      const { deviceToolsExtension } = await import("../relay/device-extension.js");
      const { sessionHistoryExtension } = await import("../session-history/index.js");
      return [deviceToolsExtension, sessionHistoryExtension];
    },
  });
  try {
    await gateway.connectDevice("alice");
    gateway.script(
      { tool: "plan_update", id: "set-plan", args: { goals: ["Pack pears"], nextSteps: ["Find boxes"] } },
      "The plan is saved.",
      "Private thread reply.",
      { tool: "bash", id: "count-crates", args: { command: "echo orchard-child-output" } },
      async () => {
        entered.release();
        await finish.promise;
        return "Private tick digest answer.";
      },
      { tool: "plan_get", id: "read-plan" },
      "The plan is intact.",
      [
        { tool: "session_history", id: "read-child", args: { action: "read", session: "job:orchard:1790000000000" } },
        { tool: "session_history", id: "search-child", args: { action: "search", query: "orchard-child-output" } },
      ],
      "No private runs in Bob's history.",
    );
    expect((await gateway.send("alice", "Plan the pear packing.", { clientSendId: "alice-plan" })).status).toBe(200);
    const created = await gateway.request("alice", "/api/agents/pilot/threads", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Apple notes" }),
    });
    expect(created.status).toBe(201);
    const { id: thread } = await created.json();
    expect((await gateway.send("alice", "A private thread note.", { sessionId: "thread:" + thread, clientSendId: "apple-note" })).status).toBe(200);
    const observer = await gateway.socket("alice");
    observer.send({ type: "subscribeFeed", agentId: "pilot" });
    observer.send({ type: "subscribe", agentId: "pilot", sessionKey: "main" });
    await vi.waitFor(() => expect(observer.events.some(({ type }) => type === "feed_snapshot")).toBe(true));
    observer.events.length = 0;
    const running = ctx.runJobTick!({ ...tick, owner: gateway.accountId("alice") });
    await entered.promise;
    await observer.flush();
    expect(observer.events).toEqual([]);
    expect(gateway.offeredTools(0)).toContain("device_read");
    expect(gateway.offeredTools(3).filter((name) => name.startsWith("device_") || name.startsWith("plan_") || name === "topics_get")).toEqual([]);
    expect(JSON.stringify(gateway.requests[3]?.messages)).toContain("Find boxes");
    finish.release();
    await running;
    await vi.waitFor(() => {
      const updates = observer.events.filter((event) => event.type === "feed_delta");
      expect(updates).toMatchObject([{ upsert: [{ surface: "job", text: "Orchard inventory completed: Private tick digest answer." }], live: null }]);
    });
    expect(observer.events.filter(({ type }) => type !== "feed_delta")).toEqual([]);
    await expect(ctx.runJobTick!({ ...tick, owner: gateway.accountId("bob") })).rejects.toThrow("belongs to another owner");

    const get = async (user: "alice" | "bob", route: string) => (await gateway.request(user, route)).json();
    const aliceFeed: FeedWindow = await get("alice", feed);
    expect(JSON.stringify(aliceFeed)).not.toMatch(/Count the pear crates|orchard-child-output/);
    expect(await get("bob", feed)).toMatchObject({ items: [] });
    expect(await get("alice", feed + "/search?q=orchard-child-output")).toEqual({ hits: [] });
    expect(await get("bob", feed + "/search?q=Private%20tick%20digest")).toEqual({ hits: [] });
    expect(JSON.stringify(await gateway.history("alice", "?view=full"))).not.toMatch(/Count the pear crates|orchard-child-output/);
    expect(JSON.stringify(await gateway.history("bob", "?view=full"))).not.toContain("Private tick digest answer.");
    expect(await get("alice", feed + "?thread=" + thread)).toMatchObject({ items: [{ text: "A private thread note." }, { text: "Private thread reply." }] });
    expect((await gateway.request("bob", feed + "?thread=" + thread)).status).toBe(404);

    expect((await gateway.send("alice", "Is the plan still in place?", { clientSendId: "read-plan" })).status).toBe(200);
    const plan = gateway.requests.at(-1)?.messages.find((message) => message.role === "toolResult" && message.toolCallId === "read-plan");
    expect(JSON.stringify(plan)).toContain("Find boxes");
    expect((await gateway.send("bob", "Read my session history.", { clientSendId: "read-background" })).status).toBe(200);
    const results = gateway.requests.at(-1)?.messages.filter((message) => message.role === "toolResult");
    expect(JSON.stringify(results)).toContain("no such session: job:orchard:1790000000000");
    expect(JSON.stringify(results)).toContain("no matches");
    expect(JSON.stringify(results)).not.toContain("Private tick digest answer.");
  } finally {
    finish.release();
    await gateway.close();
  }
}, 20_000);

it("builds a Faux compaction request that indexes and clips both kinds of digest", async () => {
  let ctx!: ExtensionContext;
  const gateway = await webhookGateway({ startChannels(context) { ctx = context; } });
  const read = async () => (await (await gateway.request("local", feed)).json() as FeedWindow).items;
  try {
    const question = "Q".repeat(260);
    gateway.script(
      { content: "Orchard notes opened.", usage: { input: 180 } },
      "J".repeat(600),
      "W".repeat(600),
      { content: "Packed the crates. " + "orchard ".repeat(690), usage: { input: 5_250 } },
      { content: "The orchard summary is ready.", usage: { input: 300 } },
    );
    expect((await gateway.send("local", question, { clientSendId: "cut-first" })).status).toBe(200);
    await ctx.runJobTick!(tick);
    expect((await gateway.hook("dispatch", { "webhook-id": "cut-hook" })).status).toBe(200);
    await vi.waitFor(async () => expect(await read()).toHaveLength(4));
    const [user, , job, webhook] = await read();
    expect((await gateway.send("local", "Pack the crates.", { clientSendId: "cut-pack" })).status).toBe(200);
    expect((await gateway.send("local", "Summarize the orchard.", { clientSendId: "cut-summary" })).status).toBe(200);
    expect((await read()).some(({ role }) => role === "seam")).toBe(true);
    const message = gateway.requests[4]?.messages[1];
    const text = message?.role === "user" && Array.isArray(message.content) && message.content[0]?.type === "text"
      ? message.content[0].text : "";
    expect(text).toMatch(/Older requests\n/);
    const index = text.split("Older requests\n")[1]?.split("\n");
    expect(index).toContainEqual(expect.stringMatching(new RegExp(
      "\\[" + webhook?.id + "\\].* · dispatch · webhook · dispatch completed: W{80}$",
    )));
    expect(index).toContainEqual(expect.stringMatching(new RegExp(
      "\\[" + job?.id + "\\].* · Orchard inventory · job · Orchard inventory completed: J{71}$",
    )));
    expect(index).toContainEqual(expect.stringMatching(new RegExp("\\[" + user?.id + "\\].* · web · Q{200}$")));
  } finally {
    await gateway.close();
  }
});

it("writes a failure digest and only the public withheld notice for a rejected reply", async () => {
  let ctx!: ExtensionContext;
  const gateway = await startDurableTestGateway({
    extraYaml: "retryMaxAttempts: 1",
    reviewer: { begin() {}, end() {}, review: () => ({ ok: false, rewriteHint: "Use a shorter result." }) },
    startChannels(context) { ctx = context; },
  });
  try {
    gateway.script({ errorMessage: "Fixture provider unavailable" });
    await expect(ctx.runJobTick!(tick)).rejects.toThrow();
    gateway.script("First rejected draft.", "Second rejected draft.");
    await expect(ctx.runJobTick!({ ...tick, tickTime: tick.tickTime + 1 })).rejects.toThrow("The reply was withheld by review.");
    const { items }: FeedWindow = await (await gateway.request("local", feed)).json();
    expect(items.map(({ text }) => text)).toEqual([
      "Orchard inventory failed.",
      "Orchard inventory completed: The reply was withheld by review.",
    ]);
  } finally {
    await gateway.close();
  }
});

it("does not start a tick that is stopped while configuring the child", async () => {
  let ctx!: ExtensionContext;
  const entered = latch();
  const finish = latch();
  const controller = new AbortController();
  const gateway = await startDurableTestGateway({
    startChannels(context) { ctx = context; },
    fixtureExtensions: [{
      id: "fixture-delayed-prompt", displayName: "Delayed prompt", description: "",
      routePrefixes: [], dependencies: [], configSchema: z.object({}),
      validateConfig: () => ({ valid: true, errors: [] }), registerRoutes() {},
      async start() {}, async stop() {}, capabilities: () => [],
      async getSystemPromptContributions(_agent, hook) {
        if (hook?.run?.background) {
          entered.release();
          await finish.promise;
        }
        return "Fixture prompt.";
      },
    }],
  });
  try {
    const onAdmitted = vi.fn();
    const result = ctx.runJobTick!({ ...tick, signal: controller.signal, onAdmitted });
    await entered.promise;
    controller.abort(new Error("Fixture timeout before input"));
    finish.release();
    await expect(result).rejects.toThrow("Fixture timeout before input");
    expect(onAdmitted.mock.calls).toEqual([["job:orchard:1790000000000"]]);
    const window: FeedWindow = await (await gateway.request("local", feed)).json();
    expect(window.items).toEqual([]);
    expect(gateway.callCount()).toBe(0);
  } finally {
    finish.release();
    await gateway.close();
  }
});

it("repairs a webhook digest on delivery replay when the child already settled", async () => {
  const failedWrite = latch();
  let interrupt = true;
  const gateway = await webhookGateway({
    afterChildSettlement() {
      if (!interrupt) return;
      interrupt = false;
      failedWrite.release();
      throw new Error("Fixture stopped before webhook digest");
    },
  });
  try {
    gateway.script("One webhook reaction.");
    const headers = { "webhook-id": "retry-digest" };
    const first = await (await gateway.hook("dispatch", headers)).json();
    await failedWrite.promise;
    const read = async () => (await (await gateway.request("local", feed)).json() as FeedWindow).items;
    expect(await read()).toEqual([]);
    expect(await (await gateway.hook("dispatch", headers)).json()).toEqual(first);
    await vi.waitFor(async () => expect(await read()).toMatchObject([
      { role: "user", surface: "webhook", text: "dispatch completed: One webhook reaction." },
    ]));
    expect(gateway.callCount()).toBe(1);
  } finally {
    await gateway.close();
  }
});

it("fits the handoff to a small model while preserving the latest Main request", async () => {
  let ctx!: ExtensionContext;
  const gateway = await startDurableTestGateway({
    fauxLimits: { contextWindow: 2_500, maxTokens: 300 },
    startChannels(context) { ctx = context; },
  });
  try {
    let seed = "";
    gateway.script(
      { content: "Main recorded the marker. " + "archive ".repeat(575), usage: { input: 35 } },
      () => {
        seed = JSON.stringify(gateway.requests.at(-1)?.messages.find((message) =>
          message.role === "user" && JSON.stringify(message.content).includes("Recent messages"),
        )?.content ?? "");
        return seed.length < 1_800 && seed.includes("SUNRISE-ORCHARD") ? "Recent Main context received." : "Handoff exceeded provider budget.";
      },
    );
    expect((await gateway.send("local", "Keep SUNRISE-ORCHARD for the next inventory.", { clientSendId: "small-model-seed" })).status).toBe(200);
    expect(await ctx.runJobTick!(tick)).toMatchObject({ status: "done", result: { payloads: [{ text: "Recent Main context received." }] } });
    expect(seed).toContain("SUNRISE-ORCHARD");
    expect(seed.length).toBeLessThan(1_800);
  } finally {
    await gateway.close();
  }
});

it("keeps the keeper's turn count and watermark on Main when a tick settles", async () => {
  let ctx!: ExtensionContext;
  const gateway = await startDurableTestGateway({
    keeper: { idleMs: 60_000, turns: 2 },
    startChannels(context) { ctx = context; },
  });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  const complete = vi.spyOn(MaintenanceCompletion, "complete").mockResolvedValue('{"topics":[]}');
  try {
    gateway.script("Main opened the pear records.", "Three crates.", "Main marked the transfer.");
    expect((await gateway.send("local", "Open the pear records.", { clientSendId: "keeper-first" })).status).toBe(200);
    await ctx.runJobTick!(tick);
    expect((await gateway.send("local", "Mark the transfer.", { clientSendId: "keeper-second" })).status).toBe(200);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    const batch = JSON.parse(complete.mock.calls[0]![0].prompt);
    expect(batch.messages.map(({ text }: { text: string }) => text)).toEqual([
      "Open the pear records.",
      "Main opened the pear records.",
      "Orchard inventory completed: Three crates.",
      "Mark the transfer.",
      "Main marked the transfer.",
    ]);
  } finally {
    complete.mockRestore();
    await gateway.close();
  }
});
