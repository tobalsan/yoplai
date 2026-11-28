import { defineExtension, defineTool, GenerationTask, hook } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";

type Gateway = Awaited<ReturnType<typeof startDurableTestGateway>>;
type User = Parameters<Gateway["request"]>[0];

async function post(gateway: Gateway, user: User, pathname: string, body: object) {
  const response = await gateway.request(user, pathname, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json();
}

async function roomFor(gateway: Gateway, user: User) {
  const { id } = await post(gateway, user, "/api/chat-projects", { name: "Orchard" }) as { id: string };
  return { id, path: "/api/rooms/" + id };
}

function modelInputs(gateway: Gateway, index: number) {
  return gateway.requests[index]?.messages.filter((item) => item.role === "user").map((item) =>
    typeof item.content === "string" ? item.content : item.content.map((block) => block.type === "text" ? block.text : "").join(""));
}

it("stores unmentioned context and publishes one answer to a room mention with Durable preferences off", async () => {
  const gateway = await startDurableTestGateway({ enableDurableMode: false });
  try {
    const room = await roomFor(gateway, "local");
    await post(gateway, "local", room.path + "/agents", { agentId: "pilot" });
    const watcher = await gateway.socket();
    watcher.send({ type: "subscribeRoomFeed", roomId: room.id });
    await vi.waitFor(() => expect(watcher.events[0]).toMatchObject({ type: "feed_snapshot", items: [] }));
    await post(gateway, "local", room.path + "/messages", { clientSendId: "context", message: "Pear trees are ready." });
    await vi.waitFor(() => expect(watcher.events[1]).toMatchObject({ upsert: [{ text: "Pear trees are ready." }] }));
    expect(gateway.callCount()).toBe(0);
    await post(gateway, "local", room.path + "/messages", { clientSendId: "ask", message: "@PILOT. What should we plant?" });
    await vi.waitFor(() => expect(watcher.events.flatMap((frame) =>
      frame.type === "feed_delta" ? frame.upsert : frame.type === "feed_snapshot" ? frame.items : [],
    )).toContainEqual(expect.objectContaining({
      id: "r_3", role: "assistant", sender: "pilot", text: "The seedlings are ready.",
    })));
    expect(gateway.callCount()).toBe(1);
    expect(modelInputs(gateway, 0)?.join("\n\n")).toBe(
      "[from Local user via web]\nPear trees are ready.\n\n[from Local user via web]\n@PILOT. What should we plant?",
    );
    const feed = await (await gateway.request("local", room.path + "/feed")).json();
    expect(feed.items.map(({ id, role, sender, text }: { id: string; role: string; sender: string; text: string }) => ({ id, role, sender, text }))).toEqual([
      { id: "r_1", role: "user", sender: "Local user", text: "Pear trees are ready." },
      { id: "r_2", role: "user", sender: "Local user", text: "@PILOT. What should we plant?" },
      { id: "r_3", role: "assistant", sender: "pilot", text: "The seedlings are ready." },
    ]);
  } finally {
    await gateway.close();
  }
});

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => { resolve = release; });
  return { promise, resolve };
}

async function feed(gateway: Gateway, user: User, roomPath: string) {
  const response = await gateway.request(user, roomPath + "/feed");
  expect(response.status).toBe(200);
  return (await response.json() as import("@yoplai/shared").FeedWindow).items;
}

function say(gateway: Gateway, user: User, path: string, clientSendId: string, message: string) {
  return post(gateway, user, path + "/messages", { clientSendId, message });
}

