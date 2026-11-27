import { defineExtension, defineTask, defineTool, GenerationTask, hook, hookTask } from "@earendil-works/pi-durable";
import type { FeedWindow } from "@yoplai/shared";
import { beforeAll, expect, it, vi } from "vitest";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";

beforeAll(async () => {
  await import("./index.js");
  await import("../config/index.js");
  await import("../extensions/registry.js");
  await import("../durable/faux.js");
});

const feed = "/api/agents/pilot/feed";
const stop = "/api/agents/pilot/stop";

it("stops the caller's live Main and settles the send as aborted", async () => {
  const releaseRound = latch();
  const releaseBoundary = latch();
  const secondRound = latch();
  const releaseSecondRound = latch();
  const gateway = await startDurableTestGateway({
    extraYaml: "toolDeferral: { enabled: false }",
    fixture: { extension: defineExtension({
      name: "round-barrier",
      hooks: [hook(GenerationTask, {
        async afterTools() {
          await releaseBoundary.promise;
          return undefined;
        },
      })],
      tools: [
        defineTool({
          name: "wait_for_round", description: "Wait for the test to release the first round.", parameters: { type: "object" },
          async execute() {
            await releaseRound.promise;
            return { output: [{ type: "text", text: "First round complete." }] };
          },
        }),
        defineTool({
          name: "wait_for_stop", description: "Wait for the run's abort signal.", parameters: { type: "object" },
          async execute(_args, _api, context) {
            context.abortSignal?.addEventListener("abort", releaseSecondRound.resolve, { once: true });
            secondRound.resolve();
            await releaseSecondRound.promise;
            return { output: [{ type: "text", text: "Second round released." }] };
          },
        }),
      ],
    }) },
  });
  try {
    const observer = await gateway.socket();
    const turns = await gateway.subscribe("local");
    observer.send({ type: "subscribeFeed", agentId: "pilot" });
    gateway.script(
      { tool: "wait_for_round", id: "first-round" },
      { tool: "wait_for_stop", id: "blocked" },
      "The run should have stopped.",
    );
    const sender = await gateway.send("local", "Wait for the timer", { clientSendId: "timer" }, "ws");
    const runId = await vi.waitFor(() => {
      const observed = turns.events.find((event) => event.type === "active_turn" &&
        event.toolCalls.some(({ id, status }) => id === "first-round" && status === "running"));
      expect(observed).toEqual(expect.objectContaining({ runId: expect.any(String) }));
      return observed?.type === "active_turn" ? observed.runId : undefined;
    });
    // Let the first tool settle and drain its snapshots while afterTools holds
    // the boundary. The steer's admission then publishes the next snapshot.
    const finishedFirstRound = expect.objectContaining({
      type: "active_turn", runId, toolCalls: [expect.objectContaining({ id: "first-round", status: "done" })],
    });
    releaseRound.resolve();
    await vi.waitFor(() => expect(turns.events).toContainEqual(finishedFirstRound));
    turns.events.length = 0;
    const steer = await gateway.send("local", "Use the short timer", { clientSendId: "shorter-timer" }, "ws");
    await vi.waitFor(() => expect(turns.events).toContainEqual(finishedFirstRound));
    releaseBoundary.resolve();
    await vi.waitFor(() => expect(observer.events).toContainEqual(expect.objectContaining({
      live: expect.objectContaining({ runId, toolCalls: [expect.objectContaining({ id: "blocked", status: "running" })] }),
    })));
    await secondRound.promise;
    expect(gateway.requests[1]?.messages.filter(({ role }) => role === "user").map(({ content }) => content)).toEqual([
      "[from Local user via web]\nWait for the timer", "[from Local user via web]\nUse the short timer",
    ]);
    const live = (await (await gateway.request("local", feed)).json() as FeedWindow).live;
    expect(live?.runId).toBe(runId);
    expect((await gateway.request("local", stop, { method: "POST", body: '{"runId":null}' })).status).toBe(400);
    const response = await gateway.request("local", stop, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "stopped" });
    for (const [label, socket] of [["original", sender], ["steer", steer]] as const) {
      await vi.waitFor(() => expect(socket.events, label).toContainEqual(expect.objectContaining({
        type: "done", meta: expect.objectContaining({ aborted: true }),
      })));
    }
    await vi.waitFor(() => expect(observer.events.at(-1)).toMatchObject({ type: "feed_delta", live: null }));
    expect((await (await gateway.request("local", feed)).json()).live).toBeNull();
    await gateway.setDurableMode("local", false);
    expect((await gateway.request("local", stop, { method: "POST" })).status).toBe(404);
    expect((await gateway.request("local", "/api/agents/missing/stop", { method: "POST" })).status).toBe(404);
    expect(gateway.callCount()).toBe(2);
  } finally {
    releaseRound.resolve();
    releaseBoundary.resolve();
    releaseSecondRound.resolve();
    await gateway.close();
  }
});

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => { resolve = release; });
  return { promise, resolve };
}

