import { stubDesktopTestEnv } from "../test-utils/desktop-test-env.js";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let root: string;
let home: string;
let server: http.Server | undefined;
beforeEach(async () => {
  vi.resetModules();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-external-"));
  home = path.join(root, "yoplai");
  await fs.mkdir(home);
  stubDesktopTestEnv(root, home);
});
afterEach(async () => {
  server?.close();
  server?.closeAllConnections();
  server = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const locations = { codex: ".codex/auth.json", opencode: ".local/share/opencode/auth.json", pi: ".pi/agent/auth.json" };
async function fixture(source: keyof typeof locations, value: unknown) {
  const file = path.join(root, locations[source]);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value));
  await fs.rename(temporary, file);
  return file;
}

it("detects each source without reading a credential before consent", async () => {
  const { createExternalSources } = await import("./external-sources.js");
  const fake = { exists: vi.fn(async () => true), read: vi.fn(async () => "{}") };
  const paths = await Promise.all(Object.keys(locations).map((source) => fixture(source as keyof typeof locations, {})));
  const read = vi.spyOn(fs, "readFile");
  const external = createExternalSources(home, { keychain: fake });
  expect((await external.status()).every((item) => item.detected && !item.enabled && item.providers.length === 0)).toBe(true);
  for (const file of paths) expect(read.mock.calls.some(([target]) => target === file)).toBe(false);
  expect(fake.exists).toHaveBeenCalledTimes(1);
  expect(fake.read).not.toHaveBeenCalled();
});

it("asks for the Claude warning, records a denial, and does not read on disable", async () => {
  const { createExternalSources } = await import("./external-sources.js");
  const { createModelAccessRoutes } = await import("./model-access.js");
  const read = vi.fn(async () => JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-fake", expiresAt: Date.now() + 60_000 } }));
  const external = createExternalSources(home, { keychain: { exists: async () => true, read } });
  const routes = createModelAccessRoutes(home, { external });
  const post = (body: unknown) => routes.request("/external/claude-code", { method: "POST", body: JSON.stringify(body) });
  expect((await post({ enabled: true })).status).toBe(409);
  expect(read).not.toHaveBeenCalled();
  read.mockRejectedValueOnce(new Error("fake Keychain error"));
  const denied = await post({ enabled: true, warningAccepted: true });
  expect(await denied.json()).toMatchObject({ denied: true, message: "Access denied" });
  await external.status();
  expect(read).toHaveBeenCalledTimes(1);
  const granted = await post({ enabled: true, warningAccepted: true });
  const text = await granted.text();
  expect(JSON.parse(text)).toMatchObject({ providers: [{ provider: "anthropic", type: "oauth", available: true }] });
  expect(text.includes("sk-ant-oat-fake") || text.includes("fake-token-without-marker")).toBe(false);
  expect((await post({ enabled: false })).status).toBe(200);
  expect(read).toHaveBeenCalledTimes(2);
});

it("refuses key expressions from external files and lists unsupported OAuth", async () => {
  const { createExternalSources } = await import("./external-sources.js");
  const external = createExternalSources(home);
  for (const key of ["!cmd", "$VAR", "${VAR}"]) {
    await fixture("opencode", { openai: { type: "api", key } });
    await fixture("pi", { openai: { type: "api_key", key }, "github-copilot": { type: "oauth" } });
    await external.enable("opencode", true);
    const status = await external.enable("pi", true);
    expect(status).toMatchObject({ providers: expect.arrayContaining([{ provider: "github-copilot", type: "oauth", available: false, message: "Not supported yet" }]) });
    expect(await external.resolve("openai", undefined)).toBeUndefined();
  }
});

it("uses fresh Codex tokens for chat without refresh or writes", async () => {
  const { createExternalSources } = await import("./external-sources.js");
  const { createModelAuth } = await import("./model-auth.js");
  const { CODEX_EXPIRED } = await import("./literal-key.js");
  const external = createExternalSources(home);
  const crt = (account: string, minutes: number) => {
    const payload = { exp: Math.floor(Date.now() / 1000) + minutes * 60, "https://api.openai.com/auth": { chatgpt_account_id: account } };
    const token = `fake.${Buffer.from(JSON.stringify(payload)).toString("base64")}.sig`;
    return { tokens: { access_token: token, account_id: account, refresh_token: "fake-unused-refresh" } };
  };
  const initial = crt("account-one", 30);
  const file = await fixture("codex", initial);
  await external.enable("codex", true);
  const { runtime } = await createModelAuth({ readExternal: external.resolve });
  const owned = path.join(home, "auth.json");
  const ownedBefore = await fs.readFile(owned, "utf8");
  const model = runtime.getModels("openai-codex")[0];
  expect(model).toBeDefined();
  expect(await external.resolve("openai-codex", { ...model, baseUrl: "http://127.0.0.1:4000" })).toBeUndefined();
  const observed: Array<{ auth: string | undefined; account: string | string[] | undefined }> = [];
  const item = { id: "fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
  const sse = [
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "fixture", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  let revoked = false;
  server = http.createServer((req, res) => {
    observed.push({ auth: req.headers.authorization, account: req.headers["chatgpt-account-id"] });
    req.resume();
    if (revoked) res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"fake-private-error"}}');
    else res.writeHead(200, { "content-type": "text/event-stream" }).end(sse);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const localFetch = globalThis.fetch;
  const refresh = vi.fn();
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.origin !== "https://chatgpt.com" || !url.pathname.endsWith("/codex/responses")) {
      refresh();
      throw new Error("Unexpected provider call.");
    }
    return localFetch(`http://127.0.0.1:${port}/`, init);
  });
  const socketAttempt = vi.fn();
  vi.stubGlobal("WebSocket", class {
    constructor() {
      socketAttempt();
      throw new Error("Unexpected WebSocket request.");
    }
  });
  const chat = () => runtime.completeSimple(model, { messages: [{ role: "user", content: "Test.", timestamp: Date.now() }] }, { sessionId: "test-codex-session" });
  expect((await chat()).stopReason).toBe("stop");
  const near = crt("account-two", 2);
  await fixture("codex", near);
  expect((await chat()).stopReason).toBe("stop");
  await fixture("codex", crt("account-two", -1));
  expect((await chat()).errorMessage).toBe(CODEX_EXPIRED);
  expect(observed).toHaveLength(2);
  await fixture("codex", near);
  revoked = true;
  expect((await chat()).errorMessage).toBe(CODEX_EXPIRED);
  revoked = false;
  const replacement = crt("account-two", 45);
  await fixture("codex", replacement);
  expect((await chat()).stopReason).toBe("stop");
  expect(observed.map(({ account }) => account)).toEqual(["account-one", "account-two", "account-two", "account-two"]);
  expect(observed[3].auth === `Bearer ${replacement.tokens.access_token}`).toBe(true);
  expect((await fs.readFile(file, "utf8")) === JSON.stringify(replacement)).toBe(true);
  expect((await fs.readFile(owned, "utf8")) === ownedBefore).toBe(true);
  expect(refresh).not.toHaveBeenCalled();
  expect(socketAttempt).not.toHaveBeenCalled();
});