it("keeps a last-round steer as passive context when there is no next mention", async () => {
  const release = latch();
  const delivered = latch();
  const gateway = await startDurableTestGateway({
    afterRoomCommit({ lastSeq }) {
      if (lastSeq === 2) delivered.resolve();
    },
  });
  try {
    const room = await roomFor(gateway, "local");
    await post(gateway, "local", room.path + "/agents", { agentId: "pilot" });
    gateway.script(async () => {
      await release.promise;
      return "Plant pears.";
    }, "Set the irrigation timer.");
    await say(gateway, "local", room.path, "first", "@pilot What goes in bed one?");
    await vi.waitFor(() => expect(gateway.callCount()).toBe(1));
    await say(gateway, "local", room.path, "late", "The irrigation is on.");
    await delivered.promise;
    release.resolve();
    await vi.waitFor(async () => expect((await feed(gateway, "local", room.path)).at(-1)).toMatchObject({ text: "Plant pears." }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(gateway.callCount()).toBe(1);
    await say(gateway, "local", room.path, "second", "@pilot Check the water.");
    await vi.waitFor(async () => expect((await feed(gateway, "local", room.path)).at(-1)).toMatchObject({ text: "Set the irrigation timer." }));
    expect(modelInputs(gateway, 1)).toEqual([
      "[from Local user via web]\n@pilot What goes in bed one?",
      "[from Local user via web]\nThe irrigation is on.",
      "[from Local user via web]\n@pilot Check the water.",
    ]);
  } finally {
    release.resolve();
    await gateway.close();
  }
});

function untilAbort(signal?: AbortSignal) {
  if (!signal || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function blockedTool(release: ReturnType<typeof latch>) {
  let executions = 0;
  let aborts = 0;
  const fixture = { extension: defineExtension({
    name: "room-barrier",
    tools: [defineTool({
      name: "hold_orchard", description: "Wait for the orchard check.", parameters: { type: "object" },
      async execute(_args, _api, context) {
        executions++;
        await Promise.race([release.promise, untilAbort(context.abortSignal)]);
        if (context.abortSignal?.aborted) aborts++;
        return { output: [{ type: "text", text: "Orchard checked." }] };
      },
    })],
  }) };
  return { fixture, executions: () => executions, aborts: () => aborts };
}

it("delivers ordered two-person steers, a late handoff and exactly-once context after a fan-out fault", async () => {
  const release = latch();
  const fault = latch();
  const tool = blockedTool(release);
  const delivered = new Map<string, number>();
  let crashSeq: number | undefined;
  const gateway = await startDurableTestGateway({
    multiUser: true, enableDurableMode: false, fixture: tool.fixture,
    additionalAgents: [{ id: "scout", model: { provider: "faux", model: "fixture" } }],
    async afterRoomCommit({ agentId, lastSeq }, signal) {
      delivered.set(agentId, lastSeq);
      if (agentId === "scout" && lastSeq === crashSeq) {
        fault.resolve();
        // Keep this delivery interrupted while another event commits in the room.
        await untilAbort(signal);
        throw new Error("Fixture interrupted fan-out after the Durable commit.");
      }
    },
  });
  try {
    const room = await roomFor(gateway, "alice");
    await post(gateway, "alice", room.path + "/agents", { agentId: "pilot" });
    gateway.script({ tool: "hold_orchard" }, "Plant pears beside @scout.", "Scout checked the plan.", "Pilot has the update.");
    await say(gateway, "alice", room.path, "background", "The orchard has two beds.");
    await say(gateway, "alice", room.path, "ask", "@pilot Check both beds.");
    await vi.waitFor(() => expect(tool.executions()).toBe(1));
    await post(gateway, "alice", room.path + "/members", { userId: gateway.accountId("bob") });
    expect((await feed(gateway, "bob", room.path)).map(({ text }) => text)).toEqual([
      "The orchard has two beds.", "@pilot Check both beds.",
    ]);
    await post(gateway, "alice", room.path + "/agents", { agentId: "scout" });
    await say(gateway, "alice", room.path, "steer-a", "Use the east bed first.");
    const bobSteer = "@pilot Add one pear tree.";
    expect(await say(gateway, "bob", room.path, "steer-b", bobSteer)).toEqual({ id: "r_4", seq: 4, duplicate: false });
    expect(await say(gateway, "bob", room.path, "steer-b", bobSteer)).toEqual({ id: "r_4", seq: 4, duplicate: true });
    await vi.waitFor(() => expect(delivered.get("pilot")).toBe(4));
    release.resolve();
    await vi.waitFor(async () => expect((await feed(gateway, "bob", room.path)).at(-1)).toMatchObject({
      id: "r_5", role: "assistant", sender: "pilot", text: "Plant pears beside @scout.",
    }));
    expect(modelInputs(gateway, 1)?.join("\n\n")).toBe([
      "[from alice via web]\nThe orchard has two beds.",
      "[from alice via web]\n@pilot Check both beds.",
      "[from alice via web]\nUse the east bed first.",
      "[from bob via web]\n@pilot Add one pear tree.",
    ].join("\n\n"));
    await vi.waitFor(() => expect(delivered.get("scout")).toBe(5));
    expect(gateway.callCount()).toBe(2);
    expect(tool.executions()).toBe(1);

    crashSeq = 6;
    await say(gateway, "alice", room.path, "fault", "The gate is unlocked.");
    await fault.promise;
    await say(gateway, "bob", room.path, "after-fault", "The south path is clear.");
    await gateway.restart();
    const watcher = await gateway.socket("bob");
    watcher.send({ type: "subscribeRoomFeed", roomId: room.id });
    await vi.waitFor(() => expect(watcher.events[0]).toMatchObject({
      type: "feed_snapshot", items: expect.arrayContaining([
        expect.objectContaining({ id: "r_5", text: "Plant pears beside @scout." }),
        expect.objectContaining({ id: "r_7", text: "The south path is clear." }),
      ]),
    }));
    expect(gateway.callCount()).toBe(2);
    await say(gateway, "bob", room.path, "first-scout", "@scout Check the orchard.");
    await vi.waitFor(async () => expect((await feed(gateway, "bob", room.path)).at(-1)).toMatchObject({
      id: "r_9", role: "assistant", sender: "scout", text: "Scout checked the plan.",
    }));
    const [handoff, ...scoutInputs] = modelInputs(gateway, 2) ?? [];
    expect(handoff?.replace(/ · \d{4}-\d\d-\d\dT[^ ]+Z/g, "")).toContain(
      "[r_1] user · alice\nThe orchard has two beds.\n\n[r_2] user · alice\n@pilot Check both beds.",
    );
    expect(scoutInputs.join("\n\n")).toBe([
      "[from alice via web]\nUse the east bed first.",
      "[from bob via web]\n@pilot Add one pear tree.",
      "[from pilot via web]\nPlant pears beside @scout.",
      "[from alice via web]\nThe gate is unlocked.",
      "[from bob via web]\nThe south path is clear.",
      "[from bob via web]\n@scout Check the orchard.",
    ].join("\n\n"));
    await say(gateway, "alice", room.path, "pilot-update", "@pilot Confirm the update.");
    await vi.waitFor(async () => expect((await feed(gateway, "alice", room.path)).at(-1)).toMatchObject({
      id: "r_11", role: "assistant", sender: "pilot", text: "Pilot has the update.",
    }));
    const log = await feed(gateway, "alice", room.path);
    expect(log.filter(({ text }) => text === "Plant pears beside @scout.")).toHaveLength(1);
    const visibleToPilot = log.slice(0, -1).filter((item) => item.role === "user" || (item.role === "assistant" && item.sender === "scout"));
    expect(modelInputs(gateway, 3)?.join("\n\n")).toBe(visibleToPilot.map((item) =>
      `[from ${"sender" in item ? item.sender : ""} via web]\n${item.text}`).join("\n\n"));
    expect(gateway.requests[3]?.messages.filter(({ role }) => role === "assistant")).toContainEqual(
      expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ text: "Plant pears beside @scout." })]) }),
    );
  } finally {
    release.resolve();
    await gateway.close();
  }
}, 20_000);