it("keeps the run ID through a pending abort and gives the kept send its own run", async () => {
  const toolStarted = latch();
  const aborting = latch();
  const releaseAbort = latch();
  const releaseKept = latch();
  const gateway = await startDurableTestGateway({
    extraYaml: "toolDeferral: { enabled: false }",
    fixture: { extension: defineExtension({
      name: "stop-barrier",
      tools: [defineTool({
        name: "hold_until_stopped", description: "Hold the turn until it is stopped.", parameters: { type: "object" },
        async execute(_args, _api, context) {
          context.abortSignal?.addEventListener("abort", aborting.resolve, { once: true });
          toolStarted.resolve();
          await releaseAbort.promise;
          return { output: [{ type: "text", text: "Tool released." }] };
        },
      })],
    }) },
  });
  try {
    gateway.script({ tool: "hold_until_stopped", id: "hold-original" }, async () => {
      await releaseKept.promise;
      return "The follow-up is complete.";
    });
    const original = await gateway.send("local", "Hold this run", { clientSendId: "original" }, "ws");
    const observer = await gateway.subscribe("local");
    await vi.waitFor(() => expect(observer.events).toContainEqual(expect.objectContaining({
      type: "active_turn", toolCalls: [expect.objectContaining({ id: "hold-original", status: "running" })],
    })));
    const getLive = async () => (await (await gateway.request("local", feed)).json() as FeedWindow).live;
    const runId = (await getLive())?.runId;
    expect(runId).toEqual(expect.any(String));
    observer.events.length = 0;
    const kept = await gateway.send("local", "Complete the follow-up", { clientSendId: "kept" }, "ws");
    await vi.waitFor(() => expect(observer.events).toContainEqual(expect.objectContaining({
      type: "active_turn", runId, toolCalls: [expect.objectContaining({ id: "hold-original", status: "running" })],
    })));
    await toolStarted.promise;
    const stopOriginal = () => gateway.request("local", stop, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId }),
      signal: AbortSignal.timeout(3000),
    }).then((response) => response.json());
    const stopping = stopOriginal();
    await Promise.race([aborting.promise, stopping.then(() => { throw new Error("The stop finished before the tool released."); })]);
    const pendingObserver = await gateway.subscribe("local");
    await vi.waitFor(() => expect(pendingObserver.events).toContainEqual(expect.objectContaining({ type: "active_turn", runId })));
    const repeatedWhileStopping = stopOriginal();
    expect((await getLive())?.runId).toBe(runId);
    releaseAbort.resolve();
    expect(await stopping).toEqual({ status: "stopped" });
    expect(await repeatedWhileStopping).toEqual({ status: "already_finished" });
    await vi.waitFor(() => expect(gateway.callCount()).toBe(2));
    const keptRunId = (await getLive())?.runId;
    expect(keptRunId).toEqual(expect.any(String));
    expect(keptRunId).not.toBe(runId);
    expect(await stopOriginal()).toEqual({ status: "already_finished" });
    releaseKept.resolve();
    await vi.waitFor(() => {
      expect(original.events).toContainEqual(expect.objectContaining({
        type: "done", meta: expect.objectContaining({ aborted: true }),
      }));
      expect(kept.events).toContainEqual({ type: "text", data: "The follow-up is complete." });
      expect(kept.events).toContainEqual(expect.objectContaining({ type: "done" }));
    });
    expect(gateway.callCount()).toBe(2);
  } finally {
    releaseAbort.resolve();
    releaseKept.resolve();
    await gateway.close();
  }
});

