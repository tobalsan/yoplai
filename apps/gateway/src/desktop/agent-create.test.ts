import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubDesktopTestEnv } from "../test-utils/desktop-test-env.js";

vi.mock("./external-sources.js", async (load) => {
  const actual = await load<typeof import("./external-sources.js")>();
  const sources = new Map<string, ReturnType<typeof actual.createExternalSources>>();
  return { ...actual, getExternalSources(home: string) {
    if (!sources.has(home)) sources.set(home, actual.createExternalSources(home, { keychain: {
      exists: async () => false,
      read: async () => { throw new Error("The fake Keychain is empty."); },
    } }));
    return sources.get(home);
  } };
});

const beforeRename = vi.hoisted(() => ({ next: undefined as ((from: string) => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises") & { default: typeof fs }>();
  return { ...actual, default: { ...actual.default, async rename(from: string, to: string) {
    if (path.basename(from).startsWith(".desktop-agent-")) await beforeRename.next?.(from);
    return actual.default.rename(from, to);
  } } };
});

const validate = vi.hoisted(() => ({ next: undefined as (() => Promise<void>) | undefined }));
vi.mock("../config/validate.js", async (load) => {
  const actual = await load<typeof import("../config/validate.js")>();
  return { ...actual, async resolveStartupConfig(config: Parameters<typeof actual.resolveStartupConfig>[0]) {
    const next = validate.next;
    validate.next = undefined;
    await next?.();
    return actual.resolveStartupConfig(config);
  } };
});

const agentsGlob = "$YOPLAI_HOME/agents/*";
const avatars = fileURLToPath(new URL("../../../web/public/avatars/", import.meta.url));
const model = { provider: "openai", model: "gpt-4.1-mini" };
const base = "http://127.0.0.1:4000";
const stop: (() => void)[] = [];
let root: string;
let home: string;
let reply: (res: ServerResponse, prompt: string) => void;
let providerCalls: string[];
let app: typeof import("../server/index.js")["app"];

async function start() {
  vi.resetModules();
  ({ app } = await import("../server/index.js"));
  const state = await import("../relay/state.js");
  state.configureRelay("127.0.0.1", false);
  state.setGatewayListener({ address: "127.0.0.1", port: 4000 });
}

function config(rules: { agents?: string | string[]; pool?: string | string[] } = { agents: agentsGlob }) {
  return fs.writeFile(path.join(home, "yoplai.json"), JSON.stringify({ version: 3, ...rules }));
}

function sendModelText(res: ServerResponse, text: string) {
  const item = { id: "fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "fixture", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-agent-"));
  home = path.join(root, "yoplai");
  await fs.mkdir(home);
  stubDesktopTestEnv(root, home);
  await config();
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fake-agent-key" } }));
  providerCalls = [];
  reply = (res) => sendModelText(res, " ");
  const provider = createServer((req, res) => {
    let prompt = "";
    req.setEncoding("utf8");
    req.on("data", (data: string) => { prompt += data; });
    req.on("end", () => {
      providerCalls.push(prompt);
      reply(res, prompt);
    });
  });
  stop.push(() => { provider.close(); provider.closeAllConnections(); });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as AddressInfo).port;
  await fs.writeFile(path.join(home, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: `http://127.0.0.1:${port}/v1` } } }));
  await start();
});

afterEach(async () => {
  for (const close of stop.splice(0)) close();
  validate.next = undefined;
  beforeRename.next = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function request(route = "/api/agents", init?: RequestInit) {
  return app.request(`${base}${route}`, { ...init, headers: { host: "127.0.0.1:4000", ...init?.headers } }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
}

function body(name = " AI Chief of Staff ") {
  return { requestId: randomUUID(), name, avatar: 3, model };
}

function json(input: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) };
}

const create = (input: unknown) => request("/api/agents", json(input));
const list = async () => (await request()).json();
const dir = (name: string) => path.join(home, "agents", name);

async function fixture(folder: string, requestId?: string) {
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "agent.yaml"), `id: ${path.basename(folder)}\nname: Existing\nmodel: ${JSON.stringify(model)}\n`);
  if (requestId) {
    await fs.writeFile(path.join(folder, "AGENTS.md"), "Test instructions.\n");
    await fs.writeFile(path.join(folder, ".desktop-create.json"), JSON.stringify({ requestId, instructions: "model" }));
  }
}