it.each(["remove", "restart after removal", "delete project"] as const)(
  "withdraws a queued steer and aborts old room work on %s",
  async (scenario) => {
    const release = latch();
    const tool = blockedTool(release);
    const committed = latch();
    const gateway = await startDurableTestGateway({
      fixture: tool.fixture,
      async afterRoomCommit({ lastSeq }, signal) {
        if (lastSeq !== 4) return;
        committed.resolve();
        if (scenario === "restart after removal") await untilAbort(signal);
      },
    });
    try {
      const room = await roomFor(gateway, "local");
      await post(gateway, "local", room.path + "/agents", { agentId: "pilot" });
      gateway.script("Earlier pilot answer.", { tool: "hold_orchard" }, "Fresh membership answer.");
      await say(gateway, "local", room.path, "earlier", "@pilot Check the toolshed.");
      await vi.waitFor(async () => expect((await feed(gateway, "local", room.path)).at(-1)).toMatchObject({ text: "Earlier pilot answer." }));
      await say(gateway, "local", room.path, "blocked", "@pilot Inspect the north bed.");
      await vi.waitFor(() => expect(tool.executions()).toBe(1));
      await say(gateway, "local", room.path, "queued", "The soil in that bed is dry.");
      await committed.promise;

      const target = scenario === "delete project" ? "/api/chat-projects/" + room.id : room.path + "/agents/pilot";
      expect((await gateway.request("local", target, { method: "DELETE" })).status).toBe(200);
      if (scenario === "restart after removal") {
        await gateway.restart();
      } else {
        await vi.waitFor(() => expect(tool.aborts()).toBe(1));
      }
      if (scenario === "delete project") {
        expect((await gateway.request("local", room.path + "/feed")).status).toBe(404);
        expect(gateway.callCount()).toBe(2);
        return;
      }

      expect((await feed(gateway, "local", room.path)).map(({ text }) => text)).toEqual([
        "@pilot Check the toolshed.", "Earlier pilot answer.", "@pilot Inspect the north bed.", "The soil in that bed is dry.",
      ]);
      await post(gateway, "local", room.path + "/agents", { agentId: "pilot" });
      await say(gateway, "local", room.path, "fresh", "@pilot List the dry beds.");
      await vi.waitFor(async () => expect((await feed(gateway, "local", room.path)).at(-1)).toMatchObject({ text: "Fresh membership answer." }));
      expect(gateway.callCount()).toBe(3);
      expect(tool.executions()).toBe(1);
      const input = modelInputs(gateway, 2) ?? [];
      const seed = input.find((message) => message.includes("[r_4] user"));
      expect(seed).toContain("The soil in that bed is dry.");
      expect(input.join("\n").match(/The soil in that bed is dry\./g)).toHaveLength(1);
      expect(input.join("\n")).not.toContain("Earlier pilot answer.");
      expect(input.at(-1)).toBe("[from Local user via web]\n@pilot List the dry beds.");
    } finally {
      release.resolve();
      await gateway.close();
    }
  },
  12_000,
);

