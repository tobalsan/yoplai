import { expect, it, vi } from "vitest";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";

const route = "/api/me/durable-mode";
const put = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

it("defaults off and saves the single-user setting across gateway restarts", async () => {
  const gateway = await startDurableTestGateway({ enableDurableMode: false });
  try {
    const initial = await gateway.request("local", route);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ enabled: false });
    const invalid = await gateway.request("local", route, put({ enabled: "true" }));
    expect(invalid.status).toBe(400);
    for (const updatedAt of ["yesterday", null, 42]) {
      expect((await gateway.request("local", route, put({ enabled: true, updatedAt }))).status).toBe(400);
    }
    const saved = await gateway.request("local", route, put({ enabled: true }));
    expect(saved.status).toBe(200);
    const state = await saved.json() as { enabled: boolean; updatedAt: string };
    expect(state).toEqual({ enabled: true, updatedAt: expect.any(String) });
    expect(Number.isFinite(Date.parse(state.updatedAt))).toBe(true);
    await gateway.restart();
    expect(await (await gateway.request("local", route)).json()).toEqual(state);
  } finally {
    await gateway.close();
  }
});

it("routes new sends with the current setting and keeps the earlier Durable Main history", async () => {
  const gateway = await startDurableTestGateway({ enableDurableMode: false, legacyAnswer: "Watered on the old runner." });
  try {
    const detail = async () => (await gateway.request("local", "/api/agents/pilot")).json();
    const send = async (clientSendId: string, message: string) => {
      const response = await gateway.send("local", message, { clientSendId });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      return result;
    };
    expect(await detail()).not.toHaveProperty("durable");
    const before = await send("before-mode", "Water the basil");
    expect(before.payloads).toEqual([{ text: "Watered on the old runner." }]);
    expect(before.meta.sessionId).not.toBe("durable-main");

    expect((await gateway.request("local", route, put({ enabled: true }))).status).toBe(200);
    expect(await detail()).toHaveProperty("durable", true);
    expect(await send("with-mode", "Check the seedlings")).toMatchObject({
      payloads: [{ text: "The seedlings are ready." }],
      meta: { sessionId: "durable-main" },
    });

    expect((await gateway.request("local", route, put({ enabled: false }))).status).toBe(200);
    expect(await detail()).not.toHaveProperty("durable");
    const after = await send("after-mode", "Water the mint");
    expect(after.payloads).toEqual([{ text: "Watered on the old runner." }]);
    expect(after.meta.sessionId).not.toBe("durable-main");

    expect((await gateway.request("local", route, put({ enabled: true }))).status).toBe(200);
    expect(await gateway.history("local")).toMatchObject({
      sessionId: "durable-main",
      messages: [
        { role: "user", content: "Check the seedlings" },
        { role: "assistant", content: "The seedlings are ready." },
      ],
    });
  } finally {
    await gateway.close();
  }
});

it("keeps each account's setting, HTTP and WebSocket replies, and feed separate on the same agent", async () => {
  const gateway = await startDurableTestGateway({ multiUser: true, enableDurableMode: false, legacyAnswer: "Watered on the old runner.", recheckMs: 50 });
  try {
    expect((await gateway.request("local", route)).status).toBe(401);
    expect((await gateway.request("local", route, put({ enabled: true }))).status).toBe(401);
    expect(await (await gateway.request("alice", route)).json()).toEqual({ enabled: false });
    const saved = await gateway.request("alice", route, put({ enabled: true, userId: gateway.accountId("bob") }));
    expect(saved.status).toBe(200);
    expect(await (await gateway.request("alice", route)).json()).toEqual({ enabled: true, updatedAt: expect.any(String) });
    expect(await (await gateway.request("bob", route)).json()).toEqual({ enabled: false });
    expect(await (await gateway.request("alice", "/api/agents/pilot")).json()).toHaveProperty("durable", true);
    expect(await (await gateway.request("bob", "/api/agents/pilot")).json()).not.toHaveProperty("durable");
    expect(await (await gateway.request("alice", "/api/agents")).json()).toContainEqual(
      expect.objectContaining({ id: "pilot", durable: true }),
    );
    const bobAgents = await (await gateway.request("bob", "/api/agents")).json();
    expect(bobAgents.find((agent: { id: string }) => agent.id === "pilot")).not.toHaveProperty("durable");

    gateway.script("The basil is ready.", "The mint is ready.");
    const alice = await gateway.send("alice", "Check the basil", { clientSendId: "basil-http" });
    expect(alice.status).toBe(200);
    expect(await alice.json()).toMatchObject({ payloads: [{ text: "The basil is ready." }], meta: { sessionId: "durable-main" } });
    const bob = await gateway.send("bob", "Water the basil", { clientSendId: "basil-http" });
    expect(bob.status).toBe(200);
    const legacy = await bob.json();
    expect(legacy.payloads).toEqual([{ text: "Watered on the old runner." }]);
    expect(legacy.meta.sessionId).not.toBe("durable-main");

    const observer = await gateway.subscribe("alice");
    const aliceSocket = await gateway.send("alice", "Check the mint", { clientSendId: "mint-ws" }, "ws");
    const bobSocket = await gateway.send("bob", "Water the mint", { clientSendId: "mint-ws" }, "ws");
    await vi.waitFor(() => {
      expect(aliceSocket.events).toContainEqual(expect.objectContaining({ type: "done", meta: expect.objectContaining({ sessionId: "durable-main" }) }));
      expect(bobSocket.events).toContainEqual(expect.objectContaining({ type: "done" }));
      expect(bobSocket.events).not.toContainEqual(expect.objectContaining({ type: "done", meta: expect.objectContaining({ sessionId: "durable-main" }) }));
      expect(observer.events).toContainEqual({ type: "history_updated", agentId: "pilot", sessionId: "durable-main" });
    });
    const text = (socket: typeof aliceSocket) => socket.events.flatMap((event) => event.type === "text" ? [event.data] : []).join("");
    expect(text(aliceSocket)).toBe("The mint is ready.");
    expect(text(bobSocket)).toBe("Watered on the old runner.");

    const feedPath = "/api/agents/pilot/feed";
    expect((await gateway.request("alice", feedPath)).status).toBe(200);
    expect((await gateway.request("bob", feedPath)).status).toBe(404);
    const feed = await gateway.socket("alice");
    feed.send({ type: "subscribeFeed", agentId: "pilot" });
    await vi.waitFor(() => expect(feed.events).toContainEqual(expect.objectContaining({ type: "feed_snapshot", agentId: "pilot" })));
    expect((await gateway.request("alice", route, put({ enabled: false }))).status).toBe(200);
    expect((await gateway.request("alice", feedPath + "/search?q=mint")).status).toBe(404);
    expect((await gateway.request("alice", feedPath + "/messages/m_example")).status).toBe(404);
    await vi.waitFor(() => expect(feed.events).toContainEqual({ type: "feed_end", agentId: "pilot", reason: "forbidden" }));
  } finally {
    await gateway.close();
  }
});

