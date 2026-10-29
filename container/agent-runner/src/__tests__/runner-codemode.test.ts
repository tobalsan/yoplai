import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ContainerInput, ContainerRunnerProtocolEvent } from "@yoplai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortActiveAgent, runAgent } from "../runner.js";

// Approved seams: Thinh's ALG-506 comment 8fcf9742-a30b-45b2-bd18-5fb24d1cecda.
// runAgent/abortActiveAgent + real Pi/faux + loopback gateway bridge catch real
// script execution, context isolation, nested events and cancellation/recovery;
// they miss browser rendering and persistence owned by the gateway.
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  abortActiveAgent();
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Runner did not settle within 5 seconds")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function script(code: string, id = "codemode-parent") {
  return fauxAssistantMessage(fauxToolCall("codemode", { code }, { id }), {
    stopReason: "toolUse",
  });
}

async function fixture(bridge?: (response: http.ServerResponse) => Promise<unknown>) {
  const tempDir = await fs.mkdtemp(path.join(process.cwd(), ".runner-codemode-"));
  cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));
  const workspaceDir = path.join(tempDir, "workspace");
  await fs.mkdir(workspaceDir);
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body) as Record<string, unknown>);
    response.setHeader("content-type", "application/json");
    if (request.method !== "POST" || request.url !== "/internal/tools") {
      response.writeHead(404).end();
      return;
    }
    try {
      const result = bridge ? await bridge(response) : { count: 7, sentinel: "ALG506_CHILD_RAW_SENTINEL" };
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No bridge port");
  const faux = fauxProvider();
  const createRuntime = ModelRuntime.create.bind(ModelRuntime);
  vi.spyOn(ModelRuntime, "create").mockImplementation(async (options) => {
    const runtime = await createRuntime({ ...options, modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    return runtime;
  });
  const input: ContainerInput = {
    agentId: "codemode-agent",
    sessionId: "codemode-session",
    message: "run the script",
    workspaceDir,
    sessionDir: path.join(tempDir, "sessions"),
    ipcDir: path.join(tempDir, "ipc"),
    gatewayUrl: `http://127.0.0.1:${address.port}`,
    agentToken: "fixture-token",
    codemode: true,
    retry: { maxAttempts: 1, baseDelaySeconds: 0 },
    extensionTools: [{
      extensionId: "fixture",
      name: "fixture_count",
      description: "Return the fixture count",
      parameters: { type: "object", properties: {} },
    }],
    sdkConfig: { sdk: "pi", model: { provider: "faux", model: "faux-1" } },
  };
  const events: ContainerRunnerProtocolEvent[] = [];
  const run = (overrides: Partial<ContainerInput> = {}) => bounded(runAgent({ ...input, ...overrides }, (event) => events.push(event)));
  const respond = (responses: FauxResponseStep[]) => faux.setResponses(responses);
  return { input, run, respond, events, requests };
}

describe("Container Pi codemode", () => {
  // ALG-566 Testing Decisions approves this seam: real scripts and gateway
  // requests catch admission/queue/cancel behavior, not Docker shutdown or UI.
  it("stops admitting calls at the configured cap and tells the script to split the work", async () => {
    const { run, respond, requests, events } = await fixture();
    respond([
      script('for (let i = 0; i < 5; i++) { try { await tools.fixture_count({}); } catch (error) { text(error.message); } }'),
      fauxAssistantMessage("done"),
    ]);
    await expect(run({ codemodeLimits: { maxToolCalls: 3 } })).resolves.toMatchObject({ text: "done" });
    expect(requests).toHaveLength(3);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result", id: "codemode-parent",
      content: expect.stringContaining("3 tool calls in one script"),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result", id: "codemode-parent",
      content: expect.stringContaining("Split the work into more codemode calls"),
    }));
  });

  it.each([false, true])("aborts on the first run-cancelled reply despite empty catches, including queued work (%s), and permits a later run", async (parallel) => {
    let calls = 0;
    const { run, respond, requests, events } = await fixture(async (response) => {
      calls += 1;
      if (calls === 2) {
        response.statusCode = 409;
        return { error: "run cancelled" };
      }
      return { count: 7 };
    });
    respond([script(parallel
      ? 'await Promise.all(Array.from({ length: 20 }, () => tools.fixture_count({}).catch(() => {}))); text("should not finish");'
      : 'for (let i = 0; i < 20; i++) { await tools.fixture_count({}).catch(() => {}); } text("should not finish");'), fauxAssistantMessage("should not continue")]);
    await expect(run({ codemodeLimits: { maxConcurrentToolCalls: 1 } })).resolves.toMatchObject({ aborted: true });
    expect(requests).toHaveLength(2);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "tool_result", id: "codemode-parent", content: expect.stringContaining("should not finish") }));
    respond([script('text(JSON.parse(await tools.fixture_count({})).count);', "after-cancel"), fauxAssistantMessage("recovered")]);
    await expect(run({ sessionId: "after-cancel-session" })).resolves.toMatchObject({ text: "recovered", aborted: false });
    expect(requests).toHaveLength(3);
  });

  it("queues parallel gateway calls above the concurrency cap and completes every call", async () => {
    let inFlight = 0;
    let peak = 0;
    let finished = 0;
    const { run, respond, requests, events } = await fixture(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      finished += 1;
      return { count: 7 };
    });
    respond([
      script('const results = await Promise.all(Array.from({ length: 6 }, () => tools.fixture_count({}))); text(`finished=${results.length}`);'),
      fauxAssistantMessage("done"),
    ]);
    await expect(run({ codemodeLimits: { maxConcurrentToolCalls: 2 } })).resolves.toMatchObject({ text: "done" });
    expect(peak).toBe(2);
    expect(finished).toBe(6);
    expect(requests).toHaveLength(6);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result", id: "codemode-parent", isError: false,
      content: expect.stringContaining("finished=6"),
    }));
  });

  it("releases slots after failed and timed out calls so queued work still progresses", async () => {
    let calls = 0;
    const { run, respond, requests, events } = await fixture(async (response) => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => response.once("close", resolve));
      if (calls === 2) throw new Error("fixture failure");
      return { count: 7 };
    });
    respond([
      script('const results = await Promise.all([tools.fixture_count({ timeout: 0.03 }).catch(() => "timed out"), tools.fixture_count({}).catch(() => "failed"), tools.fixture_count({}).then(result => JSON.parse(result).count)]); text(results.join(","));'),
      fauxAssistantMessage("done"),
    ]);
    await expect(run({ codemodeLimits: { maxConcurrentToolCalls: 1 } })).resolves.toMatchObject({ text: "done" });
    expect(requests).toHaveLength(3);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result", id: "codemode-parent", isError: false,
      content: expect.stringContaining("timed out,failed,7"),
    }));
  });

  it("counts native calls, excludes invalid arguments, and gives each script its own cap", async () => {
    const { input, run, respond, requests, events } = await fixture();
    respond([
      script('try { await tools.fixture_count({}); } catch {} await tools.write({ path: "progress.txt", content: "saved" }); text(await tools.read({ path: "progress.txt" })); try { await tools.fixture_count({ id: 1 }); } catch (error) { text(error.message); }'),
      script('text(await tools.fixture_count({ id: 2 }));', "next-script"),
      fauxAssistantMessage(fauxToolCall("fixture_count", { id: 3 }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await expect(run({
      codemodeLimits: { maxToolCalls: 2 },
      toolDeferral: { enabled: false, alwaysOnTools: [], alwaysOnExtensions: [] },
      extensionTools: [{ ...input.extensionTools![0], parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } }],
    })).resolves.toMatchObject({ text: "done" });
    expect(requests.map((request) => request.args)).toEqual([{ id: 2 }, { id: 3 }]);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "codemode-parent", content: expect.stringContaining("saved") }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "codemode-parent", content: expect.stringContaining("2 tool calls in one script; cap 2") }));
  });

  it.each([true, false])("sends long-job guidance only with codemode enabled, without requiring deferral (%s)", async (codemode) => {
    const { run, respond } = await fixture();
    let request = "";
    respond([(context) => {
      request = JSON.stringify(context.messages);
      return fauxAssistantMessage("done");
    }]);
    await run({ codemode, extensionTools: [], toolDeferral: { enabled: false, alwaysOnTools: [], alwaysOnExtensions: [] }, codemodeLimits: { maxToolCalls: 17, maxConcurrentToolCalls: 2 } });
    for (const rule of [
      "Run one small batch first. Measure the latency, then estimate the full job before you run it.",
      "Split a long job into codemode calls that each fit the timeout. Save progress to a file and resume from it.",
      "Stop the loop on a 409, or after 3 failures in a row. Do not hide errors with an empty `.catch()`.",
      "Before a job that takes more than about 1 minute, tell the user the plan, the call count, and the time.",
      "Per script: at most 17 tool calls and 2 concurrent gateway tool calls.",
    ]) {
      expect(request.includes(rule)).toBe(codemode);
    }
  });

  it("appends the tool signature to the codemode result when a script hides a validation error", async () => {
    const { input, run, respond } = await fixture();
    let nextRequest = "";
    respond([
      script("try { await tools.fixture_count({ id: 1 }); } catch (e) { text(e.message.slice(0, 5)); }"),
      (context: TranscriptContext) => { nextRequest = JSON.stringify(context.messages); return fauxAssistantMessage("hinted"); },
    ]);
    await expect(run({ extensionTools: [{
      ...input.extensionTools![0],
      parameters: { type: "object", properties: { record_id: { type: "number" } }, required: ["record_id"] },
    }] })).resolves.toMatchObject({ text: "hinted" });
    expect(nextRequest).toContain("fixture_count(");
    expect(nextRequest).toContain("record_id");
  });

  // ALG-507 approved seam c404cd21: real runner/Pi/bridge observes script
  // values and declarations; browser rendering and external APIs are separate.
  it("reads nested gateway result fields and their declaration without parsing text", async () => {
    const { input, run, respond, events } = await fixture(async () => ({
      deal: { org_id: 11 },
      sentinel: "ALG507_STRUCTURED_RAW_ONLY",
    }));
    respond([
      script('const result = await tools.fixture_count({}); text(`organization=${result.deal.org_id}`); text(await describeTool("fixture_count"));'),
      fauxAssistantMessage("done"),
    ]);
    await expect(run({ extensionTools: [{
      ...input.extensionTools![0],
      outputSchema: {
        type: "object",
        properties: { deal: { type: "object", properties: { org_id: { type: "number" } } } },
      },
    }] })).resolves.toMatchObject({ text: "done" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      id: "codemode-parent",
      isError: false,
      content: expect.stringContaining("organization=11"),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      id: "codemode-parent",
      content: expect.stringContaining("org_id"),
    }));
  });

  it("keeps returned error data while thrown failures reject and later script work succeeds", async () => {
    let calls = 0;
    const { input, run, respond, events } = await fixture(async () => {
      calls += 1;
      if (calls === 1) return { isError: true, refusal: { reason: "connect_account" } };
      if (calls === 2) throw new Error("fixture connection lost");
      return { deal: { org_id: 11 } };
    });
    respond([
      script('text((await tools.fixture_count({})).refusal.reason); try { await tools.fixture_count({}); } catch (error) { text(error.message); } text(`recovered=${(await tools.fixture_count({})).deal.org_id}`);'),
      fauxAssistantMessage("done"),
    ]);
    await expect(run({ extensionTools: [{
      ...input.extensionTools![0],
      outputSchema: { type: "object", properties: { deal: { type: "object" } } },
    }] })).resolves.toMatchObject({ text: "done" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result", id: "codemode-parent/1", parentToolCallId: "codemode-parent",
      isError: true, content: '{"isError":true,"refusal":{"reason":"connect_account"}}',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result", id: "codemode-parent/2", isError: true,
      content: expect.stringContaining("fixture connection lost"),
    }));
    const scriptResult = events.find((event) => event.type === "tool_result" && event.id === "codemode-parent");
    expect(scriptResult).toMatchObject({ isError: false, content: expect.stringContaining("connect_account") });
    expect(scriptResult).toMatchObject({ content: expect.stringContaining("fixture connection lost") });
    expect(scriptResult).toMatchObject({ content: expect.stringContaining("recovered=11") });
  });

  it("spills a large gateway result and previews 2000 characters while scripts read the full object", async () => {
    const { input, run, respond, events } = await fixture(async () => ({
      deals: [{ id: 101, description: "x".repeat(21_000) }, { id: 202, title: "ALG507_LARGE_TAIL" }],
    }));
    let nextRequest = "";
    respond([
      script('const result = await tools.fixture_count({}); text(`deals=${result.deals.length};last=${result.deals[1].id}`);'),
      (context) => { nextRequest = JSON.stringify(context.messages); return fauxAssistantMessage("done"); },
    ]);
    const output = await run({ extensionTools: [{
      ...input.extensionTools![0],
      outputSchema: { type: "object", properties: { deals: { type: "array", items: { type: "object" } } } },
    }] });
    expect(output.text).toBe("done");
    const child = events.find((event) => event.type === "tool_result" && event.id === "codemode-parent/1");
    if (child?.type !== "tool_result") throw new Error("Missing nested gateway result");
    expect(child.content).toContain("Large tool result saved to ");
    expect(child.content.split("Preview:\n")[1]).toHaveLength(2_000);
    expect(child.content).not.toContain("ALG507_LARGE_TAIL");
    const spillFiles = await fs.readdir(path.join(input.workspaceDir, "data", "tool-results"));
    expect(spillFiles).toHaveLength(1);
    const fullText = await fs.readFile(path.join(input.workspaceDir, "data", "tool-results", spillFiles[0]), "utf8");
    expect(fullText.length).toBeGreaterThan(20_000);
    expect(JSON.parse(fullText)).toMatchObject({ deals: [
      { id: 101, description: expect.stringMatching(/^x{21000}$/) },
      { id: 202, title: "ALG507_LARGE_TAIL" },
    ] });
    expect(nextRequest).toContain("deals=2;last=202");
    expect(nextRequest).not.toContain("ALG507_LARGE_TAIL");
    expect(output.history).toContainEqual(expect.objectContaining({
      type: "tool_result", id: "codemode-parent/1", parentToolCallId: "codemode-parent", content: child.content,
    }));
  });

  it.each([undefined, false, true])("declares codemode only when the flag is true (%s)", async (codemode) => {
    const { run, respond } = await fixture();
    let declared: string[] = [];
    respond([(context) => {
      declared = context.messages.flatMap((message) => message.role === "system"
        ? message.toolsAdded?.map((tool) => tool.name) ?? [] : []);
      return fauxAssistantMessage("done");
    }]);
    await expect(run({ codemode })).resolves.toMatchObject({ text: "done" });
    expect(declared.includes("codemode")).toBe(codemode === true);
  });

  it("runs a gateway tool and sends only selected script output to the next model request", async () => {
    const { run, respond, requests } = await fixture();
    let nextContext: TranscriptContext | undefined;
    respond([
      script('const result = JSON.parse(await tools.fixture_count({})); text(result.count); text(typeof models);'),
      (context) => { nextContext = context; return fauxAssistantMessage("done"); },
    ]);
    await expect(run()).resolves.toMatchObject({ text: "done" });
    expect(requests).toEqual([expect.objectContaining({ tool: "fixture_count", args: {}, agentId: "codemode-agent" })]);
    expect(nextContext).toBeDefined();
    const transcript = JSON.stringify(nextContext?.messages);
    expect(transcript).toContain("Script completed");
    expect(transcript).toContain("7");
    expect(transcript).toContain("undefined");
    expect(transcript).not.toContain("ALG506_CHILD_RAW_SENTINEL");
  });

  it("keeps nested tool parent IDs in streamed and returned history", async () => {
    const { run, respond, events } = await fixture();
    respond([script('await tools.fixture_count({}); text("selected");'), fauxAssistantMessage("done")]);
    const output = await run();
    for (const history of [events, output.history]) {
      expect(history).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "tool_call", id: expect.stringMatching(/^codemode-parent\/\d+$/), parentToolCallId: "codemode-parent", name: "fixture_count" }),
        expect.objectContaining({ type: "tool_result", id: expect.stringMatching(/^codemode-parent\/\d+$/), parentToolCallId: "codemode-parent", name: "fixture_count", content: expect.stringContaining("ALG506_CHILD_RAW_SENTINEL"), isError: false }),
      ]));
    }
  });

  it("reports an uncaught child rejection as a codemode error and permits a later script", async () => {
    let shouldFail = true;
    const { run, respond, events } = await fixture(async () => {
      if (shouldFail) throw new Error("fixture child rejected");
      return { count: 7 };
    });
    respond([script('await tools.fixture_count({});'), fauxAssistantMessage("failure handled")]);
    await expect(run()).resolves.toMatchObject({ text: "failure handled" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result", id: "codemode-parent", name: "codemode", isError: true,
      content: expect.stringContaining("fixture child rejected"),
    }));
    shouldFail = false;
    respond([script('text(JSON.parse(await tools.fixture_count({})).count);', "recovery"), fauxAssistantMessage("recovered")]);
    await expect(run({ sessionId: "recovery-session" })).resolves.toMatchObject({ text: "recovered" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result", id: "recovery", name: "codemode", isError: false,
      content: expect.stringContaining("7"),
    }));
  });

  it("aborts an entered child through abortActiveAgent and permits a later script", async () => {
    let entered = () => {};
    let disconnected = () => {};
    const childEntered = new Promise<void>((resolve) => { entered = resolve; });
    const childDisconnected = new Promise<void>((resolve) => { disconnected = resolve; });
    let shouldBlock = true;
    const { run, respond, events } = await fixture(async (response) => {
      if (shouldBlock) {
        entered();
        await new Promise<void>((resolve) => response.once("close", () => {
          disconnected();
          resolve();
        }));
      }
      return { count: 7 };
    });
    respond([script('await tools.fixture_count({}); text("should not finish");')]);
    const activeRun = run();
    try {
      await bounded(childEntered);
      abortActiveAgent();
      await expect(activeRun).resolves.toMatchObject({ aborted: true });
      await bounded(childDisconnected);
    } finally {
      abortActiveAgent();
    }
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result", id: "codemode-parent", name: "codemode", isError: true,
    }));
    shouldBlock = false;
    respond([script('text(JSON.parse(await tools.fixture_count({})).count);', "after-abort"), fauxAssistantMessage("recovered")]);
    await expect(run({ sessionId: "after-abort-session" })).resolves.toMatchObject({ text: "recovered", aborted: false });
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result", id: "after-abort", name: "codemode", isError: false,
      content: expect.stringContaining("7"),
    }));
  });
});
