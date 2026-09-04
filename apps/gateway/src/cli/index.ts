#!/usr/bin/env node
import { Command } from "commander";
import { spawn, ChildProcess, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import {
  loadConfig,
  getAgents,
  getAgent,
  CONFIG_DIR,
  setLoadedConfig,
} from "../config/index.js";
import { runAgent } from "../agents/index.js";
import { registerSubagentCommands } from "./subagent.js";
import { registerWebhookCommands } from "./webhooks.js";
import { registerUserTokenCommands } from "./user-token.js";
import { registerNotifyCommand } from "./notify.js";
import { registerModelCommands } from "./models.js";
import { registerAgentsMigrateCommands } from "./agents-migrate.js";
import { registerGatewayServiceCommands } from "./service.js";
import { registerSchedulerCommands } from "@yoplai/extension-scheduler";
import { registerOrchestratorCommands } from "@yoplai/extension-orchestrator";
import { registerEvalCommands } from "../evals/cli.js";
import { readEnv, resolveBindHost, type Extension, type UiConfig } from "@yoplai/shared";
import {
  prepareStartupConfig,
  resolveStartupConfig,
} from "../config/validate.js";
import { startGatewayCommand } from "./gateway.js";
import { getExtensionRuntime, loadExtensions } from "../extensions/registry.js";
import { logError } from "../logging.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoProjectsExtensionImport = new URL(
  "../../../../packages/extensions/projects/src/index.ts",
  import.meta.url
).href;

function isModuleNotFound(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

function isMonorepoDevRuntime(): boolean {
  return (
    readEnv("WEB_DEV") === "1" ||
    process.env.NODE_OPTIONS?.includes("--conditions=development") === true
  );
}

async function importOptionalProjectsExtension(): Promise<
  Record<string, unknown>
> {
  const specifier = "@yoplai/extension-projects";
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    if (isModuleNotFound(error) && isMonorepoDevRuntime()) {
      return (await import(monorepoProjectsExtensionImport)) as Record<
        string,
        unknown
      >;
    }
    throw error;
  }
}

// Tracks web UI child process for cleanup
let webProcess: ChildProcess | null = null;
let tailscaleServeEnabled = false;
let tailscaleServeResetOnExit = false;
let tailscaleServeRefreshTimer: ReturnType<typeof setInterval> | null = null;
const TAILSCALE_SERVE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

async function registerOptionalProjectsCli(program: Command): Promise<void> {
  try {
    const module = await importOptionalProjectsExtension();
    const registerProjectsCommands = module.registerProjectsCommands;
    const registerSlicesCommands = module.registerSlicesCommands;
    if (
      typeof registerProjectsCommands !== "function" ||
      typeof registerSlicesCommands !== "function"
    ) {
      throw new Error(
        'Package "@yoplai/extension-projects" does not export project CLI commands'
      );
    }
    registerProjectsCommands(
      program
        .command("projects")
        .description("Manage Yoplai projects")
        .version("0.1.0")
    );
    registerSlicesCommands(
      program
        .command("slices")
        .description("Manage Yoplai slices")
        .version("0.1.0")
    );
  } catch (error) {
    if (!isModuleNotFound(error)) {
      throw error;
    }
    const message =
      'Project CLI commands require optional package "@yoplai/extension-projects". Install it or do not use `yoplai projects`/`yoplai slices`.';
    program
      .command("projects")
      .description("Manage Yoplai projects")
      .action(() => {
        throw new Error(message);
      });
    program
      .command("slices")
      .description("Manage Yoplai slices")
      .action(() => {
        throw new Error(message);
      });
  }
}

const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

function getTailscaleCmd(): string {
  for (const candidate of TAILSCALE_CANDIDATES) {
    if (candidate.startsWith("/") && !fs.existsSync(candidate)) continue;
    try {
      execSync(`${candidate} version`, { encoding: "utf-8", timeout: 5000 });
      return candidate;
    } catch {
      // Try next
    }
  }
  throw new Error("Tailscale CLI not found");
}

