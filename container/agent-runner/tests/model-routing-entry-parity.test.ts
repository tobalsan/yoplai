import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { bounded, createRoutingHarness, type RoutingHarness } from "./model-routing-harness.js";

// ALG-598 Testing Decisions explicitly approves the real WS broker and extension
// context seams. These cover shared dispatch, not Slack/Discord transport or vendors.
let harness: RoutingHarness | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

async function websocketEntry(h: RoutingHarness) {
  const { WsBroker } = await import("../../../apps/gateway/src/server/ws-broker.js");
  const { ExtensionRuntime } = await import("../../../apps/gateway/src/extensions/runtime.js");
  const runtime = new ExtensionRuntime();
  const broker = new WsBroker();
  const server = http.createServer();
  broker.attach(server, {
    isMultiUserEnabled: () => false,
    validateWebSocketRequest: async () => null,
    canAccessAgent: async () => true,
    getExtensionRuntime: () => runtime,
  });
  await bounded(new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing WS fixture port");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  await bounded(new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("WS fixture failed to connect")), { once: true });
  }));
  return {
    async send(message: string) {
      const events: Array<{ type: string; data?: string; message?: string }> = [];
      await bounded(new Promise<void>((resolve, reject) => {
        const receive = (event: MessageEvent) => {
          const data = JSON.parse(String(event.data)) as typeof events[number];
          events.push(data);
          if (data.type === "done" || data.type === "error") {
            ws.removeEventListener("message", receive);
            if (data.type === "error") reject(new Error(data.message ?? "WS run failed"));
            else resolve();
          }
        };
        ws.addEventListener("message", receive);
        ws.send(JSON.stringify({ type: "send", agentId: h.id, sessionId: h.sessionId, message }));
      }));
      await h.waitIdle();
      return events.filter((event) => event.type === "text").map((event) => event.data).join("");
    },
    async close() {
      ws.close();
      broker.close();
      await bounded(new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    },
  };
}

async function greetingThenWork(h: RoutingHarness, send: (message: string) => Promise<string>) {
  h.classifier.predicate = false;
  expect(await send("hi")).toBe("answer:usual");
  expect(await h.lock()).toBeUndefined();
  expect(await h.attempts(1)).toMatchObject([{ predicate: { result: "no" } }]);
  h.classifier.predicate = true;
  const eventsBeforeWork = h.historyEvents.length;
  expect(await send("Build a report")).toBe("answer:chatgpt");
  expect(await h.lock()).toEqual({
    version: 1, kind: "routed", mode: "enforce", provider: "route-chatgpt", model: "chatgpt", effort: "high",
    category: "work", score: 0.9, tableVersion: "e2e-v1", pool: "chatgpt", reason: "preference", decidedAt: expect.any(String),
  });
  const replayedUserText = h.modelCalls[1]?.messages.filter((message) => message.role === "user")
    .flatMap((message) => typeof message.content === "string" ? [message.content]
      : message.content.flatMap((part) => part.type === "text" ? [part.text] : []));
  expect(replayedUserText).toContain("hi");
  expect(h.historyEvents[eventsBeforeWork]?.trace?.metadata)
    .toMatchObject({ routingState: "locked-routed", routingProposed: "route-chatgpt/chatgpt" });
  await h.attempts(2);
  expect(await send("continue")).toBe("answer:chatgpt");
  expect(h.modelCalls.map((call) => call.model)).toEqual(["usual", "chatgpt", "chatgpt"]);
  expect(h.adapterCalls.map((call) => call.thinkLevel)).toEqual(["low", "high", "high"]);
  expect(h.classifier.calls.map((call) => call.question)).toEqual(["work_request", "work_request", "category", "category"]);
  expect(await h.attempts(2)).toHaveLength(2);
}

describe("host routing entry parity", () => {
  it("routes greeting then work once through the WebSocket broker", async () => {
    harness = await createRoutingHarness("host");
    const h = harness;
    h.sessionId = `${h.id}-websocket`;
    const entry = await websocketEntry(h);
    try {
      await bounded(greetingThenWork(h, entry.send));
    } finally { await entry.close(); }
  }, 10_000);

  for (const source of ["slack", "discord"] as const) {
    it(`routes greeting then work once through the ${source} extension context`, async () => {
      harness = await createRoutingHarness("host");
      const h = harness;
      h.sessionId = `${h.id}-${source}`;
      const { createExtensionContext } = await import("../../../apps/gateway/src/extensions/context.js");
      const { loadConfig } = await import("../../../apps/gateway/src/config/index.js");
      const context = createExtensionContext(loadConfig());
      await bounded(greetingThenWork(h, async (message) => {
        const result = await context.runAgent({ agentId: h.id, sessionId: h.sessionId, message, source });
        return result.payloads.map((payload) => payload.text ?? "").join("");
      }));
    }, 10_000);
  }
});