async function expectNoWrite() {
  await expect(fs.readdir(dir(""))).resolves.toEqual([]);
  await expect(fs.access(path.join(home, "run"))).rejects.toMatchObject({ code: "ENOENT" });
}

it("starts empty and serves the new agent and avatar before the create returns", async () => {
  expect(await list()).toEqual([]);
  vi.spyOn(process, "cwd").mockReturnValue(root);
  const created = await create({ ...body(), purpose: "Sort tasks." });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ id: "ai-chief-of-staff", instructions: "template" });
  expect(await list()).toEqual([expect.objectContaining({ id: "ai-chief-of-staff", name: "AI Chief of Staff", description: "Sort tasks.", avatar: "/api/agents/ai-chief-of-staff/avatar", model })]);
  const avatar = await request("/api/agents/ai-chief-of-staff/avatar");
  expect(avatar.headers.get("content-type")).toBe("image/webp");
  expect(Buffer.from(await avatar.arrayBuffer()).equals(await fs.readFile(path.join(avatars, "default-3.webp")))).toBe(true);
  await expect(fs.readdir(path.join(home, "run"))).resolves.toEqual([]);
  vi.stubEnv("YOPLAI_DESKTOP", "0");
  expect((await request()).status).toBe(200);
  // Single-user gateways allow agent creation without the desktop flag.
  expect((await create(body())).status).toBe(201);
});

it("uses the packaged avatar and accepts a write through the packaged UI proxy", async () => {
  const webDist = path.join(root, "resources", "web");
  await fs.mkdir(path.join(webDist, "avatars"), { recursive: true });
  await fs.copyFile(path.join(avatars, "default-4.webp"), path.join(webDist, "avatars", "default-3.webp"));
  vi.stubEnv("YOPLAI_WEB_DIST", webDist);
  const { startUiListener } = await import("../server/ui-listener.js");
  const state = await import("../relay/state.js");
  const gateway = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  stop.push(() => { gateway.close(); if ("closeAllConnections" in gateway) gateway.closeAllConnections(); });
  await new Promise<void>((resolve) => gateway.once("listening", resolve));
  const port = (gateway.address() as AddressInfo).port;
  state.setGatewayListener({ address: "127.0.0.1", port });
  const ui = startUiListener({ webDist, host: "127.0.0.1", port: 0, gatewayHost: "127.0.0.1", gatewayPort: port, onError: (error) => { throw error; } });
  stop.push(() => { ui.close(); ui.closeAllConnections(); });
  await new Promise<void>((resolve) => ui.once("listening", resolve));
  const uiPort = (ui.address() as AddressInfo).port;
  vi.stubEnv("YOPLAI_UI_PORT", String(uiPort));
  const origin = `http://127.0.0.1:${uiPort}`;
  vi.spyOn(process, "cwd").mockReturnValue(root);
  const input = json(body("Proxy Agent"));
  const res = await fetch(`${origin}/api/agents`, { ...input, headers: { ...input.headers, origin } });
  expect(res.status).toBe(201);
  const avatar = await fetch(`${origin}/api/agents/proxy-agent/avatar`);
  expect(Buffer.from(await avatar.arrayBuffer()).equals(await fs.readFile(path.join(avatars, "default-4.webp")))).toBe(true);
});

