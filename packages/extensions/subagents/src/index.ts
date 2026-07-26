import { Hono } from "hono";
import { z } from "zod";
import type {
  Extension,
  ExtensionContext,
  OrchestratorSource,
  SubagentRuntimeCli,
} from "@yoplai/shared";
import { SubagentsExtensionConfigSchema } from "@yoplai/shared";
import {
  archiveSubagent,
  getSubagentLogs as getProjectSubagentLogs,
  interruptSubagent as interruptProjectSubagent,
  killSubagent as killProjectSubagent,
  listAllSubagents,
  spawnProjectSubagent,
} from "@yoplai/extension-projects";
import {
  resolveProfile as resolveRuntimeProfile,
  runtimeProfiles,
} from "@yoplai/extension-projects/profiles/resolver";
import {
  deleteSubagentRun,
  getLiveSubagentRunsByCwd,
  getSubagentLogs,
  getSubagentRun,
  isSupportedSubagentCli,
  listSubagentRuns,
  parseSubagentParent,
  resumeSubagentRun,
  setSubagentArchived,
  startSubagentRun,
  interruptSubagentRun,
} from "./runtime.js";

let extensionContext: ExtensionContext | null = null;
const registeredApps = new WeakSet<object>();

function getContext(): ExtensionContext {
  if (!extensionContext) throw new Error("Subagents extension not started");
  return extensionContext;
}

function runtimeOptions() {
  const ctx = getContext();
  return {
    dataDir: ctx.getDataDir(),
    emit: (event: Parameters<ExtensionContext["emit"]>[1]) => {
      ctx.emit("subagent.changed", event);
    },
  };
}

function profiles() {
  return runtimeProfiles(getContext().getConfig());
}

function resolveProfile(name: string | undefined) {
  if (!name) return undefined;
  return resolveRuntimeProfile(getContext().getConfig(), name);
}

function profileNames(): string[] {
  return profiles().map((profile) => profile.name);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readParent(value: unknown): ReturnType<typeof parseSubagentParent> {
  if (!value) return undefined;
  if (typeof value === "string") return parseSubagentParent(value);
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || typeof record.id !== "string") {
    return undefined;
  }
  return { type: record.type, id: record.id };
}

