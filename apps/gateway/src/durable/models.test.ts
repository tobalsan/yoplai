import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubDesktopTestEnv } from "../test-utils/desktop-test-env.js";

let root: string;
let home: string;
const modelId = "gpt-6.2-sol";

beforeEach(async () => {
  vi.resetModules();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "durable-model-auth-"));
  home = path.join(root, "yoplai");
  await fs.mkdir(path.join(home, "agents", "test"), { recursive: true });
  await fs.writeFile(path.join(home, "yoplai.json"), JSON.stringify({ version: 3, agents: "agents/*" }));
  stubDesktopTestEnv(root, home);
  const { configureRelay } = await import("../relay/state.js");
  configureRelay("127.0.0.1", false);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function codexAgent(source: "codex" | "pi", expiresInSeconds = 60) {
  const accountId = "fixture-account";
  const payload = { exp: Math.floor(Date.now() / 1000) + expiresInSeconds, "https://api.openai.com/auth": { chatgpt_account_id: accountId } };
  const token = `fake.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
  const file = path.join(root, source === "codex" ? ".codex/auth.json" : ".pi/agent/auth.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(source === "codex"
    ? { tokens: { access_token: token, account_id: accountId } }
    : { "openai-codex": { type: "oauth", access: token, accountId } }));
  await fs.writeFile(path.join(home, "desktop-model-sources.json"), JSON.stringify({ [source]: "enabled" }));
  await fs.writeFile(path.join(home, "agents/test/agent.yaml"), [
    "id: test", "name: Test", "model:", "  provider: openai-codex",
    `  model: ${modelId}`, `  source: ${source}`, "system: Reply briefly.",
  ].join("\n"));
  const { getAgent } = await import("../config/index.js");
  const { createDurableModels } = await import("./models.js");
  const models = createDurableModels(getAgent("test")!, async () => undefined);
  const model = models.getModel("openai-codex", modelId)!;
  return { models, model, token };
}

it.each(["codex", "pi"] as const)("streams a reply over SSE with the %s Codex login", async (source) => {
  const { models, model, token } = await codexAgent(source);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response([
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_fixture","role":"assistant","content":[]}}',
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"Desktop reply"}',
    'data: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed"}}',
  ].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } }));
  const result = await models.streamSimple(model, {
    messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
  }, { fetch, transport: "websocket" }).result();
  expect(result.stopReason, result.errorMessage).toBe("stop");
  expect(result.content).toMatchObject([{ type: "text", text: "Desktop reply" }]);
  expect(fetch.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`Bearer ${token}`);
});

it("reports a provider-rejected Codex login from the HTTP status", async () => {
  const { models, model } = await codexAgent("codex");
  const onResponse = vi.fn();
  const result = await models.streamSimple(model, { messages: [] }, {
    fetch: async () => new Response('{"error":{"message":"Provider fixture error"}}', { status: 401 }),
    onResponse,
  }).result();
  expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }), expect.objectContaining({ id: modelId }));
  expect(result).toMatchObject({
    stopReason: "error",
    errorMessage: "Your Codex login expired. Open Codex once, or sign in here.",
  });
});

it("refuses a locally expired Codex login before contacting the provider", async () => {
  const { models, model } = await codexAgent("codex", -60);
  const fetch = vi.fn<typeof globalThis.fetch>();
  const result = await models.streamSimple(model, { messages: [] }, { fetch }).result();
  expect(result).toMatchObject({
    stopReason: "error",
    errorMessage: "Codex CLI login is not available. Sign in again or pick another source.",
  });
  expect(fetch).not.toHaveBeenCalled();
});
