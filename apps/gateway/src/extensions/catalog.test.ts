import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayConfigSchema, type AgentConfig } from "@yoplai/shared";
import {
  buildExtensionCatalog,
  resolveExtensionDefinition,
} from "./catalog.js";
import { getBuiltInExtensionRegistrations } from "./registry.js";

const require = createRequire(import.meta.url);
const zodUrl = pathToFileURL(require.resolve("zod")).href;

/** Write a valid external extension dir with an index.js under `root/id`. */
async function writeExternalExtension(
  root: string,
  id: string,
  body: {
    routePrefixes?: string;
    configSchema?: string;
    configJsonSchema?: string;
    requiredSecrets?: string;
    advancedConfigFields?: string;
    configRoute?: string;
    factory?: boolean;
    validateAgentConfig?: string;
  } = {}
): Promise<void> {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ type: "module" })
  );
  await writeFile(
    path.join(dir, "index.js"),
    [
      `import { z } from ${JSON.stringify(zodUrl)};`,
      "export default {",
      `  id: ${JSON.stringify(id)},`,
      `  displayName: ${JSON.stringify(`Ext ${id}`)},`,
      `  description: ${JSON.stringify(`Extension ${id}`)},`,
      "  dependencies: [],",
      `  configSchema: ${body.configSchema ?? "z.object({})"},`,
      body.configJsonSchema
        ? `  configJsonSchema: ${body.configJsonSchema},`
        : "",
      body.requiredSecrets ? `  requiredSecrets: ${body.requiredSecrets},` : "",
      body.advancedConfigFields
        ? `  advancedConfigFields: ${body.advancedConfigFields},`
        : "",
      body.configRoute ? `  configRoute: ${body.configRoute},` : "",
      body.validateAgentConfig
        ? `  validateAgentConfig: ${body.validateAgentConfig},`
        : "",
      body.factory !== undefined ? `  factory: ${body.factory},` : "",
      `  routePrefixes: ${body.routePrefixes ?? "[]"},`,
      "  validateConfig: () => ({ valid: true, errors: [] }),",
      "  registerRoutes: () => undefined,",
      "  start: async () => undefined,",
      "  stop: async () => undefined,",
      "  capabilities: () => [],",
      "};",
    ]
      .filter(Boolean)
      .join("\n")
  );
}

function makeAgent(
  extensions?: Record<string, Record<string, unknown>>,
  rootConfig?: Record<string, unknown>
): AgentConfig {
  return GatewayConfigSchema.parse({
    version: 2,
    agents: [
      {
        id: "main",
        name: "Main",
        workspace: "~/agents/main",
        model: { provider: "anthropic", model: "claude" },
        ...(extensions ? { extensions } : {}),
        ...rootConfig,
      },
    ],
    extensions: {},
  }).agents[0];
}

function configWith(agent: AgentConfig, extensionsPath: string) {
  return GatewayConfigSchema.parse({
    version: 2,
    agents: [agent],
    extensions: {},
    extensionsPath,
  });
}