function statusFromQuery(value: string | undefined) {
  const parsed = z
    .enum(["starting", "running", "done", "error", "interrupted"])
    .safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function sourceFromQuery(
  value: string | undefined
): OrchestratorSource | "all" {
  if (value === "manual" || value === "orchestrator") return value;
  return "all";
}

function projectRunId(projectId: string, slug: string): string {
  return `${projectId}:${slug}`;
}

function parseProjectRunId(runId: string):
  | { projectId: string; slug: string }
  | undefined {
  const match = runId.match(/^(PRO-\d+):(.+)$/);
  if (!match?.[1] || !match[2]) return undefined;
  return { projectId: match[1], slug: match[2] };
}

function mapProjectStatus(status: string) {
  if (status === "running") return "running";
  if (status === "error") return "error";
  return "done";
}

function registerSubagentRoutes(app: Hono): void {
  if (registeredApps.has(app)) return;
  registeredApps.add(app);

  app.get("/subagents", async (c) => {
    const parent = parseSubagentParent(c.req.query("parent"));
    const status = statusFromQuery(c.req.query("status"));
    const statusQuery = c.req.query("status");
    const source = sourceFromQuery(c.req.query("source"));
    const projectId = readOptionalString(c.req.query("projectId"));
    const sliceId = readOptionalString(c.req.query("sliceId"));
    const includeArchived = ["1", "true"].includes(
      c.req.query("includeArchived") ?? ""
    );
    const cwd = readOptionalString(c.req.query("cwd"));
    const runtimeItems = await listSubagentRuns(runtimeOptions(), {
      parent,
      status,
      includeArchived,
      cwd,
      projectId,
      sliceId,
    });
    if (parent || cwd || includeArchived) {
      if (!projectId && !sliceId) return c.json({ items: runtimeItems });
    }
    const projectItems = (
      await listAllSubagents(getContext().getConfig(), {
        projectId,
        sliceId,
        status: statusQuery,
        includeArchived,
        cwd,
      })
    )
      .filter((item) => source === "all" || item.source === source)
      .map((item) => ({
        ...item,
        id: projectRunId(item.projectId ?? "", item.slug),
        label: item.name ?? item.slug,
        status: mapProjectStatus(item.status),
        startedAt: item.runStartedAt,
      }));
    const items =
      source === "orchestrator"
        ? projectItems
        : [...runtimeItems, ...projectItems];
    return c.json({ items });
  });

  app.post("/subagents", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const profileName = readOptionalString(body.profile);
    const profile = resolveProfile(profileName);
    if (profileName && !profile) {
      const available = profileNames();
      return c.json(
        {
          error: `Unknown subagent profile: ${profileName}${
            available.length
              ? `. Available profiles: ${available.join(", ")}`
              : ""
          }`,
        },
        400
      );
    }
    const cli = readOptionalString(body.cli) ?? profile?.cli;
    const cwd = readOptionalString(body.cwd);
    const prompt = readOptionalString(body.prompt);
    const label = readOptionalString(body.label) ?? profile?.labelPrefix;
    const model = readOptionalString(body.model) ?? profile?.model;
    const reasoningEffort =
      readOptionalString(body.reasoningEffort) ?? profile?.reasoningEffort;
    const parent = readParent(body.parent);
    const projectId = readOptionalString(body.projectId);
    const sliceId = readOptionalString(body.sliceId);

    if (!cli || !isSupportedSubagentCli(cli)) {
      return c.json({ error: "cli must be codex, claude, or pi" }, 400);
    }
    if (!cwd || !prompt || !label) {
      return c.json({ error: "cwd, prompt, and label are required" }, 400);
    }

    try {
      const run = await startSubagentRun(runtimeOptions(), {
        cli: cli as SubagentRuntimeCli,
        cwd,
        prompt,
        label,
        parent,
        projectId,
        sliceId,
        model,
        reasoningEffort,
      });
      return c.json(run, 201);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400
      );
    }
  });

  app.get("/subagents/:runId", async (c) => {
    const run = await getSubagentRun(runtimeOptions(), c.req.param("runId"));
    if (!run) return c.json({ error: "Subagent not found" }, 404);
    return c.json(run);
  });

  app.post("/subagents/:runId/resume", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const prompt = readOptionalString(body.prompt);
    if (!prompt) return c.json({ error: "prompt is required" }, 400);
    try {
      const projectRun = parseProjectRunId(c.req.param("runId"));
      if (projectRun) {
        const config = getContext().getConfig();
        const existing = (await listAllSubagents(config)).find(
          (item) =>
            item.projectId === projectRun.projectId &&
            item.slug === projectRun.slug
        );
        if (!existing?.cli) {
          return c.json(
            { error: `Subagent not found: ${projectRun.slug}` },
            404
          );
        }
        const result = await spawnProjectSubagent(config, projectRun.projectId, {
          slug: projectRun.slug,
          cli: existing.cli,
          prompt,
          mode: existing.runMode,
          resume: true,
        });
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.data, result.status);
      }
      const run = await resumeSubagentRun(
        runtimeOptions(),
        c.req.param("runId"),
        {
          prompt,
        }
      );
      return c.json(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.startsWith("Subagent not found") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.post("/subagents/:runId/interrupt", async (c) => {
    try {
      const projectRun = parseProjectRunId(c.req.param("runId"));
      if (projectRun) {
        const result = await interruptProjectSubagent(
          getContext().getConfig(),
          projectRun.projectId,
          projectRun.slug
        );
        if (!result.ok) return c.json({ error: result.error }, 400);
        return c.json(result.data);
      }
      const run = await interruptSubagentRun(
        runtimeOptions(),
        c.req.param("runId")
      );
      return c.json(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.startsWith("Subagent not found") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.post("/subagents/:runId/archive", async (c) => {
    try {
      const projectRun = parseProjectRunId(c.req.param("runId"));
      if (projectRun) {
        const result = await archiveSubagent(
          getContext().getConfig(),
          projectRun.projectId,
          projectRun.slug
        );
        if (!result.ok) return c.json({ error: result.error }, 400);
        return c.json(result.data);
      }
      const run = await setSubagentArchived(
        runtimeOptions(),
        c.req.param("runId"),
        true
      );
      return c.json(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.startsWith("Subagent not found") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.post("/subagents/:runId/unarchive", async (c) => {
    try {
      const run = await setSubagentArchived(
        runtimeOptions(),
        c.req.param("runId"),
        false
      );
      return c.json(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.startsWith("Subagent not found") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.delete("/subagents/:runId", async (c) => {
    try {
      const projectRun = parseProjectRunId(c.req.param("runId"));
      if (projectRun) {
        const result = await killProjectSubagent(
          getContext().getConfig(),
          projectRun.projectId,
          projectRun.slug
        );
        if (!result.ok) return c.json({ error: result.error }, 400);
        return c.json({ ok: true });
      }
      await deleteSubagentRun(runtimeOptions(), c.req.param("runId"));
      return c.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.startsWith("Subagent not found") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.get("/subagents/:runId/logs", async (c) => {
    const since = Number(c.req.query("since") ?? "0");
    if (!Number.isFinite(since) || since < 0) {
      return c.json({ error: "Invalid since cursor" }, 400);
    }
    const projectRun = parseProjectRunId(c.req.param("runId"));
    if (projectRun) {
      const result = await getProjectSubagentLogs(
        getContext().getConfig(),
        projectRun.projectId,
        projectRun.slug,
        since
      );
      if (!result.ok) return c.json({ error: result.error }, 404);
      return c.json(result.data);
    }
    const run = await getSubagentRun(runtimeOptions(), c.req.param("runId"));
    if (!run) return c.json({ error: "Subagent not found" }, 404);
    const logs = await getSubagentLogs(
      runtimeOptions(),
      c.req.param("runId"),
      since
    );
    return c.json(logs);
  });
}

const subagentsExtension: Extension = {
  id: "subagents",
  displayName: "Subagents",
  factory: true,
  description: "Project-agnostic runtime for CLI-backed subagent runs.",
  dependencies: [],
  configSchema: SubagentsExtensionConfigSchema,
  routePrefixes: ["/api/subagents"],
  validateConfig(raw) {
    const result = SubagentsExtensionConfigSchema.safeParse(raw);
    return {
      valid: result.success,
      errors: result.success
        ? []
        : result.error.issues.map((issue) => issue.message),
    };
  },
  registerRoutes(app) {
    registerSubagentRoutes(app);
  },
  getSystemPromptContributions() {
    return [
      "Subagent runtime commands:",
      "- Use `yoplai subagents start --cwd <repo> --label <name> --prompt <task>` with either `--cli codex|claude|pi` or `--profile <name>` to delegate scoped work.",
      "- Use `yoplai subagents list --status running` and `yoplai subagents status <runId>` to monitor runs.",
      "- Use `yoplai subagents logs <runId> --since 0` to inspect run output.",
      "- Use `yoplai subagents resume <runId> --prompt <follow-up>` for follow-up work.",
      "- Use `yoplai subagents interrupt|archive|unarchive|delete <runId>` to manage run lifecycle.",
    ].join("\n");
  },
  async start(ctx) {
    extensionContext = ctx;
    console.log("[subagents] extension started");
  },
  async stop() {
    extensionContext = null;
    console.log("[subagents] extension stopped");
  },
  capabilities() {
    return ["subagents"];
  },
};

export {
  getLiveSubagentRunsByCwd,
  listSubagentRuns,
  getSubagentRun,
  interruptSubagentRun,
  subagentsExtension,
};