it("projects and delivers a thread digest once to each room agent", async () => {
  const gateway = await startDurableTestGateway({
    additionalAgents: [{ id: "scout", model: { provider: "faux", model: "fixture" } }],
  });
  try {
    const room = await roomFor(gateway, "local");
    for (const agentId of ["pilot", "scout"]) {
      await post(gateway, "local", room.path + "/agents", { agentId });
    }
    const watcher = await gateway.socket();
    watcher.send({ type: "subscribeRoomFeed", roomId: room.id });
    await vi.waitFor(() => expect(watcher.events[0]).toMatchObject({ type: "feed_snapshot", items: [] }));
    gateway.appendRoomDigest(room.id, "stocktake", 1, "Leave the apples in storage.");
    gateway.appendRoomDigest(room.id, "stocktake", 1, "This duplicate should be ignored.");
    const digest = { id: "r_1", role: "user", sender: "Thread digest", text: "Leave the apples in storage.", timestamp: expect.any(Number) };
    await vi.waitFor(() => expect(watcher.events[1]).toMatchObject({ type: "feed_delta" }));
    const delta = watcher.events[1];
    expect(delta.type === "feed_delta" && delta.upsert).toEqual([digest]);
    expect(await feed(gateway, "local", room.path)).toEqual([digest]);
    expect(gateway.callCount()).toBe(0);
    gateway.script("Pilot read it.", "Scout read it.");
    await say(gateway, "local", room.path, "pilot-digest", "@pilot Read the note.");
    await vi.waitFor(async () => expect((await feed(gateway, "local", room.path)).at(-1)).toMatchObject({ text: "Pilot read it." }));
    await say(gateway, "local", room.path, "scout-digest", "@scout Read the note.");
    await vi.waitFor(async () => expect((await feed(gateway, "local", room.path)).at(-1)).toMatchObject({ text: "Scout read it." }));
    for (const index of [0, 1]) {
      expect(modelInputs(gateway, index)?.join("\n").match(/\[from Thread digest via web\]\nLeave the apples in storage\./g)).toHaveLength(1);
    }
  } finally {
    await gateway.close();
  }
});

it("lets a held reply finish review and its rewrite before later room input", async () => {
  const held = latch();
  const release = latch();
  const gateway = await startDurableTestGateway({
    reviewer: {
      begin() {},
      end() {},
      async review(text) {
        if (text === "Private draft.") {
          held.resolve();
          await release.promise;
          return { ok: false, rewriteHint: "Use only the public stock count." };
        }
        return { ok: true };
      },
    },
  });
  try {
    const room = await roomFor(gateway, "local");
    await post(gateway, "local", room.path + "/agents", { agentId: "pilot" });
    gateway.script("Private draft.", "Three pear trees.", "Two need stakes.");
    await say(gateway, "local", room.path, "count", "@pilot Give the stock count.");
    await held.promise;
    await say(gateway, "local", room.path, "stakes", "@pilot Which trees need stakes?");
    expect((await feed(gateway, "local", room.path)).map(({ text }) => text)).toEqual([
      "@pilot Give the stock count.", "@pilot Which trees need stakes?",
    ]);
    expect(gateway.callCount()).toBe(1);
    release.resolve();
    await vi.waitFor(async () => expect((await feed(gateway, "local", room.path)).map(({ text }) => text)).toEqual([
      "@pilot Give the stock count.", "@pilot Which trees need stakes?", "Three pear trees.", "Two need stakes.",
    ]));
    expect(modelInputs(gateway, 1)?.at(-1)).toContain("Use only the public stock count.");
    expect(modelInputs(gateway, 1)?.join("\n")).not.toContain("Which trees need stakes?");
    expect(modelInputs(gateway, 2)?.at(-1)).toBe("[from Local user via web]\n@pilot Which trees need stakes?");
  } finally {
    release.resolve();
    await gateway.close();
  }
}, 12_000);

it("replays a settled public answer when the gateway stopped before publishing it", async () => {
  const committed = latch();
  const settled = latch();
  let pause = true;
  const gateway = await startDurableTestGateway({
    fixture: { extension: defineExtension({
      name: "room-settlement-probe",
      hooks: [hook(GenerationTask, { afterRun() { settled.resolve(); return undefined; } })],
    }) },
    async afterRoomCommit({ lastSeq }, signal) {
      if (!pause || lastSeq !== 1) return;
      committed.resolve();
      await untilAbort(signal);
    },
  });
  try {
    const room = await roomFor(gateway, "local");
    await post(gateway, "local", room.path + "/agents", { agentId: "pilot" });
    await say(gateway, "local", room.path, "answer", "@pilot What is ready?");
    await committed.promise;
    await settled.promise;
    expect((await feed(gateway, "local", room.path)).map(({ role }) => role)).toEqual(["user"]);
    pause = false;
    await gateway.restart();
    await vi.waitFor(async () => expect((await feed(gateway, "local", room.path)).map(({ text }) => text)).toEqual([
      "@pilot What is ready?", "The seedlings are ready.",
    ]));
    await gateway.restart();
    expect((await feed(gateway, "local", room.path)).map(({ role }) => role)).toEqual(["user", "assistant"]);
    expect(gateway.callCount()).toBe(1);
  } finally {
    await gateway.close();
  }
}, 12_000);