function enableTailscaleServe(port: number, servePath: string): void {
  const cmd = getTailscaleCmd();
  const normalizedPath =
    servePath.endsWith("/") && servePath !== "/"
      ? servePath.slice(0, -1)
      : servePath;
  const target = `http://127.0.0.1:${port}${normalizedPath}`;
  execSync(`${cmd} serve --bg --yes --set-path=${normalizedPath} ${target}`, {
    encoding: "utf-8",
    timeout: 15000,
  });
}

function resetTailscaleServe(): void {
  try {
    const cmd = getTailscaleCmd();
    execSync(`${cmd} serve reset`, {
      encoding: "utf-8",
      timeout: 15000,
    });
  } catch {
    // Ignore reset errors
  }
}

// Pre-rename tailscale serve path. `tailscale serve` writes into tailscaled's
// persistent serve config, which lives outside this repo and survives
// restarts/reboots, so upgrading the binary alone does not remove it.
const LEGACY_SERVE_PATH = "/aihub";
let clearedLegacyServePath = false;

function clearLegacyTailscaleServePath(): void {
  try {
    const cmd = getTailscaleCmd();
    execSync(`${cmd} serve --bg --yes --set-path=${LEGACY_SERVE_PATH} off`, {
      encoding: "utf-8",
      timeout: 15000,
    });
  } catch {
    // Ignore errors clearing the legacy path
  }
}

export function refreshTailscaleServe(port: number, gatewayPort: number): void {
  if (!clearedLegacyServePath) {
    clearedLegacyServePath = true;
    clearLegacyTailscaleServePath();
  }
  enableTailscaleServe(port, "/yoplai");
  enableTailscaleServe(gatewayPort, "/api");
  enableTailscaleServe(gatewayPort, "/ws");
}

function stopTailscaleServeRefresh(): void {
  if (tailscaleServeRefreshTimer) {
    clearInterval(tailscaleServeRefreshTimer);
    tailscaleServeRefreshTimer = null;
  }
}

function startTailscaleServeRefresh(port: number, gatewayPort: number): void {
  stopTailscaleServeRefresh();
  tailscaleServeRefreshTimer = setInterval(() => {
    try {
      refreshTailscaleServe(port, gatewayPort);
    } catch (err) {
      logError("[gateway] Failed to refresh tailscale serve", err);
    }
  }, TAILSCALE_SERVE_REFRESH_INTERVAL_MS);
}

function resolveUiHost(bind?: string): string {
  if (!bind || bind === "loopback") return "127.0.0.1";
  if (bind === "lan") return "0.0.0.0";
  // For tailnet bind with tailscale serve, Vite preview must bind to loopback
  return "127.0.0.1";
}

function getApiBaseUrl(): string {
  const envUrl = readEnv("API_URL");
  if (envUrl) return envUrl;

  const config = loadConfig();
  const host = config.gateway?.host ?? resolveBindHost(config.gateway?.bind);
  const port = config.gateway?.port ?? 4000;
  return `http://${host}:${port}`;
}

function startWebUI(
  uiConfig: UiConfig,
  gatewayPort: number
): ChildProcess | null {
  if (readEnv("SKIP_WEB")) return null;

  const port = uiConfig.port ?? 3000;
  const host = resolveUiHost(uiConfig.bind);
  const useTailscaleServe = uiConfig.tailscale?.mode === "serve";
  const resetOnExit = uiConfig.tailscale?.resetOnExit ?? false;
  const useDevServer = readEnv("WEB_DEV") === "1";

  // Get monorepo root (gateway is at apps/gateway/dist/cli or apps/gateway/src/cli)
  const gatewayRoot = path.resolve(__dirname, "../..");
  const monorepoRoot = path.resolve(gatewayRoot, "../..");

  // Use vite dev for hot reload, vite preview for production-like serving
  const viteCmd = useDevServer ? "dev" : "preview";
  const args = [
    "--filter",
    "@yoplai/web",
    "exec",
    "vite",
    viteCmd,
    "--port",
    String(port),
    "--host",
    host,
  ];
  const child = spawn("pnpm", args, {
    cwd: monorepoRoot,
    stdio: "inherit",
    env: { ...process.env, YOPLAI_SKIP_WEB: "1" },
  });

  let tailscaleReady = false;
  if (useTailscaleServe) {
    try {
      refreshTailscaleServe(port, gatewayPort);
      startTailscaleServeRefresh(port, gatewayPort);
      tailscaleServeEnabled = true;
      tailscaleServeResetOnExit = resetOnExit;
      tailscaleReady = true;
    } catch (err) {
      logError("[gateway] Failed to enable Tailscale serve", err);
      console.log("[gateway] Continuing without Tailscale HTTPS...");
    }
  }

  // Log URL
  if (useTailscaleServe && tailscaleReady) {
    console.log(`Web UI: https://<tailnet>/yoplai (via tailscale serve)`);
  } else {
    const displayHost = host === "0.0.0.0" ? "localhost" : host;
    console.log(`Web UI: http://${displayHost}:${port}/`);
  }

  return child;
}

