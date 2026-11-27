import { parseDeviceLinkMessage, type DeviceCall, type ExtensionContext } from "@yoplai/shared";
import { expect, it, vi } from "vitest";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";

it("carries the WebSocket token only to device calls in the live Main turn", async () => {
  let extensionContext!: ExtensionContext;
  const gateway = await startDurableTestGateway({
    extraYaml: "toolDeferral: { enabled: false }",
    async fixtureExtensions() {
      return [(await import("../relay/device-extension.js")).deviceToolsExtension];
    },
    startChannels(context) { extensionContext = context; },
  });
  try {
    const device = await gateway.connectDevice("local");
    const calls: DeviceCall[] = [];
    device.on("message", (raw) => {
      const call = parseDeviceLinkMessage(raw.toString());
      if (call?.type === "call") calls.push(call);
    });
    const reply = (index: number) => device.send(JSON.stringify({
      type: "result", callId: calls[index].callId, ok: true, content: [{ type: "text", text: "orchard" }],
    }));
    const token = "fixture-main-device-turn";
    const bash = { tool: "device_bash", args: { command: "pwd" } };
    gateway.script(bash, "Scheduler checked.", "Orchard checked.", bash, "Next check finished.");
    const sender = await gateway.send("local", "Check the device folder", { clientSendId: "device-check", deviceTurnToken: token }, "ws");
    await vi.waitFor(() => expect(calls[0]?.tool).toBe("device_bash"));
    expect(calls[0]?.turnToken === token, "the device call carries the WebSocket token").toBe(true);

    const tick = await extensionContext.runJobTick!({
      agentId: "pilot", owner: "local", jobId: "orchard", jobName: "Orchard inventory",
      tickTime: 1_790_000_000_000, prompt: "Count the pear crates.", signal: new AbortController().signal,
    });
    expect(tick).toMatchObject({ status: "done", result: { payloads: [{ text: "Scheduler checked." }] } });
    expect(gateway.offeredTools(1).filter((name) => name.startsWith("device_"))).toEqual([]);
    reply(0);
    await vi.waitFor(() => expect(sender.events.some(({ type }) => type === "done")).toBe(true));

    const next = gateway.send("local", "Check the folder again", {
      clientSendId: "http-device-check", deviceTurnToken: "fixture-http-device-turn",
    });
    await vi.waitFor(() => expect(calls[1]?.tool).toBe("device_bash"));
    expect(calls[1]?.turnToken === undefined, "the device call has no turn token after Main settles").toBe(true);
    reply(1);
    expect((await next).status).toBe(200);

    const checkFeed = async () => {
      const feed = await gateway.request("local", "/api/agents/pilot/feed");
      const text = await feed.text();
      expect(feed.status).toBe(200);
      expect(text).toContain("Check the device folder");
      expect(text.includes(token), "the feed omits the turn token").toBe(false);
    };
    await checkFeed();
    await gateway.restart();
    await checkFeed();
  } finally {
    await gateway.close();
  }
});
