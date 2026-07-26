#!/usr/bin/env node
import { Command, Option } from "commander";
import os from "node:os";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  readEnv,
  type GatewayConfig,
  type StartPromptRole as SharedStartPromptRole,
} from "@yoplai/shared";
import { ApiClient } from "./client.js";
export { registerSlicesCommands } from "./slices.js";
export { runMigration, isGatewayRunning } from "./migrate.js";
import {
  describeMigration,
  migrateLocalConfig,
  previewMigration,
  resolveLocalConfigPath,
  validateLocalConfig,
} from "./local-config.js";
import { migrateProjectPitchFromReadme } from "./doc-migration.js";
import { runMigration as runProjectsMigration } from "./migrate.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type ProjectItem = {
  id: string;
  title: string;
  path: string;
  frontmatter: Record<string, unknown>;
  docs?: Record<string, string>;
};

type SimpleHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

function normalizeProjectId(id: string): string {
  return id.trim().toUpperCase();
}

function normalizeItem(item: ProjectItem) {
  const fm = item.frontmatter ?? {};
  return {
    id: item.id ?? (fm.id as string | undefined) ?? "",
    title: item.title ?? (fm.title as string | undefined) ?? "",
    status: (fm.status as string | undefined) ?? "",
    created: (fm.created as string | undefined) ?? "",
    path: item.path ?? "",
  };
}

function renderTable(items: ProjectItem[]): string {
  const headers = ["id", "title", "status", "created", "path"];
  const formatCell = (value: unknown) =>
    String(value ?? "")
      .replace(/\r?\n/g, "<br>")
      .replace(/\|/g, "\\|");
  const rows = items.map((item) => {
    const normalized = normalizeItem(item);
    return headers.map((key) =>
      formatCell(normalized[key as keyof typeof normalized])
    );
  });

  const headerRow = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return [headerRow, separator, body].filter(Boolean).join("\n");
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function readMarkdownArg(
  value: string,
  readStdinFn: () => Promise<string> = readStdin
): Promise<string> {
  if (value === "-") return readStdinFn();
  if (value.startsWith("@")) {
    return readFile(value.slice(1), "utf8");
  }
  return value;
}

export async function buildCreateProjectBody(
  pitch: string | undefined,
  opts: {
    title: string;
    pitch?: string;
    specs?: string;
    status?: string;
    area?: string;
    repo?: string;
  },
  client: Pick<ApiClient, "listAreas">,
  readStdinFn: () => Promise<string> = readStdin
): Promise<Record<string, unknown>> {
  if (opts.specs !== undefined) {
    throw new Error(
      "Project-level --specs was removed. Use --pitch for project prose or `yoplai slices add --specs` for slice specs."
    );
  }
  if (pitch !== undefined && opts.pitch !== undefined) {
    throw new Error("Use either positional <pitch> or --pitch, not both.");
  }

  const body: Record<string, unknown> = { title: opts.title };
  const pitchValue = opts.pitch !== undefined ? opts.pitch : pitch;
  if (pitchValue !== undefined) {
    body.pitch = await readMarkdownArg(pitchValue, readStdinFn);
  }
  if (opts.status) body.status = opts.status;
  const area = await resolveCreateAreaDetails(client, opts.area);
  if (area) {
    body.area = area.id;
    if (area.repo) body.repo = area.repo;
  }
  if (opts.repo !== undefined) body.repo = opts.repo;
  return body;
}

type CommentArgs = {
  projectId: string;
  author: string;
  message: string;
};

export function createProjectCommentHandler(options?: {
  baseUrl?: string;
  token?: string;
  fetchImpl?: FetchLike;
}): (args: CommentArgs) => Promise<Response> {
  const baseUrl =
    options?.baseUrl ?? readEnv("YOPLAI_API_URL") ?? readEnv("YOPLAI_URL");
  if (!baseUrl) {
    throw new Error("Missing baseUrl for comment handler");
  }
  const fetchImpl = options?.fetchImpl ?? fetch;
  const token = options?.token;
  return (args) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetchImpl(
      new URL(`/api/projects/${args.projectId}/comments`, baseUrl).toString(),
      {
        method: "POST",
        headers,
        body: JSON.stringify({ author: args.author, message: args.message }),
      }
    );
  };
}