it("lists and checks free models and creates an agent only with an eligible source", async () => {
  const file = path.join(home, "models.json");
  const config = JSON.parse(await fs.readFile(file, "utf8"));
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const marked = ["fixture:free", "fixture-free"];
  const unmarked = "fixture-zero";
  config.providers.openai.models = [...marked, unmarked].map((id) => ({ id, name: id, api: "openai-responses", cost }));
  await fs.writeFile(file, JSON.stringify(config));
  const pick = (id: string) => ({ provider: "openai", model: id });
  const check = (id: string) => request("/api/model-access/models/check", json(pick(id)));
  const models = async () => (await (await request("/api/model-access/models")).json()).models;
  expect(await models()).toEqual(expect.arrayContaining(marked.map((id) => expect.objectContaining({ ...pick(id), source: "owned", default: false, free: true }))));
  expect(await models()).not.toEqual(expect.arrayContaining([expect.objectContaining(pick(unmarked))]));
  expect((await check(unmarked)).status).toBe(404);
  expect(await (await create({ ...body(), model: pick(unmarked) })).json()).toMatchObject({ error: "unavailable_model" });
  expect(providerCalls).toEqual([]);
  reply = (res) => sendModelText(res, "OK");
  expect(await (await check(marked[0])).json()).toMatchObject({ ...pick(marked[0]), ready: true });
  const chosen = pick(marked[0]);
  const created = await create({ ...body(), model: chosen });
  expect(created.status).toBe(201);
  expect(await list()).toEqual([expect.objectContaining({ model: chosen })]);
  expect((await request("/api/model-access/openai", { method: "DELETE" })).status).toBe(204);
  expect(await models()).toEqual([]);
  expect((await check(marked[0])).status).toBe(404);
  expect(await (await create({ ...body("Second agent"), model: chosen })).json()).toMatchObject({ error: "unavailable_model" });
});

it("rejects invalid JSON, a missing body, bad fields, and a model not on the list", async () => {
  expect((await request("/api/agents", { method: "POST" })).status).toBe(400);
  expect((await request("/api/agents", { ...json(body()), body: "{" })).status).toBe(400);
  expect((await request("/api/agents", { method: "POST", body: "{}" })).status).toBe(400);
  for (const bad of [{ name: " " }, { name: "a".repeat(61) }, { purpose: "a".repeat(281) }, { avatar: "https://example.test/a" }, { avatar: 0 }, { avatar: 11 }, { avatar: 1.5 }, { requestId: "bad" }]) {
    const res = await create({ ...body(), ...bad });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  }
  const res = await create({ ...body(), model: { ...model, model: "missing" } });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "unavailable_model" });
  expect(await list()).toEqual([]);
  await expect(fs.access(dir(""))).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not expand reserved prefixes in the name or purpose", async () => {
  const value = "fake-test-value";
  vi.stubEnv("AGENT_TEST_VALUE", value);
  for (const field of ["name", "purpose"]) {
    for (const prefix of ["$env:", "$secret:"]) {
      const res = await create({ ...body(), [field]: ` ${prefix}AGENT_TEST_VALUE ` });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "reserved_prefix", message: "Remove the $env: or $secret: prefix." });
    }
  }
  expect(await list()).toEqual([]);
  await expect(fs.access(dir(""))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await create({ ...body("$ENV:AGENT_TEST_VALUE"), purpose: "Use $env:AGENT_TEST_VALUE as text." })).status).toBe(201);
  expect(JSON.stringify(await list())).not.toContain(value);
});

it("avoids existing folders and IDs from custom rules and the pool", async () => {
  await config({ agents: [agentsGlob, "team/*"], pool: "pool/*" });
  await fixture(path.join(home, "pool", "test"));
  await fixture(path.join(home, "team", "test-2"));
  await fs.mkdir(dir("test-3"), { recursive: true });
  const res = await create(body("Test"));
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ id: "test-4" });
  expect(await (await create(body("船"))).json()).toMatchObject({ id: "agent" });
});