it("treats raw Main stop commands as control requests without admitting them", async () => {
  const gateway = await startDurableTestGateway({ extraYaml: "toolDeferral: { enabled: false }" });
  try {
    gateway.script({ tool: "bash", id: "raw-stop-tool", args: { command: "sleep 15" } });
    const observer = await gateway.subscribe("local");
    const run = await gateway.send("local", "Hold for a raw stop", { clientSendId: "raw-stop-run" }, "ws");
    await vi.waitFor(() => expect(observer.events).toContainEqual(expect.objectContaining({
      type: "active_turn", toolCalls: [expect.objectContaining({ id: "raw-stop-tool", status: "running" })],
    })));
    const projectStop = await gateway.send("local", "/stop", { projectId: "another-project" }, "ws");
    await vi.waitFor(() => expect(projectStop.events).toEqual([{
      type: "error", code: "send_rejected",
      message: "Durable Main does not support project chats or desktop turn IDs.",
      userMessage: "Durable Main does not support project chats or desktop turn IDs.",
    }]));
    const attachedStop = await gateway.request("local", "/api/agents/pilot/messages", {
      method: "POST", body: JSON.stringify({ message: "/stop", attachments: [{}] }),
    });
    expect(attachedStop.status).toBe(400);
    const command = await gateway.send("local", "  /stop  ");
    expect(command.status).toBe(200);
    expect(await command.json()).toEqual({ status: "stopped" });
    await vi.waitFor(() => expect(run.events).toContainEqual(expect.objectContaining({
      type: "done", meta: expect.objectContaining({ aborted: true }),
    })));

    const rawSocket = await gateway.send("local", " /abort ", { sessionId: "durable-main", clientSendId: "raw-abort" }, "ws");
    await vi.waitFor(() => expect(rawSocket.events).toContainEqual(expect.objectContaining({
      type: "done", meta: expect.objectContaining({ stopStatus: "already_finished" }),
    })));
    const tail = await (await gateway.request("local", feed)).json() as FeedWindow;
    expect(tail.items.filter(({ role }) => role === "user").map(({ text }) => text)).toEqual(["Hold for a raw stop"]);
    expect(gateway.callCount()).toBe(1);
  } finally {
    await gateway.close();
  }
});

it.each([false, true])("steers ordered, attributed inputs into one answer (multi-user: %s)", async (multiUser) => {
  const users = multiUser ? ["alice", "bob"] as const : ["local"] as const;
  const recordings = new Map<string, ReturnType<typeof latch>>(users.map((user) => [user, latch()]));
  const toolsRun: string[] = [];
  const gateway = await startDurableTestGateway({
    multiUser, extraYaml: "toolDeferral: { enabled: false }",
    fixture: { extension: defineExtension({
      name: "steering-barrier",
      tools: [defineTool({
        name: "record_plot", description: "Record the named plot.",
        parameters: { type: "object", properties: { plot: { type: "string" } }, required: ["plot"] },
        async execute({ plot }) {
          toolsRun.push(plot);
          await recordings.get(plot)?.promise;
          return { output: [{ type: "text", text: "Recorded." }] };
        },
      })],
    }) },
  });
  const requests = (index: number) => gateway.requests[index]?.messages
    .filter((message) => message.role === "user").map(({ content }) => content);
  const answer = (index: number) => () => requests(index)?.join(" / ") ?? "No inputs.";
  try {
    gateway.script(
      ...users.map((user) => ({ tool: "record_plot", id: "record-" + user, args: { plot: user } })),
      ...users.map((_, index) => answer(users.length + index)),
    );
    const running = [];
    for (const user of users) {
      const observer = await gateway.subscribe(user);
      const original = gateway.send(user, "Record " + user, { clientSendId: "record-" + user });
      await vi.waitFor(() => expect(toolsRun).toContain(user));
      const active = expect.objectContaining({
        type: "active_turn", toolCalls: [expect.objectContaining({ id: "record-" + user, status: "running" })],
      });
      await vi.waitFor(() => expect(observer.events).toContainEqual(active));
      observer.events.length = 0;
      const second = gateway.send(user, "Include " + user + " basil", { clientSendId: "basil-" + user });
      await vi.waitFor(() => expect(observer.events).toContainEqual(active));
      observer.events.length = 0;
      const third = await gateway.send(user, "Then add " + user + " mint", { clientSendId: "mint-" + user }, "ws");
      await vi.waitFor(() => expect(observer.events).toContainEqual(active));
      running.push({ user, original, second, third });
    }

    for (const [index, { user, original, second, third }] of running.entries()) {
      recordings.get(user)?.resolve();
      const sender = user === "local" ? "Local user" : user;
      const expected = [
        `[from ${sender} via web]\nRecord ${user}`,
        `[from ${sender} via web]\nInclude ${user} basil`,
        `[from ${sender} via web]\nThen add ${user} mint`,
      ];
      const reply = expected.join(" / ");
      for (const send of [original, second]) {
        expect(await (await send).json()).toMatchObject({ payloads: [{ text: reply }] });
      }
      await vi.waitFor(() => expect(third.events).toContainEqual(expect.objectContaining({ type: "done" })));
      expect(third.events.flatMap((event) => event.type === "text" ? [event.data] : []).join("")).toBe(reply);
      expect(requests(users.length + index)).toEqual(expected);
      const tail = (await (await gateway.request(user, feed)).json()) as FeedWindow;
      expect(tail.items.filter(({ role }) => role === "assistant")).toMatchObject([
        { text: "", toolCallCount: 1 }, { text: reply, toolCallCount: 0 },
      ]);
    }
    expect(toolsRun).toEqual(users);
    expect(gateway.callCount()).toBe(users.length * 2);
  } finally {
    for (const barrier of recordings.values()) barrier.resolve();
    await gateway.close();
  }
});