function formatMessages(items: SimpleHistoryMessage[]): string {
  if (items.length === 0) return "No messages.";
  return items.map((item) => `- ${item.role}: ${item.content}`).join("\n");
}

function mapSubagentStatus(
  status: string | undefined
): "running" | "idle" | "error" {
  if (status === "running") return "running";
  if (status === "error") return "error";
  return "idle";
}

type StartPromptRole = SharedStartPromptRole;

type StartCommandOpts = {
  agent?: string;
  name?: string;
  model?: string;
  reasoningEffort?: string;
  thinking?: string;
  mode?: string;
  branch?: string;
  slug?: string;
  customPrompt?: string;
  subagent?: string;
  promptRole?: string;
  allowOverrides?: boolean;
  includeDefaultPrompt?: boolean;
  excludeDefaultPrompt?: boolean;
  includeRoleInstructions?: boolean;
  excludeRoleInstructions?: boolean;
  includePostRun?: boolean;
  excludePostRun?: boolean;
};

function toStartPromptRole(
  value: string | undefined
): StartPromptRole | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "coordinator") return "coordinator";
  if (normalized === "worker") return "worker";
  if (normalized === "reviewer") return "reviewer";
  if (normalized === "legacy") return "legacy";
  return undefined;
}

export function buildStartRequestBody(opts: StartCommandOpts): {
  body: Record<string, unknown>;
  errors: string[];
} {
  const body: Record<string, unknown> = {};
  const errors: string[] = [];
  const hasSubagent =
    typeof opts.subagent === "string" && opts.subagent.trim().length > 0;
  const allowOverrides = opts.allowOverrides === true;

  if (hasSubagent) {
    body.subagentTemplate = opts.subagent!.trim();

    if (!allowOverrides) {
      const hasLockedOverrides =
        (typeof opts.agent === "string" && opts.agent.trim().length > 0) ||
        (typeof opts.model === "string" && opts.model.trim().length > 0) ||
        (typeof opts.reasoningEffort === "string" &&
          opts.reasoningEffort.trim().length > 0) ||
        (typeof opts.thinking === "string" &&
          opts.thinking.trim().length > 0) ||
        (typeof opts.mode === "string" && opts.mode.trim().length > 0) ||
        (typeof opts.branch === "string" && opts.branch.trim().length > 0) ||
        (typeof opts.promptRole === "string" &&
          opts.promptRole.trim().length > 0);
      if (hasLockedOverrides) {
        errors.push(
          "Subagent profile locked. Use --allow-overrides to override."
        );
        return { body, errors };
      }
    }
  }

  if (typeof opts.agent === "string" && opts.agent.trim()) {
    const agentValue = opts.agent.trim();
    body.runAgent = agentValue.includes(":") ? agentValue : `cli:${agentValue}`;
  }
  if (typeof opts.name === "string" && opts.name.trim()) {
    body.name = opts.name.trim();
  }
  if (typeof opts.model === "string" && opts.model.trim()) {
    body.model = opts.model.trim();
  }
  if (typeof opts.reasoningEffort === "string" && opts.reasoningEffort.trim()) {
    body.reasoningEffort = opts.reasoningEffort.trim();
  }
  if (typeof opts.thinking === "string" && opts.thinking.trim()) {
    body.thinking = opts.thinking.trim();
  }
  if (typeof opts.mode === "string" && opts.mode.trim()) {
    body.runMode = opts.mode.trim();
  }
  if (typeof opts.branch === "string" && opts.branch.trim()) {
    body.baseBranch = opts.branch.trim();
  }
  if (typeof opts.slug === "string" && opts.slug.trim()) {
    body.slug = opts.slug.trim();
  }

  if (typeof opts.promptRole === "string" && opts.promptRole.trim()) {
    const promptRole = toStartPromptRole(opts.promptRole);
    if (!promptRole) {
      errors.push(
        "Invalid --prompt-role value. Use coordinator|worker|reviewer|legacy."
      );
    } else {
      body.promptRole = promptRole;
    }
  }

  if (opts.excludeDefaultPrompt) body.includeDefaultPrompt = false;
  else if (opts.includeDefaultPrompt) body.includeDefaultPrompt = true;

  if (opts.excludeRoleInstructions) body.includeRoleInstructions = false;
  else if (opts.includeRoleInstructions) body.includeRoleInstructions = true;

  if (opts.excludePostRun) body.includePostRun = false;
  else if (opts.includePostRun) body.includePostRun = true;

  return { body, errors };
}