it("catches up on startup when an eligible room agent has never opened a Durable store", async () => {
  const gateway = await startDurableTestGateway({
    enableDurableMode: false,
    additionalAgents: [{ id: "scout", model: { provider: "faux", model: "fixture" } }],
  });
  try {
    gateway.setSingleAgentMode("scout");
    const room = await roomFor(gateway, "local");
    await post(gateway, "local", room.path + "/agents", { agentId: "pilot" });
    await say(gateway, "local", room.path, "while-inactive", "@pilot Check the seedlings.");
    expect((await feed(gateway, "local", room.path)).map(({ role }) => role)).toEqual(["user"]);
    expect(gateway.callCount()).toBe(0);
    gateway.setSingleAgentMode(null);
    await gateway.restart();
    await vi.waitFor(async () => expect((await feed(gateway, "local", room.path)).at(-1)).toMatchObject({
      role: "assistant", sender: "pilot", text: "The seedlings are ready.",
    }));
    expect(modelInputs(gateway, 0)).toEqual(["[from Local user via web]\n@pilot Check the seedlings."]);
  } finally {
    gateway.setSingleAgentMode(null);
    await gateway.close();
  }
}, 12_000);

it.each(["restart", "stop"] as const)("publishes a mention queued during after-run work after %s", async (action) => {
  const afterRun = latch();
  const queued = latch();
  let hold = true;
  const gateway = await startDurableTestGateway({
    fixture: { extension: defineExtension({
      name: "room-after-run-barrier",
      hooks: [hook(GenerationTask, {
        async afterRun(_run, _api, context) {
          if (!hold) return undefined;
          afterRun.resolve();
          await untilAbort(context.abortSignal);
          return undefined;
        },
      })],
    }) },
    afterRoomCommit({ lastSeq }) {
      if (lastSeq === 3) queued.resolve();
    },
  });
  try {
    const room = await roomFor(gateway, "local");
    await post(gateway, "local", room.path + "/agents", { agentId: "pilot" });
    gateway.script("The first bed is ready.", "The second bed is ready.");
    await say(gateway, "local", room.path, "first-bed", "@pilot Check the first bed.");
    await afterRun.promise;
    await vi.waitFor(async () => expect((await feed(gateway, "local", room.path)).at(-1)).toMatchObject({
      id: "r_2", text: "The first bed is ready.",
    }));
    await say(gateway, "local", room.path, "second-bed", "@pilot Check the second bed.");
    await queued.promise;
    expect(gateway.callCount()).toBe(1);
    hold = false;
    if (action === "restart") {
      await gateway.restart();
    } else {
      const response = await gateway.request("local", room.path + "/agents/pilot/stop", {
        method: "POST", signal: AbortSignal.timeout(3000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "stopped" });
    }
    await vi.waitFor(async () => expect((await feed(gateway, "local", room.path)).map(({ text }) => text)).toEqual([
      "@pilot Check the first bed.", "The first bed is ready.", "@pilot Check the second bed.", "The second bed is ready.",
    ]));
    expect(modelInputs(gateway, 1)?.at(-1)).toBe("[from Local user via web]\n@pilot Check the second bed.");
    expect(gateway.callCount()).toBe(2);
  } finally {
    await gateway.close();
  }
}, 12_000);

it("leaves kept unmentioned context idle after a tagged turn fails", async () => {
  const release = latch();
  const delivered = latch();
  const gateway = await startDurableTestGateway({
    extraYaml: "retryMaxAttempts: 1",
    afterRoomCommit({ lastSeq }) {
      if (lastSeq === 2) delivered.resolve();
    },
  });
  try {
    const room = await roomFor(gateway, "local");
    await post(gateway, "local", room.path + "/agents", { agentId: "pilot" });
    gateway.script(async () => {
      await release.promise;
      throw new Error("Orchard fixture response failed.");
    }, "The pear trees are ready.");
    await say(gateway, "local", room.path, "will-fail", "@pilot Check the trees.");
    await vi.waitFor(() => expect(gateway.callCount()).toBe(1));
    await say(gateway, "local", room.path, "kept-context", "The east bed has been watered.");
    await delivered.promise;
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(gateway.callCount()).toBe(1);
    expect((await feed(gateway, "local", room.path)).map(({ role }) => role)).toEqual(["user", "user"]);
    await say(gateway, "local", room.path, "passes-idle", "The west bed is still dry.");
    await say(gateway, "local", room.path, "try-again", "@pilot Check again.");
    await vi.waitFor(async () => expect((await feed(gateway, "local", room.path)).at(-1)).toMatchObject({
      role: "assistant", text: "The pear trees are ready.",
    }));
    expect(modelInputs(gateway, 1)?.slice(1).join("\n\n")).toBe([
      "[from Local user via web]\nThe east bed has been watered.",
      "[from Local user via web]\nThe west bed is still dry.",
      "[from Local user via web]\n@pilot Check again.",
    ].join("\n\n"));
    expect(gateway.callCount()).toBe(2);
  } finally {
    release.resolve();
    await gateway.close();
  }
}, 12_000);

it("shows a room run beside its first mention and clears it when the answer settles", async () => {
  const release = latch();
  const delivery = latch();
  const admitted = latch();
  const gateway = await startDurableTestGateway({
    async afterRoomCommit({ lastSeq }) {
      if (lastSeq !== 1) return;
      admitted.resolve();
      await delivery.promise;
    },
  });
  try {
    const room = await roomFor(gateway, "local");
    const watcher = await gateway.socket();
    watcher.send({ type: "subscribeRoomFeed", roomId: room.id });
    await vi.waitFor(() => expect(watcher.events[0]).toMatchObject({ type: "feed_snapshot" }));
    await post(gateway, "local", room.path + "/agents", { agentId: "pilot" });
    gateway.script(async () => {
      await release.promise;
      return "Water the east bed.";
    });
    await say(gateway, "local", room.path, "hold-delivery", "The orchard opens today.");
    await admitted.promise;
    await say(gateway, "local", room.path, "context", "The east bed is dry.");
    await say(gateway, "local", room.path, "mention", "@pilot Check the beds.");
    await vi.waitFor(() => {
      const frame = watcher.events.at(-1);
      expect(frame).toMatchObject({ roomRuns: [] });
      expect(frame?.type === "feed_snapshot" ? frame.items : frame?.type === "feed_delta" ? frame.upsert : [])
        .toContainEqual(expect.objectContaining({ id: "r_3" }));
    });
    delivery.resolve();
    const expected = [{ agentId: "pilot", messageId: "r_3", runId: expect.stringMatching(/^\S+$/) }];
    await vi.waitFor(async () => {
      const window = await (await gateway.request("local", room.path + "/feed")).json();
      expect(window.roomRuns).toEqual(expected);
    });
    await vi.waitFor(() => expect(watcher.events).toContainEqual(expect.objectContaining({
      type: "feed_delta", upsert: [], live: null, roomRuns: expected,
    })));
    await vi.waitFor(() => expect(modelInputs(gateway, 0)?.at(-1)).toBe(
      "[from Local user via web]\nThe east bed is dry.\n\n[from Local user via web]\n@pilot Check the beds.",
    ));
    release.resolve();
    await vi.waitFor(async () => {
      const window = await (await gateway.request("local", room.path + "/feed")).json();
      expect(window.items.at(-1)).toMatchObject({ text: "Water the east bed." });
      expect(window.roomRuns).toEqual([]);
    });
    await vi.waitFor(() => expect(watcher.events.at(-1)).toMatchObject({ roomRuns: [] }));
  } finally {
    delivery.resolve();
    release.resolve();
    await gateway.close();
  }
});

it("returns each room answer's public trace to current room members", async () => {
  const release = latch();
  release.resolve();
  const tool = blockedTool(release);
  const gateway = await startDurableTestGateway({ multiUser: true, fixture: tool.fixture });
  try {
    const room = await roomFor(gateway, "alice");
    await post(gateway, "alice", room.path + "/members", { userId: gateway.accountId("bob") });
    await post(gateway, "alice", room.path + "/agents", { agentId: "pilot" });
    gateway.script(
      [{ thinking: "Check whether the orchard is ready." }, { tool: "hold_orchard", id: "orchard-check" }],
      "The orchard is ready.",
      [{ thinking: "Put pears in the east bed." }, { tool: "hold_orchard", id: "east-check" }],
      "Plant the pears.",
    );
    await say(gateway, "bob", room.path, "first", "@pilot Is the orchard ready?");
    await vi.waitFor(async () => expect((await feed(gateway, "bob", room.path)).at(-1)).toMatchObject({ id: "r_2", text: "The orchard is ready." }));
    await say(gateway, "alice", room.path, "second", "@pilot What goes in the east bed?");
    await vi.waitFor(async () => expect((await feed(gateway, "bob", room.path)).at(-1)).toMatchObject({ id: "r_4", text: "Plant the pears." }));

    for (const [id, text, thinking, toolId] of [
      ["r_2", "The orchard is ready.", "Check whether the orchard is ready.", "orchard-check"],
      ["r_4", "Plant the pears.", "Put pears in the east bed.", "east-check"],
    ]) {
      const path = room.path + "/feed/messages/" + id;
      const response = await gateway.request("bob", path);
      expect(response.status).toBe(200);
      const detail = await response.json();
      expect(detail).toMatchObject({ id, text, reasoning: [thinking], toolCalls: [
        { id: toolId, name: "hold_orchard", status: "done", result: { text: "Orchard checked." } },
      ] });
      expect((await gateway.request("carol", path)).status).toBe(404);
    }
    expect((await gateway.request("bob", room.path + "/feed/messages/r_99")).status).toBe(404);
    expect((await gateway.request("alice", room.path + "/members/" + gateway.accountId("bob"), { method: "DELETE" })).status).toBe(200);
    expect((await gateway.request("bob", room.path + "/feed/messages/r_4")).status).toBe(404);
    expect((await gateway.request("alice", room.path + "/agents/pilot", { method: "DELETE" })).status).toBe(200);
    const historical = await (await gateway.request("alice", room.path + "/feed/messages/r_4")).json();
    expect(historical).toMatchObject({ id: "r_4", text: "Plant the pears.", reasoning: [], toolCalls: [] });
  } finally {
    await gateway.close();
  }
}, 15_000);

it.each([true, false])("lets a member stop a run with kept mention=%s", async (mentioned) => {
  const release = latch();
  const followUp = latch();
  const queued = latch();
  const tool = blockedTool(release);
  const gateway = await startDurableTestGateway({
    multiUser: true, fixture: tool.fixture,
    afterRoomCommit({ lastSeq }) {
      if (lastSeq === 2) queued.resolve();
    },
  });
  try {
    const room = await roomFor(gateway, "alice");
    await post(gateway, "alice", room.path + "/members", { userId: gateway.accountId("bob") });
    await post(gateway, "alice", room.path + "/agents", { agentId: "pilot" });
    const bob = await gateway.socket("bob");
    bob.send({ type: "subscribeRoomFeed", roomId: room.id });
    gateway.script({ tool: "hold_orchard" }, async () => {
      await followUp.promise;
      return "The pears are ready.";
    });
    const getRuns = async (user: User) => {
      const window = await (await gateway.request(user, room.path + "/feed")).json() as import("@yoplai/shared").FeedWindow;
      return window.roomRuns;
    };
    const stopPath = room.path + "/agents/pilot/stop";
    const stop = (user: User, body?: object) => gateway.request(user, stopPath, {
      method: "POST", headers: { "content-type": "application/json" },
      body: body && JSON.stringify(body), signal: AbortSignal.timeout(3000),
    });
    await say(gateway, "bob", room.path, "held", "@pilot Wait for the orchard check.");
    await vi.waitFor(() => expect(tool.executions()).toBe(1));
    const [original] = await vi.waitFor(async () => {
      const runs = await getRuns("bob");
      expect(runs).toEqual([{ agentId: "pilot", messageId: "r_1", runId: expect.any(String) }]);
      return runs!;
    });
    await vi.waitFor(() => expect(bob.events).toContainEqual(expect.objectContaining({ roomRuns: [original] })));
    const outsider = await gateway.socket("carol");
    outsider.send({ type: "subscribeRoomFeed", roomId: room.id });
    const denied = [{ type: "error", message: "Room not found" }];
    await vi.waitFor(() => expect(outsider.events).toEqual(denied));
    expect((await gateway.request("carol", room.path + "/feed")).status).toBe(404);
    expect((await stop("carol", { runId: original!.runId })).status).toBe(404);

    const pending = mentioned ? "@pilot Check the pears." : "The east bed is dry.";
    await say(gateway, "alice", room.path, "kept", pending);
    await queued.promise;
    expect((await stop("bob", { runId: "" })).status).toBe(400);
    const stopped = await stop("bob", { runId: original!.runId });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ status: "stopped" });
    expect(tool.aborts()).toBe(1);

    const bobId = gateway.accountId("bob");
    expect((await gateway.request("alice", room.path + "/members/" + bobId, { method: "DELETE" })).status).toBe(200);
    await vi.waitFor(() => expect(bob.events.at(-1)).toEqual({ type: "feed_end", roomId: room.id, reason: "forbidden" }));
    const lastBobFrame = bob.events.length;
    expect((await stop("bob")).status).toBe(404);
    expect((await gateway.request("bob", room.path + "/feed")).status).toBe(404);
    if (!mentioned) {
      await vi.waitFor(async () => expect(await getRuns("alice")).toEqual([]));
      expect(await (await stop("alice")).json()).toEqual({ status: "already_finished" });
      expect(gateway.callCount()).toBe(1);
      await say(gateway, "alice", room.path, "new", "@pilot Check the pears.");
    }
    await vi.waitFor(() => expect(gateway.callCount()).toBe(2));
    await vi.waitFor(async () => expect(await getRuns("alice")).toEqual([
      { agentId: "pilot", messageId: mentioned ? "r_2" : "r_3", runId: expect.any(String) },
    ]));
    expect((await getRuns("alice"))?.[0]?.runId).not.toBe(original!.runId);
    expect(await (await stop("alice", { runId: original!.runId })).json()).toEqual({ status: "already_finished" });
    expect(modelInputs(gateway, 1)?.slice(1)).toEqual([
      "[from alice via web]\n" + pending,
      ...(!mentioned ? ["[from alice via web]\n@pilot Check the pears."] : []),
    ]);
    followUp.resolve();
    await vi.waitFor(async () => expect((await feed(gateway, "alice", room.path)).filter(({ role }) => role === "assistant"))
      .toEqual([expect.objectContaining({ text: "The pears are ready." })]));
    await vi.waitFor(async () => expect(await getRuns("alice")).toEqual([]));
    expect(await (await stop("alice")).json()).toEqual({ status: "already_finished" });
    await bob.flush();
    expect(bob.events).toHaveLength(lastBobFrame);
    await outsider.flush();
    expect(outsider.events).toEqual(denied);
    expect((await gateway.request("alice", room.path + "/agents/pilot", { method: "DELETE" })).status).toBe(200);
    expect((await stop("alice")).status).toBe(404);
  } finally {
    release.resolve();
    followUp.resolve();
    await gateway.close();
  }
}, 15_000);

