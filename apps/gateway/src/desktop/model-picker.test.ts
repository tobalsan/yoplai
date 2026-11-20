import { stubDesktopTestEnv } from "../test-utils/desktop-test-env.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let root: string;
let home: string;
beforeEach(async () => {
  vi.resetModules();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-picker-"));
  home = path.join(root, "yoplai");
  await fs.mkdir(home);
  stubDesktopTestEnv(root, home);
  const { configureRelay } = await import("../relay/state.js");
  configureRelay("127.0.0.1", false);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

function successfulCall() {
  const item = { id: "fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
  const events = [
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "fixture", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

it("lists a default without calling the model and marks it ready after a successful check", async () => {
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fake-picker-key" } }));
  const call = vi.fn(async () => successfulCall());
  vi.stubGlobal("fetch", call);
  const { createModelAccess } = await import("./model-access.js");
  const { routes } = createModelAccess(home);
  const list = async () => (await (await routes.request("/models")).json()).models;
  expect(await list()).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "openai", model: "gpt-4.1-mini", ready: false, default: true })]));
  expect(call).not.toHaveBeenCalled();
  const res = await routes.request("/models/check", { method: "POST", body: '{"provider":"openai","model":"gpt-4.1-mini"}' });
  expect(await res.json()).toMatchObject({ ready: true });
  expect(await list()).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "openai", model: "gpt-4.1-mini", ready: true, default: true })]));
  expect(call).toHaveBeenCalledTimes(1);
  expect((await routes.request("/openai", { method: "DELETE" })).status).toBe(204);
  expect(await list()).toEqual([]);
});

