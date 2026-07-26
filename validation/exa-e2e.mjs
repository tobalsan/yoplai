import path from "node:path";
import fs from "node:fs/promises";

const HOME = process.env.YOPLAI_HOME;
const repoRoot = process.cwd();

// Import the REAL gateway code paths via tsx-compiled sources.
const { buildExtensionCatalog } = await import(
  path.join(repoRoot, "apps/gateway/src/extensions/catalog.ts")
);
const { updateAgentExtensionConfig, secretEnvName } = await import(
  path.join(repoRoot, "apps/gateway/src/extensions/agent-config-writer.ts")
);
const { loadConfig, reloadConfig, resolveWorkspaceDir, resolveAgentEnv } =
  await import(path.join(repoRoot, "apps/gateway/src/config/index.ts"));

function findAgent(config, id) {
  return (config.pool ?? []).find((a) => a.id === id) ??
    config.agents.find((a) => a.id === id);
}

const config = loadConfig();
const agent = findAgent(config, "sales");
console.log("== agent workspace:", agent.workspaceDir ?? agent.workspace);

// 1. Catalog BEFORE: exa should be present, auto-form, requiredSecrets apiKey, disabled.
let catalog = await buildExtensionCatalog(config, agent);
const exaBefore = catalog.find((e) => e.id === "exa");
console.log("== exa catalog BEFORE:", JSON.stringify(exaBefore, null, 2));

// 2. Drive the REAL write path: set apiKey secret + enable (what the form submits).
// Resolve the agent's actual workspace exactly like the PATCH endpoint does.
const workspaceDir = resolveWorkspaceDir(agent.workspaceDir ?? agent.workspace);
console.log("== resolved workspaceDir:", workspaceDir);
await updateAgentExtensionConfig(workspaceDir, "exa", {
  enabled: true,
  config: {},
  secrets: { apiKey: "sk-exa-e2e-TRACER-123" },
});
console.log("== write path ran ==");

// 3. Prove persistence: agent.yaml has $env ref, .env has the value.
const yamlText = await fs.readFile(path.join(workspaceDir, "agent.yaml"), "utf8");
const envText = await fs.readFile(path.join(workspaceDir, ".env"), "utf8").catch(() => "(no .env)");
const envName = secretEnvName("sales", "exa", "apiKey");
console.log("== expected env name:", envName);
console.log("---- agent.yaml ----\n" + yamlText);
console.log("---- .env ----\n" + envText);

// 4. Catalog AFTER reload: exa enabled.
const reloaded = reloadConfig();
const agent2 = findAgent(reloaded, "sales");
catalog = await buildExtensionCatalog(reloaded, agent2);
const exaAfter = catalog.find((e) => e.id === "exa");
console.log("== exa catalog AFTER:", JSON.stringify({ id: exaAfter.id, enabled: exaAfter.enabled, tier: exaAfter.tier, requiredSecrets: exaAfter.requiredSecrets }, null, 2));

// Assertions
const yamlHasEnvRef = yamlText.includes(`$env:${envName}`);
const yamlHasNoPlaintext = !yamlText.includes("sk-exa-e2e-TRACER-123");
const envHasValue = envText.includes(`${envName}=sk-exa-e2e-TRACER-123`);
console.log("\n== ASSERTIONS ==");
console.log("exaBefore auto-form + apiKey secret + disabled:",
  exaBefore?.tier === "auto-form" && exaBefore?.requiredSecrets.includes("apiKey") && exaBefore?.enabled === false);
console.log("agent.yaml has $env ref (no plaintext):", yamlHasEnvRef && yamlHasNoPlaintext);
console.log(".env has plaintext value:", envHasValue);
console.log("exaAfter enabled:", exaAfter?.enabled === true);

// 5. "Takes effect on next run": the runtime resolves the $env: ref from the
// agent's .env and exposes exa tools ONLY when the apiKey secret is present.
// This is the exact getAgentTools path a real run uses to build agent tools.
const { discoverExternalExtensions } = await import(path.join(repoRoot, "packages/shared/src/index.ts"));
const exts = await discoverExternalExtensions(path.resolve(HOME, "extensions"));
const exaExt = exts.find((e) => e.id === "exa").extension;

// The gateway layers the agent's resolved .env into the environment before a run
// builds its tools; replicate that here (resolveAgentEnv reads the same .env the
// write path just wrote) so the `$env:` ref resolves exactly as it will at run time.
const runEnv = resolveAgentEnv(agent2, reloaded);
Object.assign(process.env, runEnv);
const toolsAfter = (await exaExt.getAgentTools?.(agent2, { config: reloaded })) ?? [];
console.log("\n== exa agent tools resolved on next run:", toolsAfter.map((t) => t.name));

// Negative control: an agent WITHOUT exa enabled must not get exa tools (config
// resolution returns undefined when the extension is not opted in).
const bareAgent = { ...agent2, extensions: {} };
let toolsBare = [];
try {
  toolsBare = (await exaExt.getAgentTools?.(bareAgent, { config: reloaded })) ?? [];
} catch {
  toolsBare = [];
}
console.log("== exa tools for agent without config:", toolsBare.map((t) => t.name));
console.log("exa takes effect on next run (tools present):", toolsAfter.length > 0);
console.log("exa inert when unconfigured (no tools):", toolsBare.length === 0);