it("loads an agent with the deprecated durable key, warns once across reloads, and answers on legacy by default", async () => {
  const warn = vi.spyOn(console, "warn");
  const gateway = await startDurableTestGateway({ extraYaml: "durable: true", enableDurableMode: false, legacyAnswer: "Watered on the old runner." });
  try {
    const detail = await gateway.request("local", "/api/agents/pilot");
    expect(detail.status).toBe(200);
    expect(await detail.json()).not.toHaveProperty("durable");
    await gateway.configure("fixture");
    await gateway.configure("fixture");
    const notice = '[config] agent "pilot": `durable` is ignored; Durable mode is now a per-user setting';
    expect(warn.mock.calls.filter(([message]) => message === notice)).toEqual([[notice]]);
    const response = await gateway.send("local", "Water the basil", { clientSendId: "migrated-config" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ payloads: [{ text: "Watered on the old runner." }] });
  } finally {
    warn.mockRestore();
    await gateway.close();
  }
});

it("uses the legacy sandbox runner when Durable mode is enabled", async () => {
  const gateway = await startDurableTestGateway();
  const container = await import("../sdk/container/adapter.js");
  const adapter = vi.spyOn(container, "getContainerAdapter").mockReturnValue({
    ...container.getContainerAdapter(),
    async run(params) {
      const text = "Watered in the sandbox.";
      params.onHistoryEvent({ type: "assistant_text", text, timestamp: Date.now() });
      return { text, aborted: false };
    },
  });
  try {
    await gateway.configure("fixture", "sandbox: { enabled: true }");
    const detail = await gateway.request("local", "/api/agents/pilot");
    expect(detail.status).toBe(200);
    expect(await detail.json()).not.toHaveProperty("durable");
    const response = await gateway.send("local", "Water the basil", { clientSendId: "sandbox-send" });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result.payloads).toEqual([{ text: "Watered in the sandbox." }]);
    expect(result.meta.sessionId).not.toBe("durable-main");
  } finally {
    adapter.mockRestore();
    await gateway.close();
  }
});

it("reopens Main for an opted-in account with an opted-out account's turn pending", async () => {
  const review = vi.fn(async (_draft: string) => ({ ok: true }) as const)
    .mockImplementationOnce(() => new Promise(() => {}));
  const gateway = await startDurableTestGateway({ multiUser: true, reviewer: { begin() {}, end() {}, review } });
  try {
    gateway.script("Bob's seedlings are ready.", "The basil is ready.", "The basil is ready.");
    await gateway.send("bob", "Check the seedlings", { clientSendId: "bob-pending" }, "ws");
    await vi.waitFor(() => expect(review).toHaveBeenCalledWith("Bob's seedlings are ready."));
    await gateway.setDurableMode("bob", false);
    await gateway.restart();

    const response = await gateway.send("alice", "Check the basil", { clientSendId: "alice-after-restart" });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({
      payloads: [{ text: "The basil is ready." }],
      meta: { sessionId: "durable-main" },
    });
  } finally {
    await gateway.close();
  }
});
