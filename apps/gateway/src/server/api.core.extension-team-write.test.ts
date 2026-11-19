import fs from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { writeTestV3Config } from "../test-utils/v3-config.js";

const agentId = "sample-agent";
const settingsId = "sample-settings";
const connectionId = "sample-connection";
const catalogPath = `/api/agents/${agentId}/extensions`;

// ALG-724 Testing Decisions and Thinh's Groom GO approve the HTTP seam.
// Exercise requester access, catalog responses and persisted agent settings.
describe("team extension settings over HTTP", () => {
  let home: string;
  let server: ReturnType<typeof import("./index.js").startServer>;
  let stopAuth: (() => Promise<void>) | undefined;
  let origin: string;
  let member: string;
  let manager: string;

  const readAgentYaml = () => fs.readFile(path.join(home, "agents", agentId, "agent.yaml"), "utf8");
  const getCatalog = (cookie: string) => fetch(`${origin}${catalogPath}`, { headers: { Cookie: cookie } });
  const patch = (cookie: string, extensionId: string, body: unknown) => fetch(`${origin}${catalogPath}/${extensionId}`, {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  async function writeExtension(id: string, fields: Record<string, unknown>) {
    const dir = path.join(home, "extensions", id);
    const zod = createRequire(import.meta.url).resolve("zod");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "index.js"), `
      const { z } = require(${JSON.stringify(zod)});
      module.exports = {
        id: ${JSON.stringify(id)}, displayName: ${JSON.stringify(id)}, description: "Fixture",
        configSchema: z.object({}).passthrough(), dependencies: [], routePrefixes: [],
        configJsonSchema: ${JSON.stringify({ type: "object", properties: fields })},
        validateConfig: () => ({ valid: true, errors: [] }),
        registerRoutes() {}, async start() {}, async stop() {}, capabilities: () => [],
      };
    `);
  }

  async function signup(name: string, role: string) {
    const response = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email: `${name}@example.test`, password: "sample-fixture-password" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { role } });
    const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    expect(cookie).not.toBe("");
    return cookie;
  }

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-team-settings-"));
    vi.stubEnv("YOPLAI_HOME", home);
    vi.stubEnv("YOPLAI_GATEWAY_PORT", process.env.YOPLAI_GATEWAY_PORT);
    await writeTestV3Config(home, {
      agents: [{ id: agentId, extraYaml: `
extensions:
  sample-settings:
    label: Original label
  sample-connection:
    enabled: true` }],
      extensions: {
        multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: "sample-auth-fixture-session-secret" },
      },
      extraConfig: { oauth: { encryptionKey: "sample-fixture-encryption-key" } },
    });
    await writeExtension(settingsId, { label: { type: "string" } });
    await writeExtension(connectionId, { token: { type: "string", writeOnly: true }, label: { type: "string" } });

    vi.resetModules();
    const { loadConfig } = await import("../config/index.js");
    const { createExtensionContext } = await import("../extensions/context.js");
    const { getExtensionRuntime } = await import("../extensions/registry.js");
    const { multiUserExtension } = await import("@yoplai/extension-multi-user");
    const { api } = await import("./api.core.js");
    const { startServer } = await import("./index.js");
    await multiUserExtension.start(createExtensionContext(loadConfig()));
    stopAuth = () => multiUserExtension.stop();
    getExtensionRuntime().load([multiUserExtension]);
    multiUserExtension.registerRoutes(api);
    server = startServer(0, "127.0.0.1");
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.once("listening", resolve);
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    manager = await signup("manager", "superadmin");
    member = await signup("member", "user");
  }, 30_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await stopAuth?.();
    vi.unstubAllEnvs();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  it("includes team permission on every catalog entry the member can view", async () => {
    const response = await getCatalog(member);
    expect(response.status).toBe(200);
    const { extensions } = await response.json();
    expect(extensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: settingsId, configValues: { label: "Original label" } }),
      expect.objectContaining({ id: connectionId }),
    ]));
    const writableOrMissing = extensions.filter((entry: { canConfigureTeam?: boolean }) => entry.canConfigureTeam !== false);
    expect(writableOrMissing).toHaveLength(0);
  });

  it("rejects a chat member's team settings and toggle without changing agent.yaml", async () => {
    const before = await readAgentYaml();
    for (const body of [{ config: { label: "Edited label" } }, { enabled: false }]) {
      const response = await patch(member, settingsId, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "team_requires_admin" });
    }
    expect(await readAgentYaml()).toBe(before);
  });

  it.each([
    { extensionId: settingsId, config: { label: "$env:" }, field: "label" },
    { extensionId: settingsId, config: { groups: [{ label: "$env:" }] }, field: "groups[0].label" },
    { extensionId: connectionId, config: { token: "$env:" }, field: "token" },
  ])("rejects a reserved environment reference in $field before writing", async ({ extensionId, config, field }) => {
    const before = await readAgentYaml();
    const response = await patch(manager, extensionId, { config });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining(field) });
    expect(await readAgentYaml()).toBe(before);
  });

  it("rejects undeclared team credentials without writing to agent.yaml", async () => {
    const before = await readAgentYaml();
    const response = await patch(manager, connectionId, { secrets: { otherField: "sample-value" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining("otherField") });
    expect(await readAgentYaml()).toBe(before);
  });

  it("stores a declared team credential as a reference and masks it in the catalog", async () => {
    expect((await patch(manager, connectionId, { secrets: { token: "sample-team-token" } })).status).toBe(200);
    const yaml = await readAgentYaml();
    expect(parse(yaml)).toMatchObject({ extensions: { [connectionId]: { token: "$env:SAMPLE_CONNECTION_TOKEN" } } });
    expect(yaml).not.toContain("sample-team-token");
    const catalog = await getCatalog(manager);
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({ extensions: expect.arrayContaining([
      expect.objectContaining({ id: connectionId, canConfigureTeam: true, configValues: { token: "********" } }),
    ]) });
  });

  it("lets the manager update and toggle a settings-only extension", async () => {
    expect((await patch(manager, settingsId, { config: { label: "Manager label" } })).status).toBe(200);
    expect((await patch(manager, settingsId, { enabled: false })).status).toBe(200);
    expect(parse(await readAgentYaml())).toMatchObject({ extensions: { [settingsId]: { enabled: false, label: "Manager label" } } });
  });

  it("lets a member save personal settings and still rejects environment references in them", async () => {
    const credentialScope = "personal";
    const before = await readAgentYaml();
    const valid = await patch(member, connectionId, { credentialScope, config: { label: "Personal label" }, secrets: { token: "sample-personal-token" } });
    expect(valid.status).toBe(200);
    const invalid = await patch(member, connectionId, { credentialScope, config: { label: "$env:" } });
    expect(invalid.status).toBe(400);
    const catalog = await getCatalog(member);
    expect(await catalog.json()).toMatchObject({ extensions: expect.arrayContaining([
      expect.objectContaining({ id: connectionId, personalConfigValues: { label: "Personal label" }, personalSecretFields: ["token"] }),
    ]) });
    expect(await readAgentYaml()).toBe(before);
  });
});