it("does not set a default or probe an API key for a free-only catalog", async () => {
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fake-picker-key" } }));
  const { createModelAccess } = await import("./model-access.js");
  const { createModelAuth } = await import("./model-auth.js");
  const auth = await createModelAuth({ home });
  const base = auth.runtime.getModel("openai", "gpt-4.1-mini")!;
  const free = { ...base, id: "fixture:free", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const read = auth.runtime.getModels.bind(auth.runtime);
  vi.spyOn(auth.runtime, "getModels").mockImplementation((provider) => provider === "openai" ? [free] : read(provider));
  const available = auth.runtime.getAvailable.bind(auth.runtime);
  vi.spyOn(auth.runtime, "getAvailable").mockImplementation(async (provider) => provider === "openai" ? [free] : available(provider));
  const checkKey = vi.fn(async () => true as const);
  const { routes } = createModelAccess(home, { createAuth: async () => auth, checkKey });
  expect(await (await routes.request("/models")).json()).toEqual({ models: [
    expect.objectContaining({ provider: "openai", model: free.id, default: false, free: true, ready: false }),
  ] });
  const status = await (await routes.request("/")).json();
  expect(status.apiKeyProviders).not.toContainEqual(expect.objectContaining({ id: "openai" }));
  const probe = await routes.request("/api-key", { method: "POST", body: JSON.stringify({ provider: "openai", key: "fake-new-key" }) });
  expect(probe.status).toBe(404);
  expect(checkKey).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it("does not use the old key when a provider rejects the submitted key", async () => {
  const file = path.join(home, "auth.json");
  const before = JSON.stringify({ openai: { type: "api_key", key: "fake-old-key" } });
  await fs.writeFile(file, before);
  const call = vi.fn(async (_input: unknown, init?: RequestInit) => new Headers(init?.headers).get("authorization") === "Bearer fake-new-key" ? successfulCall() : new Response('{"error":{"message":"fake-private-error"}}', { status: 401 }));
  vi.stubGlobal("fetch", call);
  const { createModelAccess } = await import("./model-access.js");
  const { routes } = createModelAccess(home);
  const check = (key: string) => routes.request("/api-key", { method: "POST", body: JSON.stringify({ provider: "openai", checkOnly: true, key }) });
  const bad = await check("fake-bad-key");
  expect(bad.status).toBe(422);
  expect((await bad.text()).includes("fake-private-error")).toBe(false);
  expect((await check("fake-new-key")).status).toBe(200);
  expect(call).toHaveBeenCalledTimes(2);
  expect((await fs.readFile(file, "utf8")) === before).toBe(true);
});

function providerStream(events: Array<{ type?: string; [key: string]: unknown }>) {
  return new Response(events.map((event) => `${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

it("checks the default for each external source with a fake provider", async () => {
  const { createExternalSources } = await import("./external-sources.js");
  const { createModelAccess } = await import("./model-access.js");
  const create = async (location: string, record: unknown) => {
    const file = path.join(root, location);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(record));
  };
  const payload = { exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" } };
  const token = `fake.${Buffer.from(JSON.stringify(payload)).toString("base64")}.sig`;
  await create(".codex/auth.json", { tokens: { access_token: token, account_id: "fake-account" } });
  await create(".local/share/opencode/auth.json", { "opencode-go": { type: "api", key: "fake-go" } });
  await create(".pi/agent/auth.json", { openai: { type: "api_key", key: "fake-pi-openai" } });
  const external = createExternalSources(home, { keychain: {
    exists: async () => true,
    read: async () => JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-fake", expiresAt: Date.now() + 60_000 } }),
  } });
  for (const source of ["codex", "claude-code", "opencode", "pi"] as const) await external.enable(source, true, source === "claude-code");
  const call = vi.fn(async (input: string | Request | URL) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "api.anthropic.com") return providerStream([
      { type: "message_start", message: { id: "fake", type: "message", role: "assistant", content: [], stop_reason: null, model: "claude-haiku-5-5", usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
    if (url.hostname === "opencode.ai") return providerStream([
      { id: "fake", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
      { id: "fake", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    if (url.hostname === "api.openai.com" || url.hostname === "chatgpt.com") return successfulCall();
    throw new Error("Unexpected provider call.");
  });
  vi.stubGlobal("fetch", call);
  const { routes } = createModelAccess(home, { external });
  const list = async () => (await (await routes.request("/models")).json()).models;
  const defaults = [
    { source: "codex", provider: "openai-codex", model: "gpt-6-astra" },
    { source: "claude-code", provider: "anthropic", model: "claude-haiku-5-5" },
    { source: "opencode", provider: "opencode-go", model: "deepseek-v4.1-flash" },
    { source: "pi", provider: "openai", model: "gpt-4.1-mini" },
  ];
  expect(await list()).toEqual(expect.arrayContaining(defaults.map((row) => expect.objectContaining({ ...row, default: true, ready: false }))));
  expect(call).not.toHaveBeenCalled();
  for (const { provider, model } of defaults) {
    const res = await routes.request("/models/check", { method: "POST", body: JSON.stringify({ provider, model }) });
    expect(await res.json()).toMatchObject({ model, ready: true });
  }
  expect(await list()).toEqual(expect.arrayContaining(defaults.map((row) => expect.objectContaining({ ...row, default: true, ready: true }))));
  expect(call).toHaveBeenCalledTimes(4);
});

it("uses the valid Pi login in chat when the enabled Codex CLI login has expired", async () => {
  const { createModelAccess } = await import("./model-access.js");
  const { createModelAuth } = await import("./model-auth.js");
  const { routes } = createModelAccess(home);
  const token = (offset: number, suffix: string) => {
    const payload = { exp: Math.floor(Date.now() / 1000) + offset, "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } };
    return `fake.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${suffix}`;
  };
  const save = async (location: string, record: unknown) => {
    const file = path.join(root, location);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(record));
  };
  const savePi = (access: string) => save(".pi/agent/auth.json", {
    "openai-codex": { type: "oauth", access, accountId: "fixture-account" },
  });
  await save(".codex/auth.json", { tokens: { access_token: token(-3600, "expired"), account_id: "fixture-account" } });
  await savePi(token(3600, "picker"));
  for (const source of ["codex", "pi"]) {
    const enabled = await routes.request(`/external/${source}`, { method: "POST", body: '{"enabled":true}' });
    expect(await enabled.json()).toMatchObject({ enabled: true });
  }
  const { models } = await (await routes.request("/models")).json();
  const selected = models.find((row: { provider: string; default: boolean }) => row.provider === "openai-codex" && row.default);
  expect(selected).toMatchObject({ source: "pi" });
  const fresh = token(3600, "chat");
  await savePi(fresh);
  const call = vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
    expect(new URL(input instanceof Request ? input.url : input).hostname).toBe("chatgpt.com");
    expect(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization") === `Bearer ${fresh}`).toBe(true);
    return successfulCall();
  });
  vi.stubGlobal("fetch", call);
  const { runtime, requireModelAuth } = await createModelAuth({ home });
  const model = runtime.getModel(selected.provider, selected.model)!;
  await requireModelAuth(model);
  const result = await runtime.streamSimple(model, { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] }).result();
  expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "OK" }));
  expect(call).toHaveBeenCalledTimes(1);
});

it("probes and generates instructions at the current endpoint after opening setup", async () => {
  const { createServer } = await import("node:http");
  const requests: Array<{ path?: string; submitted: boolean }> = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, submitted: req.headers.authorization === "Bearer fake-submitted-key" });
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    void successfulCall().text().then((text) => res.end(text));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("The test server did not bind.");
    const baseUrl = `http://127.0.0.1:${bound.port}`;
    const setEndpoint = (name: string) => fs.writeFile(path.join(home, "models.json"), JSON.stringify({
      providers: { openai: { baseUrl: `${baseUrl}/${name}` } },
    }));
    await setEndpoint("old");
    const fetchLocal = globalThis.fetch;
    const otherEndpoint = vi.fn();
    vi.stubGlobal("fetch", (input: string | Request | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== new URL(baseUrl).origin) {
        otherEndpoint();
        return Promise.resolve(new Response(null, { status: 401 }));
      }
      return fetchLocal(input, init);
    });
    const { createModelAccess } = await import("./model-access.js");
    const { createInstructionWriter } = await import("./agent-instructions.js");
    const { routes, getAuth } = createModelAccess(home);
    expect((await routes.request("/")).status).toBe(200);
    await setEndpoint("current");
    const checked = await routes.request("/api-key", { method: "POST", body: JSON.stringify({ provider: "openai", key: "fake-submitted-key" }) });
    expect(await checked.json()).toMatchObject({ ready: true, saved: true });
    const write = createInstructionWriter(getAuth);
    expect(await write({ name: "Fixture", model: { provider: "openai", model: "gpt-4.1-mini" } })).toMatchObject({ source: "model" });
    expect(requests).toEqual([
      { path: "/current/responses", submitted: true },
      { path: "/current/responses", submitted: true },
    ]);
    expect(otherEndpoint).not.toHaveBeenCalled();
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

it("lists only the Copilot models that the owned account can use", async () => {
  const allowed = "claude-fable-5";
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ "github-copilot": {
    type: "oauth", access: "fake-copilot-access", refresh: "fake-copilot-refresh",
    expires: Date.now() + 3_600_000, availableModelIds: [allowed],
  } }));
  const call = vi.fn(async () => new Response(null, { status: 500 }));
  vi.stubGlobal("fetch", call);
  const { createModelAccess } = await import("./model-access.js");
  const response = await createModelAccess(home).routes.request("/models");
  expect(response.status).toBe(200);
  const body = await response.json() as { models: Array<{ provider: string }> };
  expect(body.models.filter((model) => model.provider === "github-copilot")).toEqual([
    expect.objectContaining({ model: allowed, source: "owned", default: true, ready: false }),
  ]);
  expect(call).not.toHaveBeenCalled();
});

it("does not send a submitted key when the model config is invalid", async () => {
  await fs.writeFile(path.join(home, "models.json"), '{"providers":');
  const call = vi.fn(async () => successfulCall());
  vi.stubGlobal("fetch", call);
  const { createModelAccess } = await import("./model-access.js");
  const response = await createModelAccess(home).routes.request("/api-key", {
    method: "POST", body: JSON.stringify({ provider: "openai", key: "fake-submitted-key", checkOnly: true }),
  });
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: "key_check_failed", message: "The API key check failed." });
  expect(call).not.toHaveBeenCalled();
});