const program = new Command();

program.name("yoplai").description("Yoplai multi-agent gateway").version("0.1.0");

function printDevBanner(
  gatewayPort: number,
  uiPort: number | null,
  extensions: Extension[]
) {
  const enabledIds = new Set(extensions.map((extension) => extension.id));
  const scheduler = enabledIds.has("scheduler") ? "ON" : "OFF";
  const heartbeat = enabledIds.has("heartbeat") ? "ON" : "OFF";
  const status = `Scheduler: ${scheduler}  Heartbeat: ${heartbeat}`;
  const uiLine = uiPort
    ? `║  Web UI:  http://127.0.0.1:${uiPort.toString().padEnd(5)}       ║`
    : null;
  console.log(`
╔════════════════════════════════════════╗
║           DEV MODE ACTIVE              ║
║  Gateway: http://127.0.0.1:${gatewayPort.toString().padEnd(5)}       ║${uiLine ? `\n${uiLine}` : ""}
║  ${status.padEnd(38)}║
╚════════════════════════════════════════╝
`);
}

process.on("uncaughtException", (err) => {
  logError("[gateway] uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  logError("[gateway] unhandledRejection", reason);
});

const gatewayCmd = program
  .command("gateway")
  .description("Start the gateway server (multi-agent mode)")
  .option("-p, --port <port>", "Server port (default: 4000 or config)")
  .option(
    "-h, --host <host>",
    "Server host (default: from config gateway.bind)"
  )
  .option("--agent-id <id>", "Single-agent mode: only load this agent")
  .option("--dev", "Dev mode: auto-find ports, print dev banner")
  .action(async (opts) => {
    try {
      const { actualPort, config, extensions, uiEnabled, uiPort } =
        await startGatewayCommand(opts);

      // Start web UI if enabled (default: true) and not in dev mode
      // In dev mode, web UI is started by scripts/dev.ts with proper port coordination
      if (uiEnabled && !opts.dev) {
        webProcess = startWebUI(config.ui ?? {}, actualPort);
      }

      if (opts.dev) {
        printDevBanner(actualPort, uiEnabled ? uiPort : null, extensions);
      }

      // Handle shutdown
      const shutdown = async () => {
        console.log("\nShutting down...");
        const { stopDreamTimers } = await import("../dream/service.js");
        stopDreamTimers();
        if (webProcess) webProcess.kill("SIGTERM");
        stopTailscaleServeRefresh();
        if (tailscaleServeEnabled && tailscaleServeResetOnExit) {
          resetTailscaleServe();
        }
        for (const extension of [...extensions].reverse()) {
          await extension.stop();
        }
        process.exit(0);
      };

      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    } catch (err) {
      logError("Failed to start gateway", err);
      process.exit(1);
    }
  });

registerGatewayServiceCommands(gatewayCmd);

program
  .command("agent")
  .description("Manage agents")
  .command("list")
  .description("List all configured agents")
  .action(() => {
    try {
      const agents = getAgents();
      console.log("Configured agents:");
      for (const agent of agents) {
        console.log(
          `  - ${agent.id}: ${agent.name} (${agent.model.provider}/${agent.model.model})`
        );
      }
    } catch (err) {
      logError("Error", err);
      process.exit(1);
    }
  });

program
  .command("send")
  .description("Send a message to an agent")
  .requiredOption("-a, --agent <id>", "Agent ID")
  .requiredOption("-m, --message <text>", "Message to send")
  .option("-s, --session <id>", "Session ID", "default")
  .action(async (opts) => {
    try {
      const rawConfig = loadConfig();
      const resolvedStartupConfig = await resolveStartupConfig(rawConfig);
      const extensions = await loadExtensions(resolvedStartupConfig);
      const extensionRuntime = getExtensionRuntime();
      const { resolvedConfig: config } = await prepareStartupConfig(
        rawConfig,
        extensions,
        { resolvedConfig: resolvedStartupConfig }
      );
      setLoadedConfig(config);

      const agent = getAgent(opts.agent);
      if (!agent) {
        logError("Agent not found", opts.agent);
        process.exit(1);
      }

      console.log(`Sending to ${agent.name}...`);
      const result = await runAgent({
        agentId: agent.id,
        message: opts.message,
        sessionId: opts.session,
        extensionRuntime,
        onEvent: (event) => {
          if (event.type === "text") {
            process.stdout.write(event.data);
          }
        },
      });

      console.log("\n");
      console.log(`Duration: ${result.meta.durationMs}ms`);
    } catch (err) {
      logError("Error", err);
      process.exit(1);
    }
  });

program
  .command("heartbeat <agentId>")
  .description("Trigger a heartbeat for an agent")
  .action(async (agentId: string) => {
    try {
      loadConfig();
      const agent = getAgent(agentId);
      if (!agent) {
        logError("Agent not found", agentId);
        process.exit(1);
      }

      console.log(`Running heartbeat for ${agent.name}...`);
      const baseUrl = getApiBaseUrl();
      const url = new URL(
        `/api/agents/${agentId}/heartbeat`,
        baseUrl
      ).toString();
      let res;
      try {
        res = await fetch(url, { method: "POST" });
      } catch {
        logError("Failed to reach gateway", baseUrl);
        process.exit(1);
      }
      if (!res.ok) {
        const data = await res
          .json()
          .catch(() => ({ error: "Failed to run heartbeat" }));
        logError("Failed to run heartbeat", data.error ?? "Failed to run heartbeat");
        process.exit(1);
      }
      const result = (await res.json()) as {
        status?: string;
        durationMs?: number;
        reason?: string;
        alertText?: string;
      };

      console.log(`Status: ${result.status}`);
      if (result.durationMs !== undefined) {
        console.log(`Duration: ${result.durationMs}ms`);
      }
      if (result.reason) {
        console.log(`Reason: ${result.reason}`);
      }
      if (result.alertText) {
        console.log(`\n${result.alertText}`);
      }
    } catch (err) {
      logError("Error", err);
      process.exit(1);
    }
  });

registerAgentsMigrateCommands(program);
registerSubagentCommands(program);
registerWebhookCommands(program);
registerUserTokenCommands(program);
registerNotifyCommand(program);
registerModelCommands(program);
await registerOptionalProjectsCli(program);
registerSchedulerCommands(
  program
    .command("scheduler")
    .description("Manage Yoplai schedules")
    .version("0.1.0")
);
registerOrchestratorCommands(
  program
    .command("orchestrator")
    .description("Manage Yoplai orchestrator")
    .version("0.1.0")
);
registerEvalCommands(program);

program
  .command("dream <agent-id>")
  .description("Run an agent's nightly self-consolidation")
  .option("--dry-run", "Show sessions that would be consolidated")
  .action(async (agentId, options) => {
    const config = loadConfig();
    setLoadedConfig(config);
    await loadExtensions(config);
    const result = await (await import("../dream/service.js")).runDream(agentId, { dryRun: options.dryRun });
    console.log(JSON.stringify(result, null, 2));
  });

// Auth commands
const authCmd = program
  .command("auth")
  .description("Manage OAuth authentication");

authCmd
  .command("login [provider]")
  .description(
    "Login to an OAuth provider (run without args to see available providers)"
  )
  .action(async (provider?: string) => {
    try {
      const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
      const runtime = await ModelRuntime.create({
        authPath: path.join(CONFIG_DIR, "auth.json"),
      });
      const providers = runtime
        .getProviders()
        .filter((p) => p.auth.oauth)
        .map((p) => ({ id: p.id, name: p.auth.oauth?.name ?? p.name }));

      // If no provider specified, show menu
      let selectedProvider = provider;
      if (!selectedProvider) {
        console.log("Select a provider:\n");
        providers.forEach((p, i) => console.log(`  ${i + 1}. ${p.name}`));
        console.log();

        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const choice = await new Promise<string>((resolve) =>
          rl.question("Enter number: ", resolve)
        );
        rl.close();

        const index = parseInt(choice, 10) - 1;
        if (index < 0 || index >= providers.length) {
          logError("Invalid selection", "Invalid selection");
          process.exit(1);
        }
        selectedProvider = providers[index].id;
      }

      // Validate provider
      const providerInfo = providers.find((p) => p.id === selectedProvider);
      if (!providerInfo) {
        logError("Unknown provider", selectedProvider);
        logError("Available providers", providers.map((p) => p.id).join(", "));
        process.exit(1);
      }

      console.log(`Logging in to ${providerInfo.name}...`);

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const ask = (question: string) =>
        new Promise<string>((resolve) => rl.question(question, resolve));
      await runtime.login(selectedProvider, "oauth", {
        notify: (event) => {
          if (event.type === "auth_url") {
            console.log(`\nOpen this URL in your browser:\n${event.url}`);
            if (event.instructions) console.log(event.instructions);
            console.log();
          } else if (event.type === "device_code") {
            console.log(`\nOpen this URL in your browser:\n${event.verificationUri}`);
            console.log(`Enter code: ${event.userCode}`);
            if (event.expiresInSeconds) {
              console.log(`Code expires in ${event.expiresInSeconds} seconds.`);
            }
            console.log();
          } else {
            console.log(event.message);
          }
        },
        prompt: async (prompt) => {
          if (prompt.type === "select") {
            console.log(`\n${prompt.message}`);
            prompt.options.forEach((option, i) => {
              console.log(`  ${i + 1}. ${option.label}`);
            });
            const index = parseInt(await ask("Enter number: "), 10) - 1;
            return prompt.options[index]?.id ?? "";
          }
          return ask(
            `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `
          );
        },
      });
      rl.close();

      console.log(`\nLogged in to ${providerInfo.name}`);
    } catch (err) {
      logError("Login failed", err);
      process.exit(1);
    }
  });

authCmd
  .command("status")
  .description("Show authentication status")
  .action(async () => {
    try {
      const { ModelRuntime, readStoredCredential } = await import(
        "@earendil-works/pi-coding-agent"
      );
      const authPath = path.join(CONFIG_DIR, "auth.json");
      const runtime = await ModelRuntime.create({ authPath });
      const providers = (await runtime.listCredentials()).map(
        (info) => info.providerId
      );

      if (providers.length === 0) {
        console.log(
          "No providers authenticated. Run 'yoplai auth login' to authenticate."
        );
        return;
      }

      console.log("Authenticated providers:");
      for (const provider of providers) {
        const cred = readStoredCredential(provider, authPath);
        if (!cred) continue;
        if (cred.type === "oauth") {
          const expires = new Date((cred as { expires: number }).expires);
          const isExpired = expires.getTime() < Date.now();
          console.log(
            `  - ${provider} (oauth) expires: ${expires.toLocaleString()}${isExpired ? " [EXPIRED]" : ""}`
          );
        } else {
          console.log(`  - ${provider} (${cred.type})`);
        }
      }
    } catch (err) {
      logError("Error", err);
      process.exit(1);
    }
  });

authCmd
  .command("logout <provider>")
  .description("Logout from a provider")
  .action(async (provider: string) => {
    try {
      const { ModelRuntime, readStoredCredential } = await import(
        "@earendil-works/pi-coding-agent"
      );
      const authPath = path.join(CONFIG_DIR, "auth.json");

      if (!readStoredCredential(provider, authPath)) {
        console.log(`Not logged in to ${provider}`);
        return;
      }

      const runtime = await ModelRuntime.create({ authPath });
      await runtime.logout(provider);
      console.log(`Logged out from ${provider}`);
    } catch (err) {
      logError("Error", err);
      process.exit(1);
    }
  });

program.parse();
