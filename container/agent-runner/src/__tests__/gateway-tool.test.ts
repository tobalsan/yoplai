import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContainerInput } from "@yoplai/shared";
import { gatewayTool } from "../gateway-tool.js";

const input = {
  gatewayUrl: "http://gateway:3000",
  agentToken: "test-token",
  agentId: "agent",
  sessionId: "session",
  runId: "run",
} as ContainerInput;

function createTool(turnDeadlineAt?: number) {
  const tool = gatewayTool(
    { ...input, turnDeadlineAt },
    "test.tool",
    "Test",
    "Test tool",
    {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    new Set(),
    async (result) => JSON.stringify(result)
  );
  return {
    ...tool,
    execute: (
      id: string,
      args: Record<string, unknown>,
      signal?: AbortSignal
    ) => tool.execute(id, args, signal, undefined, {} as ExtensionContext),
  };
}

function hangFetch() {
  return vi.spyOn(global, "fetch").mockImplementation(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      })
  );
}

describe("gateway tool deadlines", () => {
  afterEach(() => vi.restoreAllMocks());

  it("extends the schema and strips timeout while forwarding call metadata", async () => {
    const fetch = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(Response.json({ ok: true }));
    const tool = createTool();
    expect(tool.parameters).toMatchObject({
      required: ["value"],
      properties: { timeout: { type: "number" } },
    });
    await tool.execute("call", { value: "hello", timeout: 900 });
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({
      tool: "test.tool",
      args: { value: "hello" },
      agentId: "agent",
      agentToken: "test-token",
      sessionId: "session",
      runId: "run",
      toolCallId: "call",
      timeoutSeconds: 900,
      modelToolName: "test_tool",
    });
  });

  it("accepts very large finite budgets without timer overflow", async () => {
    const fetch = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(Response.json({ ok: true }));
    await createTool().execute("call", { timeout: Number.MAX_VALUE });
    expect(
      JSON.parse(fetch.mock.calls[0][1]?.body as string).timeoutSeconds
    ).toBe(Number.MAX_VALUE);
  });

  it("keeps gateway timeout optional when the extension required it", () => {
    const tool = gatewayTool(
      input,
      "test",
      "Test",
      "Test",
      {
        type: "object",
        properties: { timeout: { type: "string" } },
        required: ["timeout"],
      },
      new Set(),
      async () => "ok"
    );
    expect(tool.parameters).toMatchObject({
      required: [],
      properties: { timeout: { type: "number" } },
    });
  });

  it.each([undefined, 0, -1, Infinity, NaN, "900"])(
    "defaults invalid timeout %s to 300",
    async (timeout) => {
      const fetch = vi
        .spyOn(global, "fetch")
        .mockResolvedValue(Response.json({ ok: true }));
      await createTool().execute("call", { timeout });
      expect(
        JSON.parse(fetch.mock.calls[0][1]?.body as string).timeoutSeconds
      ).toBe(300);
    }
  );

  it("times out a hung fetch and allows another call afterwards", async () => {
    const fetch = hangFetch();
    const tool = createTool();
    await expect(tool.execute("call", { timeout: 0.01 })).rejects.toThrow(
      "tool test_tool timed out after 0.01s"
    );
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    fetch.mockResolvedValue(Response.json({ ok: true }));
    await expect(tool.execute("next", {})).resolves.toMatchObject({
      details: { ok: true },
    });
  });

  it("cancels a hung HTTP request and completes a subsequent gateway call", async () => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        if (JSON.parse(body).toolCallId === "hung") return;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing HTTP port");
    const tool = gatewayTool(
      { ...input, gatewayUrl: `http://127.0.0.1:${address.port}` },
      "test.tool",
      "Test",
      "Test",
      { type: "object", properties: {} },
      new Set(),
      async (result) => JSON.stringify(result)
    );
    try {
      await expect(
        tool.execute(
          "hung",
          { timeout: 0.05 },
          undefined,
          undefined,
          {} as ExtensionContext
        )
      ).rejects.toThrow("tool test_tool timed out after 0.05s");
      await expect(
        tool.execute("next", {}, undefined, undefined, {} as ExtensionContext)
      ).resolves.toMatchObject({ details: { ok: true } });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("trims to turn time remaining and appends the note on success", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const fetch = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(Response.json({ ok: true }));
    const result = await createTool(602000).execute("call", { timeout: 900 });
    expect(
      JSON.parse(fetch.mock.calls[0][1]?.body as string).timeoutSeconds
    ).toBe(600);
    expect(result.content).toContainEqual({
      type: "text",
      text: '{"ok":true}\ntimeout reduced to 600s: turn time limit',
    });
  });

  it("appends the reduction note to timeout errors", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    hangFetch();
    await expect(createTool(2010).execute("call", {})).rejects.toThrow(
      "timeout reduced to 0.01s: turn time limit"
    );
  });

  it("does not call the gateway when the turn has no budget", async () => {
    const fetch = vi.spyOn(global, "fetch");
    await expect(createTool(Date.now()).execute("call", {})).rejects.toThrow(
      "timeout reduced to 0s: turn time limit"
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates SDK cancellation and aborts the fetch", async () => {
    const fetch = hangFetch();
    const controller = new AbortController();
    const error = new DOMException("Cancelled", "AbortError");
    const promise = createTool().execute("call", {}, controller.signal);
    controller.abort(error);
    await expect(promise).rejects.toBe(error);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
