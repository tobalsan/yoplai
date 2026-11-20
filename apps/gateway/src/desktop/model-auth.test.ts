import { stubDesktopTestEnv } from "../test-utils/desktop-test-env.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let home: string;
let root: string;
beforeEach(async () => {
  vi.resetModules();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-model-auth-"));
  home = path.join(root, "yoplai");
  await fs.mkdir(home);
  stubDesktopTestEnv(root, home);
  const { configureRelay } = await import("../relay/state.js");
  configureRelay("127.0.0.1", false);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it("prefers an owned key and keeps the environment path", async () => {
  const { createModelAuth } = await import("./model-auth.js");
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fake-owned" } }));
  vi.stubEnv("OPENAI_API_KEY", "fake-env");
  const readExternal = vi.fn(async () => ({ type: "api_key" as const, key: "fake-external", source: "test" }));
  const { resolveModelAuth } = await createModelAuth({ readExternal });
  expect((await resolveModelAuth("openai"))?.auth.apiKey === "fake-owned").toBe(true);
  expect(readExternal).not.toHaveBeenCalled();
  const env = await createModelAuth({ primaryProvider: "openai", mode: "api_key" });
  await fs.unlink(path.join(home, "auth.json"));
  expect((await env.resolveModelAuth("openai"))?.auth.apiKey === "fake-env").toBe(true);
});

it("refuses key commands and environment references", async () => {
  const { isLiteralKey } = await import("./model-auth.js");
  for (const candidate of ["!cmd", "$VAR", "key${VAR}", "  !cmd"]) expect(isLiteralKey(candidate)).toBe(false);
  expect(isLiteralKey("fake-literal-key")).toBe(true);
});

it.each([
  { source: "external", stopReason: "stop", status: 200 },
  { source: "external", stopReason: "error", status: 429 },
  { source: "owned", stopReason: "error", status: 401 },
] as const)("sanitizes $source provider results without losing HTTP $status", async ({ source, stopReason, status }) => {
  const { isRetryableProviderError, isFallbackEligibleError } = await import("@yoplai/shared");
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const { createModelAuth } = await import("./model-auth.js");
  if (source === "owned") await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fake-owned" } }));
  const { runtime } = await createModelAuth({ readExternal: async () => ({ type: "api_key", key: "fake-external", source: "test" }) });
  const provider = runtime.getProvider("openai")!;
  const model = runtime.getModels(provider.id)[0];
  const response = {
    role: "assistant" as const, content: [{ type: "text" as const, text: "Test reply." }],
    provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    diagnostics: [{ type: "provider_transport_failure", timestamp: Date.now(), error: { message: "fake-private-diagnostic", stack: "fake-private-stack" } }],
    ...(stopReason === "error" && { errorMessage: "fake-private-error" }),
  };
  runtime.registerNativeProvider({ ...provider, streamSimple: (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    void options?.onResponse?.({ status, headers: {} }, model);
    stream.push({ type: "start", partial: response });
    if (stopReason === "error") stream.push({ type: "error", reason: stopReason, error: response });
    else stream.push({ type: "done", reason: stopReason, message: response });
    stream.end(response);
    return stream;
  } });
  const stream = runtime.streamSimple(model, { messages: [] });
  const events = [];
  for await (const event of stream) events.push(event);
  const final = await stream.result();
  expect(final.stopReason).toBe(stopReason);
  expect(events.map((event) => event.type)).toEqual(["start", stopReason === "stop" ? "done" : "error"]);
  expect(JSON.stringify({ events, final }).includes("fake-private-")).toBe(false);
  expect(final).not.toHaveProperty("diagnostics");
  const message = final.errorMessage ?? "";
  expect(isRetryableProviderError(final, message)).toBe(status === 429);
  expect(isFallbackEligibleError(final, message)).toBe(status === 429);
});