function getClient() {
  return new ApiClient();
}

export async function resolveCreateArea(
  client: Pick<ApiClient, "listAreas">,
  area: string | undefined
): Promise<string | undefined> {
  return (await resolveCreateAreaDetails(client, area))?.id;
}

async function resolveCreateAreaDetails(
  client: Pick<ApiClient, "listAreas">,
  area: string | undefined
): Promise<{ id: string; repo?: string } | undefined> {
  if (!area) return undefined;
  const areasList = (await client.listAreas()) as Array<{
    id: string;
    title: string;
    repo?: string;
  }>;
  const validIds = areasList.map((item) => item.id);
  if (!validIds.includes(area)) {
    throw new Error(
      `Error: Invalid area "${area}". Valid areas: ${validIds.join(", ")}`
    );
  }
  return areasList.find((item) => item.id === area);
}

function fail(err: unknown): never {
  if (err instanceof Error) console.error(err.message);
  else console.error("Request failed");
  process.exit(1);
}

function formatComponentList(config: GatewayConfig): string {
  const extensions = Object.entries(config.extensions ?? {})
    .filter(
      ([, value]) =>
        value && (value as Record<string, unknown>).enabled !== false
    )
    .map(([key]) => key);
  return extensions.length > 0 ? extensions.join(", ") : "none";
}

function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.log(`Warning: ${warning}`);
  }
}

function formatValidationError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray((error as { issues?: unknown }).issues)
  ) {
    return (
      error as { issues: Array<{ path?: unknown[]; message?: string }> }
    ).issues
      .map((issue) => {
        const path =
          Array.isArray(issue.path) && issue.path.length > 0
            ? issue.path.join(".")
            : "config";
        return `${path}: ${issue.message ?? "Invalid value"}`;
      })
      .join("\n");
  }

  if (error instanceof Error) return error.message;
  return "Validation failed";
}

export function runConfigMigrateCommand(opts?: {
  config?: string;
  dryRun?: boolean;
}): void {
  const preview = previewMigration(opts?.config);
  console.log(`Config path: ${preview.path}`);
  console.log(`Config version: ${preview.version.label}`);
  printWarnings(preview.warnings);

  if (opts?.dryRun) {
    if (!preview.changed) {
      console.log("Config already at version 2. No changes required.");
      console.log("No changes written (dry run).");
      return;
    }

    console.log("Migration would:");
    for (const action of describeMigration(
      preview.originalConfig,
      preview.migratedConfig
    )) {
      console.log(`  - ${action}`);
    }
    console.log("No changes written (dry run).");
    return;
  }

  const result = migrateLocalConfig(opts?.config);
  if (!result.changed) {
    console.log("Config already at version 2. No changes written.");
    return;
  }

  console.log(`Migrated ${result.path} from v${result.version.number} -> v2`);
  console.log(`Backup saved to ${result.backupPath}`);
  if (result.warnings.length > 0) {
    printWarnings(result.warnings);
  }
}