it("uses a suffix when an existing folder or agent ID differs only in letter case", async () => {
  await config({ agents: [agentsGlob, "team/*"], pool: "pool/*" });
  await fs.mkdir(dir("ALPHA"), { recursive: true });
  await fixture(path.join(home, "team", "Alpha-2"));
  await fixture(path.join(home, "pool", "ALPHA-3"));
  const res = await create(body("alpha"));
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ id: "alpha-4" });
  expect(await fs.readdir(dir(""))).toEqual(expect.arrayContaining(["ALPHA", "alpha-4"]));
});

it("uses a suffix when a literal discovery path reserves a name", async () => {
  await config({ agents: [agentsGlob, "agents/Alpha"] });
  const res = await create(body("alpha"));
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ id: "alpha-2" });
  expect(await list()).toEqual([expect.objectContaining({ id: "alpha-2" })]);
});

it("creates and retries when the agents folder is a symbolic link", async () => {
  const target = path.join(home, "workspaces");
  await fs.mkdir(target);
  await fs.symlink(target, dir(""));
  await config({ agents: "workspaces/*" });
  const input = body("Linked");
  const res = await create(input);
  expect(res.status).toBe(201);
  const created = await res.json();
  expect(created).toMatchObject({ id: "linked" });
  expect(await list()).toEqual([expect.objectContaining({ id: "linked" })]);
  const retry = await create(input);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual(created);
  expect(await fs.readdir(target)).toEqual(["linked"]);
});

it("serializes parallel creates with distinct names and reloads both into the list", async () => {
  const entered = deferred();
  const resume = deferred();
  validate.next = async () => { entered.resolve(); await resume.promise; };
  const first = create(body("Alpha"));
  await entered.promise;
  const second = create(body("Beta"));
  try {
    expect(await Promise.race([second.then(() => "returned"), new Promise((resolve) => setTimeout(resolve, 80, "waiting"))])).toBe("waiting");
  } finally {
    resume.resolve();
  }
  expect((await Promise.all([first, second])).map((res) => res.status)).toEqual([201, 201]);
  expect((await list()).map(({ id }: { id: string }) => id)).toEqual(["alpha", "beta"]);
});

it("publishes the workspace in one move and requires a reload before success", async () => {
  expect(await list()).toEqual([]);
  beforeRename.next = async (from) => {
    expect(path.dirname(from)).toBe(path.join(home, "run"));
    expect(await fs.readdir(from)).toEqual(expect.arrayContaining(["agent.yaml", "AGENTS.md", "default-3.webp", ".desktop-create.json"]));
    await expect(fs.access(dir("atomic"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await list()).toEqual([]);
  };
  expect((await create(body("Atomic"))).status).toBe(201);
  expect(await list()).toEqual([expect.objectContaining({ id: "atomic" })]);
});

it("removes the staging folder after a failed move", async () => {
  beforeRename.next = async () => { throw new Error("Internal test detail."); };
  const res = await create(body("Failed"));
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "write_failed", message: "Yoplai could not save the agent. Try again." });
  expect(await fs.readdir(path.join(home, "run"))).toEqual([]);
  expect(await fs.readdir(dir(""))).toEqual([]);
  expect(await list()).toEqual([]);
});

it("gives parallel requests with the same name distinct IDs", async () => {
  const responses = await Promise.all([create(body("Same")), create(body("Same"))]);
  expect(responses.map((res) => res.status)).toEqual([201, 201]);
  expect((await list()).map(({ id }: { id: string }) => id)).toEqual(["same", "same-2"]);
});

it("returns one agent for parallel requests and after a restart without the model", async () => {
  const input = body("One");
  const responses = await Promise.all([create(input), create(input)]);
  expect(responses.map((res) => res.status).sort()).toEqual([200, 201]);
  const created = { id: "one", instructions: "template" };
  for (const res of responses) expect(await res.json()).toEqual(created);
  expect(await fs.readdir(dir(""))).toEqual(["one"]);
  expect((await request("/api/model-access/openai", { method: "DELETE" })).status).toBe(204);
  expect(await (await request("/api/model-access/models")).json()).toEqual({ models: [] });
  expect(await (await create(input)).json()).toEqual(created);
  await start();
  expect(await (await create(input)).json()).toEqual(created);
  expect(await fs.readdir(dir(""))).toEqual(["one"]);
});

