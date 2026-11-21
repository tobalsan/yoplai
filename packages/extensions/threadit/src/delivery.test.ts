import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, DeliverySink, ExtensionContext } from "@yoplai/shared";
import { threaditExtension } from "./index.js";

const agent = {
  id: "interviewer",
  name: "Interviewer",
  workspace: "/tmp/interviewer",
  model: { provider: "test", model: "test" },
  queueMode: "queue",
  extensions: { threadit: { token: "invented-agent-token" } },
} as AgentConfig;

async function start() {
  const sinks = new Map<string, DeliverySink>();
  const ctx = {
    getConfig: () => ({ extensions: { threadit: { baseUrl: "https://board.example.test" } } }),
    getAgents: () => [],
    getAgent: () => agent,
    isAgentActive: () => true,
    registerDeliverySink: (id: string, sink: DeliverySink) => {
      sinks.set(id, sink);
      return () => sinks.delete(id);
    },
  } as unknown as ExtensionContext;
  await threaditExtension.start(ctx);
  return sinks;
}

describe("Threadit reply delivery", () => {
  afterEach(async () => {
    await threaditExtension.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("delivers through the registered sink as the agent into the original thread and parent", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Response.json({ id: 42 });
    });
    const sinks = await start();
    const sink = sinks.get("threadit");
    expect(sink).toBeTypeOf("function");
    await sink!({ agent, destination: { channel: "12:34" }, text: "Interview answers received" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://board.example.test/api/threads/12/messages");
    expect(requests[0]?.init?.headers).toMatchObject({ Authorization: "Bearer invented-agent-token" });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      body: "Interview answers received",
      parent_id: 34,
    });
    await threaditExtension.stop();
    expect(sinks.get("threadit")).toBeUndefined();
  });

  it("posts a top-level message when the destination names only a thread", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 43 });
    });
    const sinks = await start();
    await sinks.get("threadit")!({ agent, destination: { channel: "12" }, text: "Answers are ready" });
    expect(bodies).toEqual([{ body: "Answers are ready", parent_id: null }]);
  });

  it.each([
    [409, "thread_closed", "thread closed"],
    [401, "unauthorized", "http 401 unauthorized"],
    [503, "private-server-detail", "http 503 other"],
  ] as const)("throws a safe error for an unsuccessful board reply (%s)", async (status, code, failure) => {
    vi.stubGlobal("fetch", async () => Response.json({ error: { code } }, { status }));
    const sinks = await start();
    await expect(sinks.get("threadit")!({ agent, destination: { channel: "12:34" }, text: "Answers" }))
      .rejects.toThrow(`Threadit delivery failed: ${failure}`);
  });

  it("times out a hanging board request and still delivers a later reply", async () => {
    // Keep Node's real abort signal with a shorter deadline for the first request.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementationOnce(() => timeout(5));
    let hang = true;
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => hang
      ? new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("network timeout")), { once: true }))
      : Promise.resolve(Response.json({ id: 44 })));
    const sinks = await start();
    const first = expect(sinks.get("threadit")!({ agent, destination: { channel: "12:34" }, text: "Answers" }))
      .rejects.toThrow("Threadit delivery failed: network error");
    await first;
    hang = false;
    await expect(sinks.get("threadit")!({ agent, destination: { channel: "12:34" }, text: "Later reply" })).resolves.toBeUndefined();
  });
});