it.each([
  { source: "pi", provider: "anthropic", entry: { type: "oauth", access: "fake-token-without-marker" } },
  { source: "pi", provider: "anthropic", entry: { type: "api_key", key: "sk-ant-oat-fake" } },
  { source: "pi", provider: "openai", entry: { type: "api_key", key: "sk-ant-oat-fake" } },
  { source: "opencode", provider: "anthropic", entry: { type: "api", key: "sk-ant-oat-fake" } },
  { source: "opencode", provider: "openai", entry: { type: "other", token: { access: "sk-ant-oat-fake" } } },
] as const)("skips a Claude login in $source for $provider ($entry.type)", async ({ source, provider, entry }) => {
  const { createExternalSources } = await import("./external-sources.js");
  const { createModelAccessRoutes } = await import("./model-access.js");
  const { createModelAuth } = await import("./model-auth.js");
  vi.stubEnv("ANTHROPIC_API_KEY", "fake-env-anthropic");
  vi.stubEnv("OPENAI_API_KEY", "fake-env-openai");
  const keys = { zai: { type: "api_key", key: "fake-file-key" } };
  const records = { ...keys, [provider]: { ...entry, expires: Date.now() + 60_000 } };
  await fixture(source, records);
  const external = createExternalSources(home);
  const routes = createModelAccessRoutes(home, { external });
  const response = await routes.request(`/external/${source}`, { method: "POST", body: '{"enabled":true}' });
  expect(response.status).toBe(200);
  const text = await response.text();
  const skipped = {
    provider, type: "oauth", available: false,
    message: "Claude login: use Sign in with Claude or the Claude Code source",
  };
  expect(JSON.parse(text)).toMatchObject({ enabled: true, providers: expect.arrayContaining([skipped]) });
  expect(text.includes("sk-ant-oat-fake") || text.includes("fake-token-without-marker")).toBe(false);

  const { runtime } = await createModelAuth({ readExternal: external.resolve });
  expect((await runtime.getAuth(runtime.getModels("zai")[0]))?.auth.apiKey === keys.zai.key).toBe(true);
  await fixture(source, keys);
  expect(await external.resolve(provider, runtime.getModels(provider)[0])).toBeUndefined();
  await fixture(source, records);
  expect(await external.status()).toEqual(expect.arrayContaining([
    expect.objectContaining({ source, providers: expect.arrayContaining([skipped]) }),
  ]));

  const calls: Array<{ model: string; usesEnvKey: boolean; usesClaudeToken: boolean }> = [];
  vi.stubGlobal("fetch", async (input: string | Request | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const url = new URL(input instanceof Request ? input.url : input);
    const api = url.hostname === "api.anthropic.com" ? "anthropic" : "openai";
    calls.push({
      model: api,
      usesEnvKey: api === "anthropic" ? headers.get("x-api-key") === "fake-env-anthropic" : headers.get("authorization") === "Bearer fake-env-openai",
      usesClaudeToken: [...headers.values()].some((value) => value.includes("sk-ant-oat-fake") || value.includes("fake-token-without-marker")),
    });
    return new Response(null, { status: 401 });
  });
  for (const id of new Set([provider, "anthropic"])) {
    await runtime.completeSimple(runtime.getModels(id)[0], { messages: [{ role: "user", content: "Test.", timestamp: Date.now() }] });
  }
  expect(calls).toEqual([...new Set([provider, "anthropic"])].map((model) => ({ model, usesEnvKey: true, usesClaudeToken: false })));
});
