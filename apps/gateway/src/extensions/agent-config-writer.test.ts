import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import yaml from "js-yaml";
import {
  AgentYamlConfigSchema,
  GatewayConfigSchema,
  defineToolExtension,
} from "@yoplai/shared";
import { z } from "zod";
import {
  ExtensionConfigValidationError,
  secretEnvName,
  updateAgentExtensionConfig,
  updateAgentWebhookCredentials,
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

const AGENT_WITH_COMMENTS_AND_BLANK_LINES = `id: sales
name: Sales
role: Sales Assistant
description: Handles sales handoffs.
model:
  provider: openai
  model: gpt-4o-mini
system: You are the Sales test agent.
sandbox:
  enabled: true
  # keep the sandbox writable for local testing
  workspaceWritable: true

system_files:
  - path: notes.md
`;

let workspaceDir: string;

const cloudifiExtension = defineToolExtension({
  id: "cloudifi-admin",
  displayName: "Cloudifi Admin",
  description: "Cloudifi test fixture",
  configSchema: z.object({ username: z.string(), password: z.string() }),
  requiredSecrets: ["username", "password"],
  createTools: () => [],
});

function validateCloudifiConfig(
  nextConfig: Record<string, unknown>,
  pendingEnv: Record<string, string>
): void {
  const agent = {
    ...AgentYamlConfigSchema.parse(nextConfig),
    workspace: workspaceDir,
  };
  const config = GatewayConfigSchema.parse({ version: 2, agents: [agent] });
  const result = cloudifiExtension.validateAgentConfig!(
    agent,
    config,
    pendingEnv
  );
  if (!result.valid) throw new ExtensionConfigValidationError(result.errors);
}

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

  it("unsets secrets and their managed .env values, keeping settings and unrelated env", async () => {
    await writeFile(path.join(workspaceDir, ".env"), "OTHER=keep\n");
    await updateAgentExtensionConfig(workspaceDir, "acme-crm", {
      enabled: true,
      config: { region: "eu", shared: "$env:SHARED_TOKEN" },
      secrets: { apiKey: "fixture-key" },
    });
    await updateAgentExtensionConfig(workspaceDir, "acme-crm", { removeSecrets: ["apiKey", "shared"] });
    expect(await readAgentExtensions()).toEqual({ "acme-crm": { enabled: true, region: "eu" } });
    expect(await readFile(path.join(workspaceDir, ".env"), "utf8")).toBe("OTHER=keep\n");
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

  it("preserves comments and blank lines in agent.yaml when enabling a new extension", async () => {
    await writeFile(
      path.join(workspaceDir, "agent.yaml"),
      AGENT_WITH_COMMENTS_AND_BLANK_LINES
    );

    await updateAgentExtensionConfig(workspaceDir, "acme-crm", {
      enabled: true,
    });

    const raw = await readFile(path.join(workspaceDir, "agent.yaml"), "utf8");
    expect(raw).toContain("# keep the sandbox writable for local testing");
    expect(raw).toContain("workspaceWritable: true\n\nsystem_files:");
    expect(AgentYamlConfigSchema.safeParse(yaml.load(raw)).success).toBe(true);
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

  it("does not write either file when prospective validation rejects missing secrets", async () => {
    const originalYaml = await readFile(
      path.join(workspaceDir, "agent.yaml"),
      "utf8"
    );
    const existingEnv = "UNRELATED=keep-me\n";
    await writeFile(path.join(workspaceDir, ".env"), existingEnv);

    await expect(
      updateAgentExtensionConfig(
        workspaceDir,
        "cloudifi-admin",
        { enabled: true },
        validateCloudifiConfig
      )
    ).rejects.toMatchObject({ fields: ["username", "password"] });

    expect(await readFile(path.join(workspaceDir, "agent.yaml"), "utf8")).toBe(
      originalYaml
    );
    expect(await readFile(path.join(workspaceDir, ".env"), "utf8")).toBe(
      existingEnv
    );
  });

  it("rejects a partial prospective secret config without writing either file", async () => {
    const originalYaml = await readFile(
      path.join(workspaceDir, "agent.yaml"),
      "utf8"
    );
    const existingEnv = "UNRELATED=keep-me\n";
    await writeFile(path.join(workspaceDir, ".env"), existingEnv);

    await expect(
      updateAgentExtensionConfig(
        workspaceDir,
        "cloudifi-admin",
        { enabled: true, secrets: { username: "cloudifi-user" } },
        validateCloudifiConfig
      )
    ).rejects.toMatchObject({ fields: ["password"] });

    expect(await readFile(path.join(workspaceDir, "agent.yaml"), "utf8")).toBe(
      originalYaml
    );
    expect(await readFile(path.join(workspaceDir, ".env"), "utf8")).toBe(
      existingEnv
    );
  });

  it("validates pending secrets before atomically writing their env references", async () => {
    const username = "cloudifi-user";
    const password = "cloudifi-password";
    let validatedEnv: Record<string, string> | undefined;

    await updateAgentExtensionConfig(
      workspaceDir,
      "cloudifi-admin",
      { enabled: true, secrets: { username, password } },
      (nextConfig, pendingEnv) => {
        validateCloudifiConfig(nextConfig, pendingEnv);
        const extension = (
          nextConfig.extensions as Record<string, Record<string, unknown>>
        )["cloudifi-admin"];
        expect(extension).toMatchObject({ enabled: true });
        expect(extension.username).toBe(
          `$env:${secretEnvName("cloudifi-admin", "username")}`
        );
        expect(extension.password).toBe(
          `$env:${secretEnvName("cloudifi-admin", "password")}`
        );
        validatedEnv = pendingEnv;
      }
    );

    expect(validatedEnv).toEqual({
      [secretEnvName("cloudifi-admin", "username")]: username,
      [secretEnvName("cloudifi-admin", "password")]: password,
    });
    const envRaw = await readFile(path.join(workspaceDir, ".env"), "utf8");
    expect(envRaw).toContain(
      `${secretEnvName("cloudifi-admin", "username")}=cloudifi-user`
    );
    expect(envRaw).toContain(
      `${secretEnvName("cloudifi-admin", "password")}=cloudifi-password`
    );
  });
});

describe("updateAgentWebhookCredentials", () => {
  it("assigns the requesting user as owner in agent.yaml", async () => {
    await writeFile(
      path.join(workspaceDir, "agent.yaml"),
      BASE_AGENT +
        `webhooks:
  triage:
    prompt: Triage this event
`
    );

    await updateAgentWebhookCredentials(
      workspaceDir,
      "triage",
      "owner",
      "alice"
    );

    const persisted = yaml.load(
      await readFile(path.join(workspaceDir, "agent.yaml"), "utf8")
    );
    expect(persisted).toMatchObject({
      webhooks: {
        triage: {
          prompt: "Triage this event",
          credentialMode: "owner",
          ownerUserId: "alice",
        },
      },
    });
  });
  it("clears ownership when its owner switches back to team", async () => {
    await writeFile(
      path.join(workspaceDir, "agent.yaml"),
      BASE_AGENT +
        `webhooks:
  triage:
    prompt: Triage this event
    credentialMode: owner
    ownerUserId: alice
`
    );
    await updateAgentWebhookCredentials(
      workspaceDir,
      "triage",
      "team",
      "alice"
    );
    const persisted = yaml.load(
      await readFile(path.join(workspaceDir, "agent.yaml"), "utf8")
    );
    expect(persisted).toMatchObject({
      webhooks: {
        triage: { prompt: "Triage this event", credentialMode: "team" },
      },
    });
    expect(
      (persisted as { webhooks: { triage: Record<string, unknown> } }).webhooks
        .triage
    ).not.toHaveProperty("ownerUserId");
  });

  it("refuses another user's change to an owner-mode webhook without writing", async () => {
    const original =
      BASE_AGENT +
      `webhooks:
  triage:
    prompt: Triage this event
    credentialMode: owner
    ownerUserId: alice
`;
    await writeFile(path.join(workspaceDir, "agent.yaml"), original);
    await expect(
      updateAgentWebhookCredentials(workspaceDir, "triage", "team", "bob")
    ).rejects.toMatchObject({ status: 403 });
    expect(await readFile(path.join(workspaceDir, "agent.yaml"), "utf8")).toBe(
      original
    );
  });

  it("requires an authenticated user when selecting owner credentials", async () => {
    const original =
      BASE_AGENT +
      `webhooks:
  triage:
    prompt: Triage this event
`;
    await writeFile(path.join(workspaceDir, "agent.yaml"), original);
    await expect(
      updateAgentWebhookCredentials(workspaceDir, "triage", "owner")
    ).rejects.toMatchObject({
      status: 400,
      message: "Owner credentials require an authenticated user",
    });
    expect(await readFile(path.join(workspaceDir, "agent.yaml"), "utf8")).toBe(
      original
    );
  });

  it("returns not found for an unknown webhook without creating it", async () => {
    await expect(
      updateAgentWebhookCredentials(workspaceDir, "missing", "owner", "alice")
    ).rejects.toMatchObject({ status: 404 });
    expect(await readFile(path.join(workspaceDir, "agent.yaml"), "utf8")).toBe(
      BASE_AGENT
    );
  });

  it("keeps a webhook claim and an extension update started concurrently", async () => {
    await writeFile(
      path.join(workspaceDir, "agent.yaml"),
      BASE_AGENT +
        `webhooks:
  triage:
    prompt: Triage this event
`
    );
    await Promise.all([
      updateAgentWebhookCredentials(workspaceDir, "triage", "owner", "alice"),
      updateAgentExtensionConfig(workspaceDir, "acme-crm", {
        enabled: true,
        secrets: { token: "fixture-value" },
      }),
    ]);
    const persisted = yaml.load(
      await readFile(path.join(workspaceDir, "agent.yaml"), "utf8")
    );
    expect(persisted).toMatchObject({
      webhooks: { triage: { credentialMode: "owner", ownerUserId: "alice" } },
      extensions: {
        "acme-crm": { enabled: true, token: "$env:ACME_CRM_TOKEN" },
      },
    });
    expect(await readFile(path.join(workspaceDir, ".env"), "utf8")).toBe(
      "ACME_CRM_TOKEN=fixture-value\n"
    );
  });

  it("allows exactly one of two concurrent users to claim the webhook", async () => {
    await writeFile(
      path.join(workspaceDir, "agent.yaml"),
      BASE_AGENT +
        `webhooks:
  triage:
    prompt: Triage this event
`
    );
    const outcomes = await Promise.allSettled([
      updateAgentWebhookCredentials(workspaceDir, "triage", "owner", "alice"),
      updateAgentWebhookCredentials(workspaceDir, "triage", "owner", "bob"),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled")
    ).toHaveLength(1);
    const loser = outcomes.find((outcome) => outcome.status === "rejected");
    expect(loser).toMatchObject({
      status: "rejected",
      reason: { status: 403 },
    });
    const persisted = yaml.load(
      await readFile(path.join(workspaceDir, "agent.yaml"), "utf8")
    ) as { webhooks: { triage: Record<string, unknown> } };
    expect(persisted.webhooks.triage.credentialMode).toBe("owner");
    expect(persisted.webhooks.triage.ownerUserId).toBe(
      outcomes[0].status === "fulfilled" ? "alice" : "bob"
    );
  });

  it("keeps webhook comments, blank lines, and unresolved env references", async () => {
    await writeFile(
      path.join(workspaceDir, "agent.yaml"),
      BASE_AGENT +
        `webhooks:
  # receives the invented triage event
  triage:
    prompt: "$env:TRIAGE_PROMPT" # prompt stays local
    signingSecret: "$env:TRIAGE_SIGNING_SECRET"

extensions:
  acme-crm:
    apiKey: "$env:ACME_KEY"
`
    );
    await updateAgentWebhookCredentials(
      workspaceDir,
      "triage",
      "owner",
      "alice"
    );
    const raw = await readFile(path.join(workspaceDir, "agent.yaml"), "utf8");
    expect(raw).toContain("# receives the invented triage event");
    expect(raw).toContain("# prompt stays local");
    expect(raw).toContain("\n\nextensions:");
    const persisted = yaml.load(raw);
    expect(persisted).toMatchObject({
      webhooks: {
        triage: {
          prompt: "$env:TRIAGE_PROMPT",
          signingSecret: "$env:TRIAGE_SIGNING_SECRET",
          ownerUserId: "alice",
        },
      },
      extensions: { "acme-crm": { apiKey: "$env:ACME_KEY" } },
    });
  });

  it("rejects an invalid agent result before touching the file", async () => {
    const invalid =
      BASE_AGENT +
      `webhooks:
  triage:
    prompt: 17
`;
    await writeFile(path.join(workspaceDir, "agent.yaml"), invalid);
    await expect(
      updateAgentWebhookCredentials(workspaceDir, "triage", "owner", "alice")
    ).rejects.toThrow("agent.yaml would be invalid after update");
    expect(await readFile(path.join(workspaceDir, "agent.yaml"), "utf8")).toBe(
      invalid
    );
  });
});