describe("buildExtensionCatalog", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "yoplai-catalog-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists the full built-in registry with no ghosts and no missing ids", async () => {
    const agent = makeAgent();
    const catalog = await buildExtensionCatalog(configWith(agent, root), agent);

    const builtInIds = catalog
      .filter((entry) => entry.builtIn)
      .map((entry) => entry.id)
      .sort();

    // Every built-in that loads in this deployment must appear exactly once,
    // except factory extensions, which the catalog builder deliberately hides.
    const registrations = getBuiltInExtensionRegistrations();
    const loadable: string[] = [];
    for (const registration of registrations) {
      try {
        const ext = await registration.load();
        if (!ext.factory) loadable.push(ext.id);
      } catch {
        // package not installed here — must NOT be in the catalog
      }
    }
    expect(builtInIds).toEqual([...loadable].sort());

    // No duplicate ids across the whole catalog.
    const allIds = catalog.map((entry) => entry.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("includes runtime-scanned external extensions alongside built-ins", async () => {
    await writeExternalExtension(root, "acme-tool");
    const agent = makeAgent();
    const catalog = await buildExtensionCatalog(configWith(agent, root), agent);

    const acme = catalog.find((entry) => entry.id === "acme-tool");
    expect(acme).toBeDefined();
    expect(acme?.builtIn).toBe(false);
    // built-ins still present
    expect(catalog.some((entry) => entry.builtIn)).toBe(true);
  });

  it("reports per-agent enabled state correctly", async () => {
    await writeExternalExtension(root, "on-ext");
    await writeExternalExtension(root, "off-ext");
    await writeExternalExtension(root, "absent-ext");

    const agent = makeAgent({
      "on-ext": { enabled: true },
      "off-ext": { enabled: false },
      // absent-ext: not referenced by the agent at all
    });
    const catalog = await buildExtensionCatalog(configWith(agent, root), agent);

    const byId = Object.fromEntries(catalog.map((e) => [e.id, e]));
    expect(byId["on-ext"].enabled).toBe(true);
    expect(byId["off-ext"].enabled).toBe(false);
    // Not referenced by the agent → disabled for this agent, but still listed.
    expect(byId["absent-ext"].enabled).toBe(false);
  });

  it("marks entries not configurable when no writable fork backs them", async () => {
    await writeExternalExtension(root, "acme-tool");
    const agent = makeAgent();
    const catalog = await buildExtensionCatalog(
      configWith(agent, root),
      agent,
      {
        configurable: false,
      }
    );

    expect(
      catalog.find((entry) => entry.id === "acme-tool")?.configurable
    ).toBe(false);
  });

  it("treats a present-but-empty agent config as enabled (enabled defaults true)", async () => {
    await writeExternalExtension(root, "bare-ext");
    const agent = makeAgent({ "bare-ext": {} });
    const catalog = await buildExtensionCatalog(configWith(agent, root), agent);
    const bare = catalog.find((e) => e.id === "bare-ext");
    expect(bare?.enabled).toBe(true);
  });

  it("reports root-configured stock extensions as enabled and managed", async () => {
    const agent = makeAgent(undefined, {
      slack: { token: "x", appToken: "x" },
    });
    const catalog = await buildExtensionCatalog(configWith(agent, root), agent);
    const slack = catalog.find((entry) => entry.id === "slack");

    expect(slack).toMatchObject({ enabled: true, managedAtRoot: true });
  });

  it("gives explicit agent extension config precedence over root config", async () => {
    const disabled = makeAgent(
      { slack: { enabled: false } },
      { slack: { token: "x", appToken: "x" } }
    );
    const enabled = makeAgent(
      { slack: {} },
      { slack: { token: "x", appToken: "x" } }
    );

    const disabledEntry = (await buildExtensionCatalog(configWith(disabled, root), disabled)).find(
      (entry) => entry.id === "slack"
    );
    const enabledEntry = (await buildExtensionCatalog(configWith(enabled, root), enabled)).find(
      (entry) => entry.id === "slack"
    );

    expect(disabledEntry).toMatchObject({ enabled: false, managedAtRoot: false });
    expect(enabledEntry).toMatchObject({ enabled: true, managedAtRoot: false });
  });

  it("requires non-empty root config and ignores extensions without root keys", async () => {
    await writeExternalExtension(root, "no-root");
    const emptyWebhooks = makeAgent(undefined, { webhooks: {} });
    const populatedWebhooks = makeAgent(undefined, {
      webhooks: { incoming: { prompt: "hello" } },
    });
    const neither = makeAgent();

    const emptyEntry = (await buildExtensionCatalog(
      configWith(emptyWebhooks, root),
      emptyWebhooks
    )).find((entry) => entry.id === "webhooks");
    const populatedEntry = (await buildExtensionCatalog(
      configWith(populatedWebhooks, root),
      populatedWebhooks
    )).find((entry) => entry.id === "webhooks");
    const noRootEntry = (await buildExtensionCatalog(configWith(neither, root), neither)).find(
      (entry) => entry.id === "no-root"
    );

    expect(emptyEntry).toMatchObject({ enabled: false, managedAtRoot: false });
    expect(populatedEntry).toMatchObject({ enabled: true, managedAtRoot: true });
    expect(noRootEntry).toMatchObject({ enabled: false, managedAtRoot: false });
  });

  it("assigns tiers: bespoke-route > auto-form > toggle-only", async () => {
    // Self-registered agent-keyed config route → bespoke-route, even with a
    // schema. Backend routePrefixes (API routes) do NOT make it bespoke — only
    // a declared configRoute (config UI surface) does.
    await writeExternalExtension(root, "routed", {
      configRoute: '{ path: "/agents/:agentId/extensions/routed" }',
      routePrefixes: '["/api/routed"]',
      configJsonSchema:
        '{ type: "object", properties: { apiKey: { type: "string" } } }',
    });
    // Backend API routePrefixes but NO configRoute and no schema → toggle-only
    // (owning an API route is not owning a config surface).
    await writeExternalExtension(root, "api-only", {
      routePrefixes: '["/api/api-only"]',
    });
    // Schema-having, no route → auto-form.
    await writeExternalExtension(root, "formy", {
      configJsonSchema:
        '{ type: "object", properties: { apiKey: { type: "string" } } }',
    });
    // No route, only an enabled toggle in schema → toggle-only.
    await writeExternalExtension(root, "toggly", {
      configJsonSchema:
        '{ type: "object", properties: { enabled: { type: "boolean" } } }',
    });
    // No route, no config schema → toggle-only.
    await writeExternalExtension(root, "plain");

    const agent = makeAgent();
    const catalog = await buildExtensionCatalog(configWith(agent, root), agent);
    const byId = Object.fromEntries(catalog.map((e) => [e.id, e]));

    expect(byId["routed"].tier).toBe("bespoke-route");
    expect(byId["routed"].configRoutePath).toBe(
      "/agents/main/extensions/routed"
    );
    expect(byId["api-only"].tier).toBe("toggle-only");
    expect(byId["api-only"].configRoutePath).toBeNull();
    expect(byId["formy"].tier).toBe("auto-form");
    expect(byId["formy"].configRoutePath).toBeNull();
    expect(byId["toggly"].tier).toBe("toggle-only");
    expect(byId["plain"].tier).toBe("toggle-only");
  });

  it("resolves the agent-keyed configRoute :agentId param per agent", async () => {
    await writeExternalExtension(root, "bespoke", {
      configRoute: '{ path: "/agents/:agentId/extensions/bespoke" }',
    });
    const agent = makeAgent();
    const catalog = await buildExtensionCatalog(configWith(agent, root), agent);
    const entry = catalog.find((e) => e.id === "bespoke");
    expect(entry?.tier).toBe("bespoke-route");
    expect(entry?.configRoutePath).toBe("/agents/main/extensions/bespoke");
  });

  it("surfaces configJsonSchema and requiredSecrets when the extension exposes them", async () => {
    await writeExternalExtension(root, "secretful", {
      configJsonSchema:
        '{ type: "object", properties: { token: { type: "string" } } }',
      requiredSecrets: '["token"]',
      advancedConfigFields: '["timeoutMs"]',
    });
    const agent = makeAgent();
    const catalog = await buildExtensionCatalog(configWith(agent, root), agent);
    const entry = catalog.find((e) => e.id === "secretful");

    expect(entry?.requiredSecrets).toEqual(["token"]);
    expect(entry?.advancedConfigFields).toEqual(["timeoutMs"]);
    expect(entry?.configJsonSchema).toMatchObject({
      properties: { token: { type: "string" } },
    });
    expect(entry?.tier).toBe("auto-form");
  });

  it("surfaces current config values with secrets redacted", async () => {
    await writeExternalExtension(root, "configured", {
      configJsonSchema:
        '{ type: "object", properties: { apiKey: { type: "string" }, region: { type: "string" } } }',
      requiredSecrets: '["apiKey"]',
    });
    const agent = makeAgent({
      configured: {
        enabled: true,
        apiKey: "$env:CONFIGURED_API_KEY",
        region: "eu",
      },
    });
    const catalog = await buildExtensionCatalog(configWith(agent, root), agent);
    const entry = catalog.find((e) => e.id === "configured");

    expect(entry?.configValues).toEqual({
      apiKey: "********",
      region: "eu",
    });
  });

  it("reports missing configuration fields without exposing values", async () => {
    await writeExternalExtension(root, "cloudifi-admin", {
      requiredSecrets: '["username", "password"]',
      validateAgentConfig: `(agent) => {
        const value = agent.extensions?.["cloudifi-admin"] ?? {};
        const missing = ["username", "password"].filter((field) => typeof value[field] !== "string" || value[field].length === 0);
        return { valid: missing.length === 0, errors: missing };
      }`,
    });
    const unconfigured = makeAgent({ "cloudifi-admin": { enabled: true } });
    const unconfiguredCatalog = await buildExtensionCatalog(
      configWith(unconfigured, root),
      unconfigured
    );
    const entry = unconfiguredCatalog.find((e) => e.id === "cloudifi-admin");

    expect(entry).toMatchObject({
      enabled: true,
      configured: false,
      missingConfig: ["username", "password"],
    });
    expect(entry?.missingConfig).not.toContain("secret-value");

    const configured = makeAgent({
      "cloudifi-admin": {
        enabled: true,
        username: "secret-value",
        password: "another-secret-value",
      },
    });
    const configuredCatalog = await buildExtensionCatalog(
      configWith(configured, root),
      configured
    );
    expect(
      configuredCatalog.find((e) => e.id === "cloudifi-admin")
    ).toMatchObject({
      enabled: true,
      configured: true,
      missingConfig: [],
    });
  });

  it("produces no external entries when the scan dir does not exist (no ghosts)", async () => {
    const missing = path.join(root, "does-not-exist");
    const agent = makeAgent();
    const catalog = await buildExtensionCatalog(
      configWith(agent, missing),
      agent
    );
    expect(catalog.every((entry) => entry.builtIn)).toBe(true);
  });

  it("hides factory extensions from the catalog", async () => {
    await writeExternalExtension(root, "internal-tool", { factory: true });
    await writeExternalExtension(root, "visible-tool");
    const agent = makeAgent();
    const catalog = await buildExtensionCatalog(configWith(agent, root), agent);

    expect(catalog.find((e) => e.id === "internal-tool")).toBeUndefined();
    expect(catalog.find((e) => e.id === "visible-tool")).toBeDefined();
  });

  it("still resolves a factory extension's definition directly (for the PATCH guard)", async () => {
    await writeExternalExtension(root, "internal-tool", { factory: true });
    const config = configWith(makeAgent(), root);

    const resolved = await resolveExtensionDefinition(config, "internal-tool");
    expect(resolved?.factory).toBe(true);

    const missing = await resolveExtensionDefinition(config, "nope");
    expect(missing).toBeUndefined();
  });

  it("inlines an external extension's icon.svg as a data URI", async () => {
    await writeExternalExtension(root, "iconic");
    await writeFile(
      path.join(root, "iconic", "icon.svg"),
      "<svg><circle/></svg>"
    );
    const agent = makeAgent();
    const catalog = await buildExtensionCatalog(configWith(agent, root), agent);
    const entry = catalog.find((e) => e.id === "iconic");

    expect(entry?.iconDataUri).toBe(
      `data:image/svg+xml;base64,${Buffer.from("<svg><circle/></svg>").toString(
        "base64"
      )}`
    );
  });

  it("leaves iconDataUri undefined when no icon file is present", async () => {
    await writeExternalExtension(root, "no-icon");
    const agent = makeAgent();
    const catalog = await buildExtensionCatalog(configWith(agent, root), agent);
    const entry = catalog.find((e) => e.id === "no-icon");

    expect(entry?.iconDataUri).toBeUndefined();
  });

  it("resolves a built-in package's real directory via ESM resolution", () => {
    // Regression test: the old implementation used `require.resolve`, which
    // throws ERR_PACKAGE_PATH_NOT_EXPORTED against these packages' ESM-only
    // `exports` maps (no `require`/`default` condition) — so it always
    // returned undefined and built-ins never got an icon.
    //
    // This must run in a real Node process rather than through vitest's
    // module runner: vite-node's synthetic `import.meta` only carries
    // `url`/`env`/`filename`/`dirname` and has no `resolve`, so calling
    // `resolveBuiltInExtensionDir` in-process would always see
    // `import.meta.resolve` as undefined regardless of the implementation.
    const catalogUrl = new URL("./catalog.ts", import.meta.url).href;
    const script = [
      `import { resolveBuiltInExtensionDir, resolveIconDataUri } from ${JSON.stringify(catalogUrl)};`,
      'const dir = resolveBuiltInExtensionDir("@yoplai/extension-discord");',
      "process.stdout.write(JSON.stringify({ dir, iconDataUri: resolveIconDataUri(dir) }));",
    ].join("\n");
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { encoding: "utf8" }
    );
    const { dir, iconDataUri } = JSON.parse(output) as {
      dir: string | undefined;
      iconDataUri: string | undefined;
    };

    expect(dir).toBeDefined();
    expect(existsSync(dir as string)).toBe(true);
    expect(existsSync(path.join(dir as string, "package.json"))).toBe(true);

    // packages/extensions/discord/icon.svg is committed, so the resolved dir
    // should be the package root, not some nested src/dist subdirectory.
    expect(iconDataUri).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});