it("recovers a rename without a reload while a new create waits for the recovery reload", async () => {
  expect(await list()).toEqual([]);
  const input = body("Recovered");
  const staging = path.join(home, "run", "crash-test");
  await fixture(staging, input.requestId);
  await fs.writeFile(path.join(staging, "agent.yaml"), `id: recovered\nname: Recovered\nmodel: ${JSON.stringify(model)}\n`);
  await fs.mkdir(dir(""));
  await fs.rename(staging, dir("recovered"));
  const entered = deferred();
  const resume = deferred();
  validate.next = async () => { entered.resolve(); await resume.promise; };
  const retry = create(input);
  await entered.promise;
  const other = create(body("New"));
  try {
    expect(await Promise.race([other.then(() => "returned"), new Promise((resolve) => setTimeout(resolve, 80, "waiting"))])).toBe("waiting");
  } finally {
    resume.resolve();
  }
  expect(await (await retry).json()).toEqual({ id: "recovered", instructions: "model" });
  expect((await other).status).toBe(201);
  expect((await list()).map(({ id }: { id: string }) => id)).toEqual(["new", "recovered"]);
});

it("keeps the last successful publication when a queued create fails", async () => {
  const { withExtensionMutation } = await import("../extensions/registry.js");
  const { reloadAfterExtensionWrite } = await import("../extensions/reload.js");
  expect(await list()).toEqual([]);
  const resume = deferred();
  const held = withExtensionMutation(() => resume.promise);
  const renamed = deferred();
  beforeRename.next = async () => { renamed.resolve(); };
  const publish = reloadAfterExtensionWrite();
  const input = body("Queued");
  const pending = create(input);
  try {
    await renamed.promise;
    await fixture(dir("latest"));
    await config({ agents: "agents/latest" });
    // The public create should now be queued behind the successful reload.
    expect(await Promise.race([pending.then(() => "returned"), new Promise((resolve) => setTimeout(resolve, 80, "waiting"))])).toBe("waiting");
    await fs.access(path.join(dir("queued"), ".desktop-create.json"));
  } finally {
    resume.resolve();
  }
  await held;
  await publish;
  const result = await pending;
  expect(result.status).toBe(500);
  expect(await result.json()).toMatchObject({ error: "reload_failed" });
  expect(await list()).toEqual([expect.objectContaining({ id: "latest" })]);
  await config();
  const retry = await create(input);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({ id: "queued", instructions: "template" });
  expect(await fs.readdir(dir(""))).toEqual(["latest", "queued"]);
});

it("publishes a created agent even when an unrelated extension reload hook throws", async () => {
  const { reloadConfig } = await import("../config/index.js");
  const { loadExtensions } = await import("../extensions/registry.js");
  const folder = path.join(home, "extensions", "throwing");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(folder, "index.js"), `export default {
    id: "throwing", displayName: "Throwing", description: "Fixture", dependencies: [],
    configSchema: { parse: (value) => value, safeParse: (data) => ({ success: true, data }) },
    validateConfig: () => ({ valid: true, errors: [] }),
    routePrefixes: [], registerRoutes() {}, start() {}, stop() {}, capabilities: () => [],
    onConfigReload() { throw new Error("Fixture reload rejected."); },
  };`);
  await fs.writeFile(path.join(home, "yoplai.json"), JSON.stringify({
    version: 3, agents: agentsGlob, extensions: { throwing: { enabled: true } },
  }));
  await loadExtensions(reloadConfig());
  const warn = vi.spyOn(console, "warn");
  const res = await create(body("Published"));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("throwing config reload hook failed: Fixture reload rejected."));
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ id: "published" });
  expect(await list()).toEqual([expect.objectContaining({ id: "published" })]);
});