it("keeps a plan and keeper topics in the agent's room across restart", async () => {
  const onBatch = vi.fn();
  const gateway = await startDurableTestGateway({
    multiUser: true, keeper: { idleMs: 60_000, turns: 1, onBatch },
    additionalAgents: [{ id: "scout", model: { provider: "faux", model: "fixture" } }],
  });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  const complete = vi.spyOn(MaintenanceCompletion, "complete").mockImplementation(async ({ agentId, prompt }) => {
    const { messages } = JSON.parse(prompt);
    const seed = messages.find(({ text }: { text: string }) => text.includes("@pilot Plan the orchard."));
    return seed && agentId === "pilot" ? JSON.stringify({ topics: [
      { kind: "decision", title: "Pear harvest", note: "Use the east bed.", refs: [seed.id] },
    ] }) : '{"topics":[]}';
  });
  try {
    const room = await roomFor(gateway, "alice");
    const separate = await roomFor(gateway, "alice");
    await post(gateway, "alice", room.path + "/members", { userId: gateway.accountId("bob") });
    await post(gateway, "alice", room.path + "/agents", { agentId: "pilot" });
    await post(gateway, "alice", room.path + "/agents", { agentId: "scout" });
    await post(gateway, "alice", separate.path + "/agents", { agentId: "pilot" });
    const readMain = async (user: User) => {
      const response = await gateway.request(user, "/api/agents/pilot/memory");
      expect(response.status).toBe(200);
      return response.json();
    };
    gateway.script(
      { tool: "plan_update", args: { goals: ["Order a private parcel."], nextSteps: [] } },
      "Private plan saved.",
    );
    expect((await gateway.send("alice", "Save my private plan.", { clientSendId: "private-plan" })).status).toBe(200);
    await vi.waitFor(() => expect(onBatch.mock.calls).toEqual([["committed"]]));
    const alicesMain = await readMain("alice");
    const bobsMain = await readMain("bob");
    expect(alicesMain).toMatchObject({ plan: { goals: ["Order a private parcel."] } });
    const beforeRoomCall = gateway.callCount();
    gateway.script(
      { tool: "plan_get", id: "before-room-plan" },
      { tool: "plan_update", args: { goals: ["Harvest pears."], nextSteps: ["Find a basket."] } },
      "Start in the east bed.",
    );
    await say(gateway, "bob", room.path, "plan", "@pilot Plan the orchard.");
    await vi.waitFor(() => expect(gateway.offeredTools(beforeRoomCall)).toContain("plan_update"));
    await vi.waitFor(async () => expect((await feed(gateway, "bob", room.path)).at(-1)).toMatchObject({ text: "Start in the east bed." }));
    const result = (id: string) => {
      const message = gateway.requests.at(-1)?.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
      const block = message?.role === "toolResult" ? message.content[0] : undefined;
      if (block?.type !== "text") throw new Error("Missing memory result for " + id);
      return JSON.parse(block.text);
    };
    expect(result("before-room-plan")).toMatchObject({ plan: { goals: [], nextSteps: [] } });
    await vi.waitFor(() => expect(complete.mock.calls.some(([{ prompt }]) =>
      prompt.includes("[from bob via web]") && prompt.includes("Start in the east bed."))).toBe(true));
    await vi.waitFor(() => expect(onBatch.mock.calls).toEqual([["committed"], ["committed"]]));
    await gateway.restart();

    const readRoom = async (path: string, agent: string, key: string) => {
      gateway.script(
        [{ tool: "plan_get", id: key + "-plan" }, { tool: "topics_get", id: key + "-topics" }],
        "Memory checked for " + key + ".",
      );
      await say(gateway, "alice", path, key, "@" + agent + " Check the plan and topics.");
      await vi.waitFor(async () => expect((await feed(gateway, "alice", path)).at(-1)).toMatchObject({ text: "Memory checked for " + key + "." }));
      return { ...result(key + "-plan"), ...result(key + "-topics") };
    };
    expect(await readRoom(room.path, "pilot", "orchard")).toMatchObject({
      plan: { goals: ["Harvest pears."], nextSteps: ["Find a basket."] },
      topics: [{ kind: "decision", title: "Pear harvest", note: "Use the east bed.", refs: [] }],
    });
    const empty = { plan: { goals: [], nextSteps: [] }, topics: [] };
    expect(await readRoom(room.path, "scout", "other-agent")).toMatchObject(empty);
    expect(await readRoom(separate.path, "pilot", "other-room")).toMatchObject(empty);
    expect(await readMain("alice")).toEqual(alicesMain);
    expect(await readMain("bob")).toEqual(bobsMain);
  } finally {
    await gateway.close();
    complete.mockRestore();
  }
}, 20_000);
