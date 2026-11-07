import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { updateAgentExtensionConfig } from "./agent-config-writer.js";

let home: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

// ALG-663's published Testing Decisions, approved by Thinh's Groom: GO,
// cover writer -> disk -> loader -> registry, without bot networking.
it("loads Mattermost after saving agent settings and resolves its agent-local token at startup", async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "yoplai-channel-restart-"));
  const workspace = path.join(home, "agents", "sales");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "agent.yaml"), [
    "id: sales",
    "name: Sales",
    "model: { provider: test, model: test }",
    "",
  ].join("\n"));
  await writeFile(path.join(home, "yoplai.json"), JSON.stringify({
    version: 3, agents: "agents/*", extensionsPath: "extensions",
  }));
  vi.stubEnv("YOPLAI_HOME", home);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  await updateAgentExtensionConfig(workspace, "mattermost", {
    enabled: true,
    config: {
      url: "https://chat.example.test",
      channels: { "sales-channel": { requireMention: true } },
    },
    secrets: { token: "invented-mattermost-token" },
  });

  const { loadConfig } = await import("../config/index.js");
  const config = loadConfig();
  expect(config.agents[0].mattermost).toEqual({
    url: "https://chat.example.test",
    token: "$env:MATTERMOST_TOKEN",
    channels: { "sales-channel": { requireMention: true } },
  });
  expect(config.agents[0].extensions?.mattermost).toMatchObject({
    enabled: true, token: "$env:MATTERMOST_TOKEN",
  });
  expect(await readFile(path.join(workspace, "agent.yaml"), "utf8"))
    .not.toContain("invented-mattermost-token");

  const { loadExtensions } = await import("./registry.js");
  expect((await loadExtensions(config)).map((extension) => extension.id))
    .toContain("mattermost");
  expect(warn.mock.calls.flat().join("\n"))
    .not.toContain('unknown extension "mattermost"');

  const { resolveStartupConfig } = await import("../config/validate.js");
  const resolved = await resolveStartupConfig(config);
  expect(resolved.agents[0].mattermost?.token).toBe("invented-mattermost-token");
});

it("still loads Mattermost for an existing top-level-only agent", async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "yoplai-channel-legacy-"));
  const workspace = path.join(home, "agents", "legacy");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "agent.yaml"), [
    "id: legacy",
    "name: Legacy",
    "model: { provider: test, model: test }",
    "mattermost:",
    "  url: https://chat.example.test",
    "  token: invented-legacy-token",
    "",
  ].join("\n"));
  await writeFile(path.join(home, "yoplai.json"), JSON.stringify({
    version: 3, agents: "agents/*", extensionsPath: "extensions",
  }));
  vi.stubEnv("YOPLAI_HOME", home);
  const { loadConfig } = await import("../config/index.js");
  const { loadExtensions } = await import("./registry.js");

  expect((await loadExtensions(loadConfig())).map((extension) => extension.id))
    .toContain("mattermost");
});
