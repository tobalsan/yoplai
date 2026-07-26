import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { AgentYamlConfigSchema } from "@yoplai/shared";
import {
  secretEnvName,
  updateAgentExtensionConfig,
} from "./agent-config-writer.js";

const BASE_AGENT = `id: sales
name: Sales
role: Sales Assistant
description: Handles sales handoffs.
model:
  provider: openai
  model: gpt-4o-mini
system: You are the Sales test agent.
`;

let workspaceDir: string;

async function readAgentExtensions(): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(workspaceDir, "agent.yaml"), "utf8");
  const parsed = yaml.load(raw) as { extensions?: Record<string, unknown> };
  return parsed.extensions ?? {};
}

beforeEach(async () => {
  workspaceDir = await mkdtemp(path.join(os.tmpdir(), "agent-writer-"));
  await writeFile(path.join(workspaceDir, "agent.yaml"), BASE_AGENT);
});

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

describe("updateAgentExtensionConfig", () => {
  it("round-trips enable then disable, and a re-read observes the change", async () => {
    await updateAgentExtensionConfig(workspaceDir, "acme-crm", {
      enabled: true,
    });
    expect(await readAgentExtensions()).toEqual({
      "acme-crm": { enabled: true },
    });

    await updateAgentExtensionConfig(workspaceDir, "acme-crm", {
      enabled: false,
    });
    expect(await readAgentExtensions()).toEqual({
      "acme-crm": { enabled: false },
    });
  });

  it("re-validates the written yaml against the agent schema", async () => {
    await updateAgentExtensionConfig(workspaceDir, "acme-crm", {
      enabled: true,
      config: { region: "eu" },
    });
    const raw = await readFile(path.join(workspaceDir, "agent.yaml"), "utf8");
    const parsed = AgentYamlConfigSchema.safeParse(yaml.load(raw));
    expect(parsed.success).toBe(true);
  });

  it("preserves existing config when patching a single field", async () => {
    await updateAgentExtensionConfig(workspaceDir, "acme-crm", {
      enabled: true,
      config: { region: "eu" },
    });
    await updateAgentExtensionConfig(workspaceDir, "acme-crm", {
      config: { locale: "fr" },
    });
    expect(await readAgentExtensions()).toEqual({
      "acme-crm": { enabled: true, region: "eu", locale: "fr" },
    });
  });

  it("does not clobber other extensions", async () => {
    await updateAgentExtensionConfig(workspaceDir, "telegram", {
      enabled: true,
    });
    await updateAgentExtensionConfig(workspaceDir, "acme-crm", {
      enabled: false,
    });
    expect(await readAgentExtensions()).toEqual({
      telegram: { enabled: true },
      "acme-crm": { enabled: false },
    });
  });

  it("writes secrets as $env:NAME in yaml and the real value into .env", async () => {
    await updateAgentExtensionConfig(workspaceDir, "acme-crm", {
      enabled: true,
      secrets: { apiKey: "sk-super-secret" },
    });

    const envName = secretEnvName("acme-crm", "apiKey");
    const extensions = await readAgentExtensions();
    expect(extensions["acme-crm"]).toEqual({
      enabled: true,
      apiKey: `$env:${envName}`,
    });

    // The concrete value must never appear in agent.yaml.
    const yamlRaw = await readFile(
      path.join(workspaceDir, "agent.yaml"),
      "utf8"
    );
    expect(yamlRaw).not.toContain("sk-super-secret");
    expect(yamlRaw).toContain(`$env:${envName}`);

    // The real value lands in the agent's .env keyed by the sentinel name.
    const envRaw = await readFile(path.join(workspaceDir, ".env"), "utf8");
    expect(envRaw).toContain(`${envName}=sk-super-secret`);
  });

  it("updates an existing secret value in .env in place", async () => {
    await updateAgentExtensionConfig(workspaceDir, "acme-crm", {
      secrets: { apiKey: "first" },
    });
    await updateAgentExtensionConfig(workspaceDir, "acme-crm", {
      secrets: { apiKey: "second" },
    });

    const envName = secretEnvName("acme-crm", "apiKey");
    const envRaw = await readFile(path.join(workspaceDir, ".env"), "utf8");
    const matches = envRaw.match(new RegExp(`^${envName}=`, "gm")) ?? [];
    expect(matches).toHaveLength(1);
    expect(envRaw).toContain(`${envName}=second`);
  });

  it("quotes env values that contain whitespace or special chars", async () => {
    await updateAgentExtensionConfig(workspaceDir, "acme-crm", {
      secrets: { token: "has spaces #hash" },
    });
    const envName = secretEnvName("acme-crm", "token");
    const envRaw = await readFile(path.join(workspaceDir, ".env"), "utf8");
    expect(envRaw).toContain(`${envName}="has spaces #hash"`);
  });
});