it("keeps the agent on disk after a reload failure and reloads it on retry", async () => {
  const input = body("Repair");
  validate.next = async () => { throw new Error("Internal test detail."); };
  const res = await create(input);
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "reload_failed", message: "Yoplai could not reload the agent list. Try again." });
  expect(await list()).toEqual([]);
  expect(await fs.readdir(dir(""))).toEqual(["repair"]);
  const retry = await create(input);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({ id: "repair", instructions: "template" });
  expect(await list()).toEqual([expect.objectContaining({ id: "repair" })]);
});

it.each([
  { agents: [agentsGlob, "agents/{alpha,beta}"] },
  { agents: "custom/*" },
  { agents: [agentsGlob, "run/*"] },
  { pool: ["pool/*", agentsGlob] },
  { agents: agentsGlob, pool: ["pool/*", agentsGlob] },
])("refuses a discovery rule that cannot list the final agent alone: %j", async (rules) => {
  if (rules.pool) await fixture(path.join(home, "pool", "existing"));
  await config(rules);
  const res = await create(body("Alpha"));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "discovery_refused", message: "The discovery rules do not allow this agent." });
  await expectNoWrite();
  expect(await list()).toEqual([]);
});


it("writes model instructions from the agent name and purpose", async () => {
  reply = (res) => sendModelText(res, "# Duties\n\nSort the tasks.");
  const input = { ...body("Planner"), purpose: "Sort tasks by date." };
  const res = await create(input);
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ id: "planner", instructions: "model" });
  expect(providerCalls).toHaveLength(1);
  expect(providerCalls[0]).toContain("Planner");
  expect(providerCalls[0]).toContain("Sort tasks by date.");
  expect(await fs.readFile(path.join(dir("planner"), "AGENTS.md"), "utf8")).toBe("# Duties\n\nSort the tasks.\n");
  expect(await fs.readFile(path.join(dir("planner"), "agent.yaml"), "utf8")).not.toContain("system_files");
  expect(await (await create(input)).json()).toEqual({ id: "planner", instructions: "model" });
  expect(providerCalls).toHaveLength(1);
});

it.each(["empty", "failure", "timeout"])("uses the template when the model returns %s", async (outcome) => {
  const closed = deferred();
  if (outcome === "failure") reply = (res) => { res.writeHead(400); res.end("Fake provider detail."); };
  if (outcome === "timeout") {
    const wait = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => wait(ms === 30_000 ? 80 : ms));
    reply = (res) => { res.on("close", closed.resolve); };
  }
  const res = await create({ ...body("Planner"), purpose: "Sort tasks by date." });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ id: "planner", instructions: "template" });
  expect(providerCalls).toHaveLength(1);
  expect(await fs.readFile(path.join(dir("planner"), "AGENTS.md"), "utf8")).toContain("Your purpose is: Sort tasks by date.");
  if (outcome === "timeout") await closed.promise;
});

it("creates a second agent while the first model call waits", async () => {
  const entered = deferred();
  let pending: ServerResponse | undefined;
  reply = (res, prompt) => {
    if (prompt.includes("Slow Agent")) { pending = res; entered.resolve(); }
    else sendModelText(res, "# Instructions");
  };
  const first = create(body("Slow Agent"));
  await entered.promise;
  try {
    const second = await create(body("Fast Agent"));
    expect(second.status).toBe(201);
    expect(await list()).toEqual([expect.objectContaining({ id: "fast-agent" })]);
  } finally {
    if (pending) sendModelText(pending, "# Instructions");
  }
  expect((await first).status).toBe(201);
  expect((await list()).map(({ id }: { id: string }) => id)).toEqual(["fast-agent", "slow-agent"]);
});