it("keeps the run ID during a real after-run task and puts a later send in a new run", async () => {
  const answering = latch();
  const answer = latch();
  const afterRun = latch();
  const finishAfterRun = latch();
  const finishNext = latch();
  const afterNext = latch();
  const finishAfterNext = latch();
  let tasksRun = 0;
  const task = defineTask<null, { phase: "waiting" }, null>({
    name: "pause-after-run", version: 1,
    initial: () => ({ phase: "waiting" }),
    phases: {
      async waiting(_task, runtime, context) {
        if (++tasksRun === 1) {
          afterRun.resolve();
          await finishAfterRun.promise;
        } else {
          afterNext.resolve();
          await finishAfterNext.promise;
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
      },
    },
    async abort(_task, runtime, context) {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
  const gateway = await startDurableTestGateway({
    fixture: { extension: defineExtension({
      name: "after-run-barrier", tasks: [task],
      hooks: [hook(GenerationTask, { afterRun: () => ({ tasks: [hookTask(task, null)] }) })],
    }) },
  });
  try {
    gateway.script(async () => {
      answering.resolve();
      await answer.promise;
      return "The first answer.";
    }, async () => {
      await finishNext.promise;
      return "The second answer.";
    });
    const first = gateway.send("local", "Inspect the bed", { clientSendId: "first-bed" });
    await answering.promise;
    const getLive = async () => (await (await gateway.request("local", feed)).json() as FeedWindow).live;
    const firstId = (await getLive())?.runId;
    expect(firstId).toEqual(expect.any(String));
    answer.resolve();
    await afterRun.promise;
    expect(await (await first).json()).toMatchObject({ payloads: [{ text: "The first answer." }] });
    expect((await getLive())?.runId).toBe(firstId);
    expect((await gateway.history("local")).activeTurn).toMatchObject({ runId: firstId });

    const later = await gateway.send("local", "Inspect the nursery", { clientSendId: "second-bed" }, "ws");
    await later.flush();
    expect(gateway.callCount()).toBe(1);
    finishAfterRun.resolve();
    await vi.waitFor(() => expect(gateway.callCount()).toBe(2));
    const nextId = (await getLive())?.runId;
    expect(nextId).toEqual(expect.any(String));
    expect(nextId).not.toBe(firstId);
    const lateStop = await gateway.request("local", stop, {
      method: "POST", body: JSON.stringify({ runId: firstId }),
    });
    expect(await lateStop.json()).toEqual({ status: "already_finished" });
    const observer = await gateway.subscribe("local");
    await vi.waitFor(() => expect(observer.events).toContainEqual(expect.objectContaining({ type: "active_turn", runId: nextId })));
    finishNext.resolve();
    await afterNext.promise;
    await vi.waitFor(() => expect(later.events).toContainEqual({ type: "text", data: "The second answer." }));
    expect((await gateway.history("local")).activeTurn).toMatchObject({ runId: nextId });
    finishAfterNext.resolve();
    await vi.waitFor(async () => expect((await getLive())).toBeNull());
    await vi.waitFor(() => expect(observer.events.filter(({ type }) => type === "history_updated")).toHaveLength(1));
    expect(gateway.callCount()).toBe(2);
  } finally {
    answer.resolve();
    finishAfterRun.resolve();
    finishNext.resolve();
    finishAfterNext.resolve();
    await gateway.close();
  }
});

it("isolates Main stops by account and refuses an unapproved caller", async () => {
  const release = latch();
  const gateway = await startDurableTestGateway({ multiUser: true });
  try {
    gateway.script(async () => {
      await release.promise;
      return "Alice's run was left alone.";
    });
    const running = gateway.send("alice", "Run Alice's check", { clientSendId: "alice-check" });
    await vi.waitFor(() => expect(gateway.callCount()).toBe(1));
    const alice = (await (await gateway.request("alice", feed)).json()) as FeedWindow;
    expect(alice.live?.runId).toEqual(expect.any(String));
    const bobStop = await gateway.request("bob", stop, {
      method: "POST", body: JSON.stringify({ runId: alice.live?.runId }),
    });
    expect(await bobStop.json()).toEqual({ status: "already_finished" });
    expect(await (await gateway.request("bob", stop, { method: "POST" })).json()).toEqual({ status: "already_finished" });

    const bobSocket = await gateway.socket("bob");
    const revoke = await gateway.request("alice", "/api/admin/users/" + gateway.accountId("bob"), {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: false }),
    });
    expect(revoke.status).toBe(200);
    expect((await gateway.request("bob", stop, { method: "POST" })).status).toBe(403);
    bobSocket.send({ type: "send", agentId: "pilot", message: "/stop" });
    await vi.waitFor(() => expect(bobSocket.events).toContainEqual({
      type: "error", code: "send_rejected", message: "Forbidden", userMessage: "Forbidden",
    }));
    release.resolve();
    expect(await (await running).json()).toMatchObject({ payloads: [{ text: "Alice's run was left alone." }] });
  } finally {
    release.resolve();
    await gateway.close();
  }
}, 12000);

it("defers a reviewed follow-up until the first reply can be rewritten", async () => {
  const reviewing = latch();
  const release = latch();
  const gateway = await startDurableTestGateway({
    reviewer: {
      begin() {}, end() {},
      async review(text) {
        if (text !== "First draft.") return { ok: true };
        reviewing.resolve();
        await release.promise;
        return { ok: false, rewriteHint: "Mention the basil." };
      },
    },
  });
  try {
    gateway.script("First draft.", "The basil is ready.", "The mint is ready.");
    const original = gateway.send("local", "Check the basil", { clientSendId: "basil" });
    await reviewing.promise;
    const later = await gateway.send("local", "Check the mint", { clientSendId: "mint" }, "ws");
    await later.flush();
    expect(gateway.callCount()).toBe(1);
    release.resolve();
    expect(await (await original).json()).toMatchObject({ payloads: [{ text: "The basil is ready." }] });
    await vi.waitFor(() => expect(later.events).toContainEqual({ type: "text", data: "The mint is ready." }));
    expect(gateway.callCount()).toBe(3);
    expect(gateway.requests[1]?.messages.filter(({ role }) => role === "user").map(({ content }) => content)).toEqual([
      "[from Local user via web]\nCheck the basil",
      "Rewrite your last reply using this feedback:\n[fixture-reviewer] Mention the basil.",
    ]);
  } finally {
    release.resolve();
    await gateway.close();
  }
});

it("stops promptly when a reviewer and a later send are both waiting", async () => {
  const reviewing = latch();
  const release = latch();
  const gateway = await startDurableTestGateway({
    reviewer: {
      begin() {}, end() {},
      async review(text) {
        if (text === "Held draft.") {
          reviewing.resolve();
          await release.promise;
        }
        return { ok: true };
      },
    },
  });
  try {
    gateway.script("Held draft.", "The replacement request is ready.");
    const first = await gateway.send("local", "Check the first plot", { clientSendId: "held" }, "ws");
    await reviewing.promise;
    const running = (await (await gateway.request("local", feed)).json()) as FeedWindow;
    expect(running.live?.runId).toEqual(expect.any(String));
    const later = await gateway.send("local", "Check the next plot", { clientSendId: "after-held" }, "ws");
    const stopped = await gateway.request("local", stop, {
      method: "POST", body: JSON.stringify({ runId: running.live?.runId }), signal: AbortSignal.timeout(1500),
    });
    expect(await stopped.json()).toEqual({ status: "stopped" });
    await vi.waitFor(() => expect(first.events).toContainEqual(expect.objectContaining({
      type: "done", meta: expect.objectContaining({ aborted: true }),
    })));
    await vi.waitFor(() => expect(later.events).toContainEqual({ type: "text", data: "The replacement request is ready." }));
    expect((await (await gateway.request("local", feed)).json()).live).toBeNull();
    expect(JSON.stringify(first.events)).not.toContain("Held draft.");
  } finally {
    release.resolve();
    await gateway.close();
  }
});

it("resumes a kept input after restart if Durable mode was turned off during abort", async () => {
  const toolStarted = latch();
  const aborting = latch();
  const releaseAbort = latch();
  const releaseKept = latch();
  const gateway = await startDurableTestGateway({
    multiUser: true, extraYaml: "toolDeferral: { enabled: false }",
    fixture: { extension: defineExtension({
      name: "stop-recovery-barrier",
      tools: [defineTool({
        name: "wait_for_access_change", description: "Hold until access changes.", parameters: { type: "object" },
        async execute(_args, _api, context) {
          context.abortSignal?.addEventListener("abort", aborting.resolve, { once: true });
          toolStarted.resolve();
          await releaseAbort.promise;
          return { output: [{ type: "text", text: "Released." }] };
        },
      })],
    }) },
  });
  const getLive = async () => (await (await gateway.request("bob", feed)).json() as FeedWindow).live;
  try {
    gateway.script({ tool: "wait_for_access_change" }, async () => {
      await releaseKept.promise;
      return "Recovered the kept request.";
    });
    const observer = await gateway.subscribe("bob");
    await gateway.send("bob", "Hold for access change", { clientSendId: "access-original" }, "ws");
    await toolStarted.promise;
    const runId = (await getLive())?.runId;
    expect(runId).toEqual(expect.any(String));
    await vi.waitFor(() => expect(observer.events).toContainEqual(expect.objectContaining({ type: "active_turn", runId })));
    observer.events.length = 0;
    await gateway.send("bob", "Remember to check the mint", { clientSendId: "access-kept" }, "ws");
    await vi.waitFor(() => expect(observer.events).toContainEqual(expect.objectContaining({ type: "active_turn", runId })));

    const stopOriginal = () => gateway.request("bob", stop, {
      method: "POST", body: JSON.stringify({ runId }), signal: AbortSignal.timeout(3000),
    });
    const stopping = stopOriginal();
    await Promise.race([aborting.promise, stopping.then(() => { throw new Error("The stop finished before the tool released."); })]);
    await gateway.setDurableMode("bob", false);
    releaseAbort.resolve();
    expect(await (await stopping).json()).toEqual({ status: "stopped" });
    expect(gateway.callCount()).toBe(1);
    await gateway.setDurableMode("bob", true);
    await gateway.restart();
    await vi.waitFor(() => expect(gateway.callCount()).toBe(2));
    const keptId = (await getLive())?.runId;
    expect(keptId).toEqual(expect.any(String));
    expect(keptId).not.toBe(runId);
    expect(await (await stopOriginal()).json()).toEqual({ status: "already_finished" });
    releaseKept.resolve();
    await vi.waitFor(async () => {
      const tail = (await (await gateway.request("bob", feed)).json()) as FeedWindow;
      expect(tail.items).toContainEqual(expect.objectContaining({ role: "assistant", text: "Recovered the kept request." }));
    });
    expect(gateway.callCount()).toBe(2);
  } finally {
    releaseAbort.resolve();
    releaseKept.resolve();
    await gateway.close();
  }
}, 12000);
