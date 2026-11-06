import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ContainerInput, ContainerRunnerProtocolEvent } from "@yoplai/shared";
import { EVENT_PREFIX, runAgentRunner } from "../index.js";

// ALG-614 seam 3 explicitly approved by Thinh in fa28457a-d6a4-4709-97cd-91ff575553b9.
// Real runner JSON input/output and Pi tool execution; only external model/gateway are controlled.
afterEach(() => { vi.restoreAllMocks(); });

it("forwards valid optional titles and tool-call ids but rejects titles over 200 characters", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-files-"));
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"registered":true}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback listener");
  const faux = fauxProvider({ provider: "alg614-files" });
  const createRuntime = ModelRuntime.create.bind(ModelRuntime);
  vi.spyOn(ModelRuntime, "create").mockImplementation(async options => {
    const runtime = await createRuntime({ ...options, modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    return runtime;
  });
  const modelResults: unknown[] = [];
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("send_file", { path: "/workspace/files/report.html", title: "x".repeat(201) }, { id: "too-long" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("send_file", { path: "/workspace/files/report.html", title: "x".repeat(200) }, { id: "valid-title" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("send_file", { path: "/workspace/files/notes.md" }, { id: "no-title" }), { stopReason: "toolUse" }),
    context => {
      modelResults.push(...context.messages.filter(message => message.role === "toolResult"));
      return fauxAssistantMessage("Files ready");
    },
  ]);
  const input: ContainerInput = {
    agentId: "files", sessionId: "files-session", runId: "files-run", message: "Send reports",
    workspaceDir: path.join(home, "workspace"), sessionDir: path.join(home, "sessions"), ipcDir: path.join(home, "ipc"),
    gatewayUrl: `http://127.0.0.1:${address.port}`, agentToken: "fixture-token",
    sdkConfig: { sdk: "pi", model: { provider: "alg614-files", model: faux.getModel().id } },
    toolDeferral: { enabled: false, alwaysOnTools: [], alwaysOnExtensions: [] }, retry: { maxAttempts: 1, baseDelaySeconds: 0.01 },
  };
  await fs.mkdir(input.workspaceDir, { recursive: true });
  const output: string[] = [];
  try {
    await runAgentRunner({ readStdin: async () => JSON.stringify(input), writeStdout: chunk => { output.push(chunk); } });
    const events = output.join("").split("\n").filter(line => line.startsWith(EVENT_PREFIX))
      .map(line => JSON.parse(line.slice(EVENT_PREFIX.length)) as ContainerRunnerProtocolEvent);
    expect(requests).toHaveLength(2);
    expect(requests).toContainEqual(expect.objectContaining({ tool: "__register_file_output", toolCallId: "valid-title", args: { path: "/workspace/files/report.html", title: "x".repeat(200) } }));
    expect(requests).toContainEqual(expect.objectContaining({ tool: "__register_file_output", toolCallId: "no-title", args: { path: "/workspace/files/notes.md" } }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "too-long", isError: true }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "valid-title", isError: false, content: "File sent to user" }));
    expect(modelResults).toContainEqual(expect.objectContaining({ toolCallId: "valid-title", content: [{ type: "text", text: "File sent to user" }] }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call", id: "valid-title", name: "send_file" }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(home, { recursive: true, force: true });
  }
});