export function runConfigValidateCommand(opts?: { config?: string }): void {
  const result = validateLocalConfig(opts?.config);
  console.log(`Config path: ${resolveLocalConfigPath(opts?.config)}`);
  console.log(
    `Config version: ${result.migrated ? result.version.label : "2"}`
  );
  if (result.warnings.length > 0) {
    printWarnings(result.warnings);
  }
  console.log(
    `Agents: ${result.config.agents.map((agent) => agent.id).join(", ") || "none"}`
  );
  console.log(`Components: ${formatComponentList(result.config)}`);
  console.log("Config is valid");
}

export function registerProjectsCommands(program: Command): Command {
  const configCommand = program
    .command("config")
    .description("Manage local Yoplai config");

  configCommand
    .command("migrate")
    .description("Migrate local config from v1 to v2")
    .option("--config <path>", "Config path")
    .option("--dry-run", "Preview migration without writing")
    .action((opts) => {
      try {
        runConfigMigrateCommand(opts as { config?: string; dryRun?: boolean });
      } catch (err) {
        fail(err);
      }
    });

  configCommand
    .command("validate")
    .description("Validate local Yoplai config")
    .option("--config <path>", "Config path")
    .action((opts) => {
      try {
        runConfigValidateCommand(opts as { config?: string });
      } catch (err) {
        console.error(formatValidationError(err));
        process.exit(1);
      }
    });

  program
    .command("list")
    .option("--status <status>", "Filter by status")
    .option("-j, --json", "JSON output")
    .action(async (opts) => {
      try {
        const items = (await getClient().listProjects()) as ProjectItem[];
        let filtered = items;
        if (opts.status) {
          filtered = filtered.filter(
            (item) => String(item.frontmatter?.status ?? "") === opts.status
          );
        }
        if (opts.json) {
          console.log(JSON.stringify(filtered, null, 2));
          return;
        }
        console.log(renderTable(filtered));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("agent", { hidden: true })
    .description("Manage agents")
    .command("list")
    .description("List all configured agents")
    .action(async () => {
      try {
        const agents = (await getClient().listAgents()) as Array<{
          id: string;
          name: string;
          model?: { provider?: string; model?: string };
        }>;
        console.log("Configured agents:");
        for (const agent of agents) {
          const provider = agent.model?.provider ?? "unknown";
          const model = agent.model?.model ?? "unknown";
          console.log(`  - ${agent.id}: ${agent.name} (${provider}/${model})`);
        }
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("create")
    .argument("[pitch]", "Project pitch body")
    .requiredOption("-t, --title <title>", "Project title")
    .option(
      "--pitch <content>",
      "Pitch content string, @file, or '-' for stdin"
    )
    .addOption(
      new Option(
        "--specs <content>",
        "Removed: use --pitch or slices add --specs"
      ).hideHelp()
    )
    .option("--status <status>", "Status")
    .option("--area <area>", "Area")
    .option("--repo <path>", "Repo path")
    .option("-j, --json", "JSON output")
    .action(async (pitch, opts) => {
      try {
        const client = getClient();
        const body = await buildCreateProjectBody(pitch, opts, client);

        const data = (await client.createProject(body)) as ProjectItem;
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(renderTable([data]));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("pitch")
    .argument("<id>", "Project ID")
    .requiredOption("--from-readme", "Copy README.md body to PITCH.md")
    .option("--force", "Overwrite existing PITCH.md")
    .action(async (id, opts) => {
      try {
        const result = await migrateProjectPitchFromReadme(id, {
          force: opts.force === true,
        });
        console.log(result.message);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("get")
    .argument("<id>", "Project ID")
    .option("-j, --json", "JSON output")
    .action(async (id, opts) => {
      try {
        const normalizedId = normalizeProjectId(id);
        const project = (await getClient().getProject(
          normalizedId
        )) as ProjectItem;
        if (opts.json) {
          console.log(JSON.stringify(project, null, 2));
          return;
        }
        console.log(renderTable([project]));
        const readme = project.docs?.README;
        if (typeof readme === "string" && readme.trim().length > 0) {
          console.log("");
          console.log(readme.trim());
        }
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("update")
    .argument("<id>", "Project ID")
    .option("--title <title>", "Title")
    .option("--status <status>", "Status")
    .option("--repo <path>", "Repo path")
    .option("--readme <content>", "README content string or '-' for stdin")
    .option("--specs <content>", "SPECS content string or '-' for stdin")
    .option("-j, --json", "JSON output")
    .action(async (id, opts) => {
      try {
        const normalizedId = normalizeProjectId(id);
        const body: Record<string, unknown> = {};
        if (opts.title) body.title = opts.title;
        if (opts.status) body.status = opts.status;
        if (opts.repo !== undefined) body.repo = opts.repo;
        let stdinContent: string | undefined;
        const readStdinOnce = async () => {
          if (stdinContent === undefined) stdinContent = await readStdin();
          return stdinContent;
        };
        if (opts.readme !== undefined) {
          body.readme =
            opts.readme === "-" ? await readStdinOnce() : opts.readme;
        }
        if (opts.specs !== undefined) {
          body.specs = opts.specs === "-" ? await readStdinOnce() : opts.specs;
        }
        if (opts.readme === undefined && opts.specs === undefined) {
          const pipedContent =
            process.stdin.isTTY === false ? await readStdin() : "";
          if (pipedContent.length > 0) {
            body.specs = pipedContent;
          }
        }

        const data = (await getClient().updateProject(
          normalizedId,
          body
        )) as ProjectItem;
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(renderTable([data]));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("comment")
    .argument("<id>", "Project ID")
    .requiredOption(
      "-m, --message <message>",
      "Comment text (use '-' for stdin)"
    )
    .option("--author <author>", "Comment author")
    .option("-j, --json", "JSON output")
    .action(async (id, opts) => {
      try {
        const normalizedId = normalizeProjectId(id);
        const raw = opts.message === "-" ? await readStdin() : opts.message;
        const message = raw.replace(/\\n/g, "\n");
        const author = opts.author ?? os.userInfo().username ?? "unknown";
        const data = await getClient().addComment(normalizedId, {
          author,
          message,
        });
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log("Comment added.");
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("move")
    .argument("<id>", "Project ID")
    .argument("<status>", "New status")
    .option("--agent <name>", "Agent name")
    .option("-j, --json", "JSON output")
    .action(async (id, status, opts) => {
      try {
        const normalizedId = normalizeProjectId(id);
        const body: Record<string, unknown> = { status };
        if (opts.agent) body.agent = opts.agent;
        const data = (await getClient().updateProject(
          normalizedId,
          body
        )) as ProjectItem;
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(renderTable([data]));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("resume")
    .argument("<id>", "Project ID")
    .requiredOption(
      "-m, --message <message>",
      "Message to send (use '-' for stdin)"
    )
    .option("--slug <slug>", "Slug override (CLI clone/worktree resume)")
    .option("-j, --json", "JSON output")
    .action(async (id, opts) => {
      try {
        const normalizedId = normalizeProjectId(id);
        const message = opts.message === "-" ? await readStdin() : opts.message;
        const project = (await getClient().getProject(
          normalizedId
        )) as ProjectItem;
        const frontmatter = project.frontmatter ?? {};
        const sessionKeys =
          typeof frontmatter.sessionKeys === "object" &&
          frontmatter.sessionKeys !== null
            ? (frontmatter.sessionKeys as Record<string, string>)
            : {};
        const requestedSlug =
          typeof opts.slug === "string" ? opts.slug.trim() : "";

        if (!requestedSlug && Object.keys(sessionKeys).length > 0) {
          const [agentId, sessionKey] = Object.entries(sessionKeys)[0] ?? [];
          if (!agentId || !sessionKey) {
            console.error("No sessionKey available for resume.");
            process.exit(1);
          }
          const data = await getClient().request(
            `/agents/${agentId}/messages`,
            {
              method: "POST",
              body: { message, sessionKey },
            }
          );
          if (opts.json) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          console.log(`Sent message (sessionKey: ${sessionKey})`);
          return;
        }

        const subagentsData = (await getClient().listProjectSubagents(
          normalizedId
        )) as {
          items?: Array<{ slug?: string; cli?: string; runMode?: string }>;
        };
        const items = Array.isArray(subagentsData.items)
          ? subagentsData.items
          : [];
        const fallbackSlug =
          items.find((entry) => entry.slug === "main")?.slug ??
          (items.length === 1 ? items[0]?.slug : "");
        const slug = requestedSlug || fallbackSlug;
        if (!slug) {
          console.error("Slug required to resume CLI run.");
          process.exit(1);
        }
        const item = items.find((entry) => entry.slug === slug);
        if (!item?.cli) {
          console.error("CLI not found for slug.");
          process.exit(1);
        }
        const runMode =
          item.runMode === "clone"
            ? "clone"
            : item.runMode === "worktree"
              ? "worktree"
              : "main-run";
        const data = await getClient().spawnProjectSubagent(normalizedId, {
          slug,
          cli: item.cli,
          prompt: message,
          mode: runMode,
          resume: true,
        });
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(`Resumed CLI run (slug: ${slug})`);
        return;
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("rename")
    .argument("<id>", "Project ID")
    .requiredOption("--slug <slug>", "Subagent slug")
    .option("--name <name>", "New run name")
    .option("--model <id>", "Model id")
    .option("--reasoning-effort <level>", "Reasoning effort")
    .option("--thinking <level>", "Thinking level")
    .option("-j, --json", "JSON output")
    .action(async (id, opts) => {
      try {
        const normalizedId = normalizeProjectId(id);
        const slug =
          typeof opts.slug === "string" && opts.slug.trim()
            ? opts.slug.trim()
            : "";
        if (!slug) {
          console.error("Slug required.");
          process.exit(1);
        }

        const body: Record<string, unknown> = {};
        if (typeof opts.name === "string" && opts.name.trim()) {
          body.name = opts.name.trim();
        }
        if (typeof opts.model === "string" && opts.model.trim()) {
          body.model = opts.model.trim();
        }
        if (
          typeof opts.reasoningEffort === "string" &&
          opts.reasoningEffort.trim()
        ) {
          body.reasoningEffort = opts.reasoningEffort.trim();
        }
        if (typeof opts.thinking === "string" && opts.thinking.trim()) {
          body.thinking = opts.thinking.trim();
        }
        if (Object.keys(body).length === 0) {
          console.error(
            "At least one of --name/--model/--reasoning-effort/--thinking is required."
          );
          process.exit(1);
        }

        const data = await getClient().updateProjectSubagent(
          normalizedId,
          slug,
          body
        );
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(`Updated subagent ${slug}`);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("status")
    .argument("<id>", "Project ID")
    .option("--limit <n>", "Number of messages to return", "10")
    .option("--slug <slug>", "Slug override (CLI clone/worktree)")
    .option("--list", "List existing subagent session slugs")
    .option("-j, --json", "JSON output")
    .action(async (id, opts) => {
      try {
        const normalizedId = normalizeProjectId(id);
        if (opts.list) {
          const subagentsData = (await getClient().listProjectSubagents(
            normalizedId,
            { includeArchived: true }
          )) as {
            items?: Array<{ slug?: string }>;
          };
          const slugs = (
            Array.isArray(subagentsData.items) ? subagentsData.items : []
          )
            .map((item) => item.slug?.trim())
            .filter((slug): slug is string => Boolean(slug));
          if (opts.json) {
            console.log(JSON.stringify(slugs, null, 2));
            return;
          }
          if (slugs.length > 0) {
            console.log(slugs.join("\n"));
          }
          return;
        }

        const limit = Math.max(0, Number(opts.limit) || 10);
        const project = (await getClient().getProject(
          normalizedId
        )) as ProjectItem;
        const frontmatter = project.frontmatter ?? {};
        const sessionKeys =
          typeof frontmatter.sessionKeys === "object" &&
          frontmatter.sessionKeys !== null
            ? (frontmatter.sessionKeys as Record<string, string>)
            : {};
        const requestedSlug =
          typeof opts.slug === "string" ? opts.slug.trim() : "";

        if (!requestedSlug && Object.keys(sessionKeys).length > 0) {
          const [agentId, sessionKey] = Object.entries(sessionKeys)[0] ?? [];
          if (!agentId || !sessionKey) {
            console.error("No sessionKey available for status.");
            process.exit(1);
          }
          const statusData = (await getClient().getAgentStatus(agentId)) as {
            isStreaming?: boolean;
          };
          const historyData = (await getClient().getAgentHistory(
            agentId,
            sessionKey
          )) as {
            messages?: SimpleHistoryMessage[];
          };
          const messages = Array.isArray(historyData.messages)
            ? historyData.messages
            : [];
          const recent = messages.slice(-limit);
          const payload = {
            type: "native",
            agentId,
            sessionKey,
            status: statusData.isStreaming ? "running" : "idle",
            messages: recent,
          };
          if (opts.json) {
            console.log(JSON.stringify(payload, null, 2));
            return;
          }
          console.log(`Status: ${payload.status}`);
          console.log(formatMessages(recent));
          return;
        }

        const subagentsData = (await getClient().listProjectSubagents(
          normalizedId
        )) as {
          items?: Array<{ slug?: string; status?: string; cli?: string }>;
        };
        const items = Array.isArray(subagentsData.items)
          ? subagentsData.items
          : [];
        const fallbackSlug =
          items.find((entry) => entry.slug === "main")?.slug ??
          (items.length === 1 ? items[0]?.slug : "");
        const slug = requestedSlug || fallbackSlug;
        if (!slug) {
          console.error("Slug required to fetch CLI status.");
          process.exit(1);
        }
        const item = items.find((entry) => entry.slug === slug);
        const status = mapSubagentStatus(item?.status);
        const logsData = (await getClient().getSubagentLogs(
          normalizedId,
          slug
        )) as {
          events?: Array<{ type?: string; text?: string }>;
        };
        const events = Array.isArray(logsData.events) ? logsData.events : [];
        const messages = events
          .filter((ev) => ev.type === "user" || ev.type === "assistant")
          .map((ev) => ({
            role: ev.type === "user" ? "user" : "assistant",
            content: ev.text ?? "",
          }))
          .filter((ev) => ev.content.length > 0) as SimpleHistoryMessage[];
        const recent = messages.slice(-limit);
        const payload = {
          type: "cli",
          cli: item?.cli,
          slug,
          status,
          messages: recent,
        };
        if (opts.json) {
          console.log(JSON.stringify(payload, null, 2));
          return;
        }
        console.log(`Status: ${payload.status}`);
        console.log(formatMessages(recent));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("archive")
    .argument("<id>", "Project ID")
    .option("-j, --json", "JSON output")
    .action(async (id, opts) => {
      try {
        const normalizedId = normalizeProjectId(id);
        const data = await getClient().archiveProject(normalizedId);
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(`Archived project ${normalizedId}`);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("unarchive")
    .argument("<id>", "Project ID")
    .option("-j, --json", "JSON output")
    .action(async (id, opts) => {
      try {
        const normalizedId = normalizeProjectId(id);
        const data = await getClient().unarchiveProject(normalizedId);
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(`Unarchived project ${normalizedId}`);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("migrate-to-slices")
    .description("Migrate legacy projects to slice layout")
    .option("--config <path>", "Config path")
    .action(async (opts) => {
      try {
        const result = await runProjectsMigration({
          config: opts.config as string | undefined,
        });
        for (const r of result.projects) {
          if (r.outcome === "skipped") {
            console.log(
              `  skip    ${r.id}${r.legacyStatus ? ` (${r.legacyStatus})` : ""}`
            );
          } else if (r.outcome === "no-slice") {
            console.log(
              `  shaping ${r.id} (${r.legacyStatus} → project:${r.projectStatus}, no slice)`
            );
          } else {
            console.log(
              `  migrate ${r.id} (${r.legacyStatus} → project:${r.projectStatus}, ${r.sliceId}:${r.sliceStatus})`
            );
          }
        }
        console.log(
          `\nDone. migrated=${result.migratedCount} no-slice=${result.noSliceCount} skipped=${result.skippedCount}`
        );
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("start")
    .argument("<id>", "Project ID")
    .option("--agent <agent>", "Agent name (cli name or yoplai:<id>)")
    .option("--name <name>", "Optional spawned CLI run name")
    .option("--model <model>", "Model override for CLI harness")
    .option("--reasoning-effort <level>", "Reasoning effort (codex|claude)")
    .option("--thinking <level>", "Thinking level (pi)")
    .option("--mode <mode>", "Run mode (main-run|clone|worktree|none)")
    .option("--branch <branch>", "Base branch for clone/worktree")
    .option("--slug <slug>", "Slug override (clone/worktree)")
    .option(
      "--subagent <name>",
      "Subagent template name from yoplai.json config (e.g. Worker, Reviewer)"
    )
    .option(
      "--prompt-role <role>",
      "Prompt role override (coordinator|worker|reviewer|legacy)"
    )
    .option(
      "--allow-overrides",
      "Allow overriding locked subagent profile fields"
    )
    .option(
      "--include-default-prompt",
      "Force include default project prompt context"
    )
    .option(
      "--exclude-default-prompt",
      "Force exclude default project prompt context"
    )
    .option(
      "--include-role-instructions",
      "Force include role instructions in generated prompt"
    )
    .option(
      "--exclude-role-instructions",
      "Force exclude role instructions in generated prompt"
    )
    .option("--include-post-run", "Force include post-run instruction block")
    .option("--exclude-post-run", "Force exclude post-run instruction block")
    .option("--custom-prompt <prompt>", "Custom prompt (use '-' for stdin)")
    .option("-j, --json", "JSON output")
    .action(async (id, opts) => {
      try {
        const normalizedId = normalizeProjectId(id);
        const { body, errors } = buildStartRequestBody(
          opts as StartCommandOpts
        );
        if (errors.length > 0) {
          console.error(errors.join("\n"));
          process.exit(1);
        }
        if (opts.customPrompt !== undefined) {
          body.customPrompt =
            opts.customPrompt === "-" ? await readStdin() : opts.customPrompt;
        }

        const data = (await getClient().startProject(normalizedId, body)) as {
          type?: "native" | "aihub" | "cli";
          sessionKey?: string;
          slug?: string;
          runMode?: string;
        };
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        // "aihub" is the pre-rename wire value a legacy gateway still emits;
        // intentionally retained per rename spec section 2.
        if (data.type === "native" || data.type === "aihub") {
          console.log(`Started Yoplai run (sessionKey: ${data.sessionKey})`);
          return;
        }
        if (data.type === "cli") {
          console.log(
            `Started CLI run (slug: ${data.slug}, mode: ${data.runMode})`
          );
          return;
        }
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        fail(err);
      }
    });

  return program;
}

export function createProjectsCommand(): Command {
  return registerProjectsCommands(
    new Command("projects")
      .description("Manage Yoplai projects")
      .version("0.1.0")
  );
}

export const program = createProjectsCommand();

function isDirectRun(): boolean {
  try {
    const argv1 = realpathSync(process.argv[1]);
    const self = realpathSync(fileURLToPath(import.meta.url));
    return argv1 === self;
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
}

if (isDirectRun()) {
  program.parseAsync(process.argv);
}