it.each([
  { level: "provider", config: { headers: { "x-goog-api-key": "fake-configured-key" } } },
  { level: "model", config: { modelOverrides: { "gemini-2.5-flash": { headers: { "x-test-label": "test" } } } } },
])("refuses a custom header on the $level without a request or save", async ({ config }) => {
  await fs.writeFile(path.join(home, "models.json"), JSON.stringify({ providers: { google: config } }));
  const call = vi.fn(async () => successfulCall());
  vi.stubGlobal("fetch", call);
  const { createModelAccess } = await import("./model-access.js");
  const { routes } = createModelAccess(home);
  const response = await routes.request("/api-key", {
    method: "POST", body: JSON.stringify({ provider: "google", key: "fake-bad-key" }),
  });
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: "key_check_failed", message: "Yoplai cannot check this key because the model config adds custom headers." });
  expect(call).not.toHaveBeenCalled();
  expect(await (await routes.request("/")).json()).toMatchObject({ owned: [] });
});

it.each([
  { provider: "google", host: "generativelanguage.googleapis.com", header: "x-goog-api-key", value: "fake-submitted-key" },
  { provider: "cloudflare-ai-gateway", host: "gateway.ai.cloudflare.com", header: "cf-aig-authorization", value: "Bearer fake-submitted-key" },
  { provider: "openai", host: "api.openai.com", header: "authorization", value: "Bearer fake-submitted-key" },
])("checks the submitted key through native $provider auth", async ({ provider, host, header, value }) => {
  if (provider === "cloudflare-ai-gateway") {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "fixture-account");
    vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "fixture-gateway");
  }
  const calls: Array<{ host: string; keyMatches: boolean }> = [];
  vi.stubGlobal("fetch", async (input: string | Request | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const keyMatches = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(header) === value;
    calls.push({ host: url.hostname, keyMatches });
    if (!keyMatches || url.hostname !== host) return new Response(null, { status: 401 });
    if (provider === "google") return providerStream([{ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] }]);
    if (url.pathname.endsWith("/messages")) return providerStream([
      { type: "message_start", message: { id: "fake", type: "message", role: "assistant", content: [], stop_reason: null, model: "fixture", usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
    return successfulCall();
  });
  if (provider === "cloudflare-ai-gateway") {
    const { createModelAuth, checkLiteralModelKey } = await import("./model-auth.js");
    const { defaultModel } = await import("./model-picker.js");
    const { runtime } = await createModelAuth({ home });
    const model = defaultModel(runtime.getModels(provider));
    expect(await checkLiteralModelKey(provider, "fake-submitted-key", model!.id, home)).toBe(true);
  } else {
    const { createModelAccess } = await import("./model-access.js");
    const { routes } = createModelAccess(home);
    const save = provider === "openai";
    const response = await routes.request("/api-key", {
      method: "POST", body: JSON.stringify({ provider, key: "fake-submitted-key", ...(!save && { checkOnly: true }) }),
    });
    expect(await response.json()).toMatchObject({ provider, ready: true, saved: save });
    if (save) {
      const credentials = JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8"));
      expect(credentials.openai?.key === "fake-submitted-key").toBe(true);
    }
  }
  expect(calls).toEqual([{ host, keyMatches: true }]);
});


it("lists and accepts only providers that need no input other than the key", async () => {
  const call = vi.fn(async () => successfulCall());
  vi.stubGlobal("fetch", call);
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "fixture-account");
  vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "fixture-gateway");
  const { createModelAccess } = await import("./model-access.js");
  const { routes } = createModelAccess(home);
  const status = await (await routes.request("/")).json() as { apiKeyProviders: Array<{ id: string }> };
  const choices = status.apiKeyProviders.map(({ id }) => id);
  expect(choices).toContain("openai");
  for (const provider of ["amazon-bedrock", "cloudflare-ai-gateway", "cloudflare-workers-ai", "google-vertex"]) {
    expect(choices).not.toContain(provider);
    for (const checkOnly of [false, true]) {
      const response = await routes.request("/api-key", {
        method: "POST", body: JSON.stringify({ provider, key: "fake-submitted-key", checkOnly }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "unsupported_provider", message: "This provider needs more than an API key. Use another provider." });
    }
  }
  expect(call).not.toHaveBeenCalled();
  expect(await (await routes.request("/")).json()).toMatchObject({ owned: [] });
});
