import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Extension } from "@yoplai/shared";

let home: string;
let previousHome: string | undefined;
const revokers: Array<() => void> = [];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "script-tool-token-"));
  previousHome = process.env.YOPLAI_HOME;
  process.env.YOPLAI_HOME = home;
  vi.resetModules();
  const { writeTestV3Config } = await import("../test-utils/v3-config.js");
  await writeTestV3Config(home, {
    agents: [{ id: "alpha", extraYaml: "extensions:\n  probe:\n    enabled: true" }],
    extensions: {
      probe: { apiToken: "team-fixture" },
      multiUser: { enabled: true, sessionSecret: "fixture-session-secret-at-least-32-characters", emailAndPassword: { enabled: true } },
    },
    extraConfig: { oauth: { encryptionKey: "fixture-encryption-key" } },
  });
});

afterEach(async () => {
  for (const revoke of revokers.splice(0)) revoke();
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.YOPLAI_HOME;
  else process.env.YOPLAI_HOME = previousHome;
  await fs.rm(home, { recursive: true, force: true });
});

async function fixture() {
  const { loadConfig } = await import("../config/index.js");
  const { createExtensionContext } = await import("./context.js");
  const { createInternalTools } = await import("../server/internal-tools.js");
  const config = loadConfig();
  const ctx = createExtensionContext(config);
  const mint = (userId?: string) => {
    const minted = ctx.mintToolToken!({ agentId: "alpha", userId, sessionId: "scheduler:job:run", runId: "run" });
    revokers.push(minted.revoke);
    return minted;
  };
  return { config, createInternalTools, mint };
}

function post(app: { request(input: string, init: RequestInit): Response | Promise<Response> }, token: string, agentId = "alpha") {
  return Promise.resolve(app.request("/tools", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "probe_read", args: {}, agentId, agentToken: token, sessionId: "scheduler:job:run", runId: "run" }),
  }));
}

it("forwards minted owner identity, refuses cross-agent use and refuses calls after revocation", async () => {
  const { config, createInternalTools, mint } = await fixture();
  const executeExtensionTool = vi.fn().mockResolvedValue({ found: true, result: { tickets: [] } });
  const app = createInternalTools({ getConfig: () => config, getRuntime: () => undefined as never, executeExtensionTool });
  const minted = mint("alice");
  const response = await post(app, minted.token);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ tickets: [] });
  expect(executeExtensionTool.mock.calls[0]?.[6]).toBe("alice");
  expect(executeExtensionTool.mock.calls[0]?.[9]).toMatchObject({ actorKind: "service" });
  expect((await post(app, minted.token, "other")).status).toBe(403);
  minted.revoke();
  expect((await post(app, minted.token)).status).toBe(403);
  expect(executeExtensionTool).toHaveBeenCalledOnce();
});

it("answers an in-flight call as cancelled and discards its late result after revocation", async () => {
  const { config, createInternalTools, mint } = await fixture();
  let finish!: (value: { found: boolean; result: string }) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const executeExtensionTool = vi.fn(() => {
    entered();
    return new Promise<{ found: boolean; result: string }>((resolve) => { finish = resolve; });
  });
  const app = createInternalTools({ getConfig: () => config, getRuntime: () => undefined as never, executeExtensionTool });
  const minted = mint("alice");
  const pending = post(app, minted.token);
  await started;
  minted.revoke();
  const response = await pending;
  expect(response.status).toBe(409);
  finish({ found: true, result: "late-secret-result" });
  await Promise.resolve();
  expect(await response.json()).toEqual({ error: "run cancelled" });
  expect((await post(app, minted.token)).status).toBe(403);
});

it("resolves the owner's personal secret and only team secrets for a team token through the real runtime", async () => {
  const { config, createInternalTools, mint } = await fixture();
  const { ExtensionRuntime } = await import("./runtime.js");
  const { CredentialStore } = await import("../credentials/store.js");
  const { storePersonalExtensionTokens } = await import("../credentials/extension-tokens.js");
  const store = new CredentialStore();
  storePersonalExtensionTokens(store, "alice", "probe", { apiToken: "alice-fixture" });
  const extension: Extension = {
    id: "probe", displayName: "Probe", description: "Credential probe", dependencies: [], routePrefixes: [],
    configSchema: z.object({}), requiredSecrets: ["apiToken"],
    validateConfig: () => ({ valid: true, errors: [] }),
    registerRoutes: () => undefined, start: async () => undefined, stop: async () => undefined, capabilities: () => [],
    getAgentTools(agent, context) {
      const resolved = { ...context?.config.extensions?.probe as Record<string, unknown>, ...agent.extensions?.probe };
      return [{
        name: "probe_read", description: "Read with the resolved secret", parameters: { type: "object" },
        execute: async (_args, call) => ({ credential: resolved.apiToken, actorKind: call.actorKind, actorUserId: call.actorUserId ?? null }),
      }];
    },
  };
  const runtime = new ExtensionRuntime();
  runtime.load([extension]);
  const app = createInternalTools({ getConfig: () => config, getRuntime: () => runtime });
  const owner = mint("alice");
  const team = mint();
  const ownerResponse = await post(app, owner.token);
  expect(ownerResponse.status).toBe(200);
  expect(await ownerResponse.json()).toEqual({ credential: "alice-fixture", actorKind: "service", actorUserId: null });
  const teamResponse = await post(app, team.token);
  expect(teamResponse.status).toBe(200);
  expect(await teamResponse.json()).toEqual({ credential: "team-fixture", actorKind: "service", actorUserId: null });
  delete config.extensions?.probe;
  const missingTeam = await post(app, team.token);
  expect(missingTeam.status).toBe(200);
  expect(await missingTeam.json()).toMatchObject({ error: "extension_credentials_required" });
  const stillPersonal = await post(app, owner.token);
  expect(await stillPersonal.json()).toEqual({ credential: "alice-fixture", actorKind: "service", actorUserId: null });
});
