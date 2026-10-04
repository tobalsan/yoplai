import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Extension, ExtensionAgentToolContext } from "@yoplai/shared";

const require = createRequire(import.meta.url);
let root: string | undefined;
const previousHome = process.env.YOPLAI_HOME;
afterEach(async () => {
  if (previousHome === undefined) delete process.env.YOPLAI_HOME;
  else process.env.YOPLAI_HOME = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  vi.resetModules();
});

it("uses host credential hooks from a genuinely discovered file-URL extension", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "yoplai-connect-external-"));
  process.env.YOPLAI_HOME = root;
  vi.resetModules();
  const { writeTestV3Config } = await import("../test-utils/v3-config.js");
  await writeTestV3Config(root, { agents: [{ id: "sales" }] });
  const directory = path.join(root, "extensions", "fixture");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(directory, "index.js"), `
    import { z } from ${JSON.stringify(pathToFileURL(require.resolve("zod")).href)};
    let host, unregister, completion;
    export default {
      id: "fixture", displayName: "Fixture", description: "External connector",
      dependencies: [], configSchema: z.object({}), routePrefixes: [],
      validateConfig: () => ({ valid: true, errors: [] }),
      registerRoutes() {}, capabilities: () => [],
      async start(ctx) {
        host = ctx.credentialConnect;
        unregister = host.registerOAuthConnector("fixture", async options => {
          completion = options.onComplete;
          return "https://provider.test/" + options.targetId;
        });
      },
      async stop() { unregister(); },
      request(context, target) { return host.requestLink(context, target); },
      foreign() { return host.registerOAuthConnector("other", async () => "foreign"); },
      complete(targetId) { return completion(targetId); }
    };
  `);
  const { discoverExternalExtensions, registerCredentialConnectLinkProvider } = await import("@yoplai/shared");
  const { bindExtensionContext, createExtensionContext } = await import("./context.js");
  const { getAgent, loadConfig } = await import("../config/index.js");
  const config = loadConfig();
  const discovered = await discoverExternalExtensions(path.join(root, "extensions"));
  expect(discovered).toHaveLength(1);
  const extension = discovered[0].extension as Extension & {
    request(context: ExtensionAgentToolContext, target: { kind: "extension-oauth"; extensionId: string; targetId: string }): Promise<string>;
    foreign(): void;
    complete(targetId: string): Promise<void>;
  };
  const context = createExtensionContext(config);
  const target = { kind: "extension-oauth" as const, extensionId: "fixture", targetId: "server-a" };
  const agent = getAgent("sales");
  expect(agent).toBeDefined();
  const toolContext: ExtensionAgentToolContext = { agent: agent!, config };
  const provider = vi.fn(async () => "https://gateway.test/connect/link");
  const unregisterProvider = registerCredentialConnectLinkProvider(provider);
  await extension.start(bindExtensionContext(context, extension.id));
  try {
    expect(extension.foreign).toThrow("only register its own");
    await expect(extension.request(toolContext, target)).resolves.toBe("https://gateway.test/connect/link");
    expect(provider).toHaveBeenCalledWith(toolContext, target);
    const onComplete = vi.fn(async () => {});
    await expect(context.credentialConnect!.start(target, { agentId: "sales", userId: "alice", onComplete })).resolves.toBe("https://provider.test/server-a");
    await expect(extension.complete("server-b")).rejects.toThrow("target ID does not match");
    expect(onComplete).not.toHaveBeenCalled();
    await extension.complete("server-a");
    expect(onComplete).toHaveBeenCalledOnce();
  } finally {
    await extension.stop();
    unregisterProvider();
  }
  await expect(context.credentialConnect!.start(target, { agentId: "sales", userId: "alice", onComplete: async () => {} })).rejects.toThrow("does not support");
});
