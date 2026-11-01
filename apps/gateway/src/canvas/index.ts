import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { requestSlackPairingLink } from "@yoplai/shared";
import type {
  AgentConfig,
  Extension,
  ExtensionContext,
  ExtensionAgentToolContext,
  GatewayConfig,
} from "@yoplai/shared";
import {
  DashboardRegistry,
  getDashboardRegistry,
  type DashboardRegistration,
} from "./store.js";
import { lintDashboardHtml } from "./lint.js";
import { executeDashboardQueries } from "./sql.js";
import { dashboardAccessPolicy } from "./policy.js";
import { resolveDashboardActor } from "./actor.js";
import {
  dashboardBaseUrl,
  dashboardDirectory,
  deleteDashboardFile,
  normalizeDashboardSlug,
  openDashboardFile,
  writeDashboardFile,
} from "./dashboard-files.js";

let extensionContext: ExtensionContext | undefined;
let extensionRegistry: DashboardRegistry | undefined;

function invalidInput(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "invalid_input" });
}

function registry(): DashboardRegistry {
  if (!extensionRegistry) throw new Error("Canvas is not started");
  return extensionRegistry;
}

async function hasGitHistory(agent: AgentConfig): Promise<boolean> {
  if (agent.sandbox?.enabled) return false;
  try {
    await fs.lstat(path.join(agent.workspaceDir ?? agent.workspace, ".git"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function recordDashboardVersion(
  agent: AgentConfig,
  entry: Pick<DashboardRegistration, "id">,
  html: string,
  dashboardRegistry = registry()
): Promise<void> {
  if (!(await hasGitHistory(agent))) {
    await dashboardRegistry.recordVersion(entry.id, html);
  }
}

async function dashboardDiagnostics(agent: AgentConfig, html: string) {
  const { data, errors } = await executeDashboardQueries(agent, html, {
    viewer_email: null,
    viewer_name: null,
    today: new Date().toISOString().slice(0, 10),
  });
  const emptyQueryWarnings = Object.entries(data)
    .filter(([, rows]) => rows.length === 0)
    .map(
      ([name]) =>
        `Query "${name}" returned 0 rows — charts/tables using it will be empty.`
    );
  const existing = new Set(
    await fs.readdir(dashboardDirectory(agent)).catch(() => [] as string[])
  );
  const missingLinks = [
    ...new Set(
      [...html.matchAll(/YOPLAI\.link\(\s*["']([^"']+)["']/g)].map((m) => m[1])
    ),
  ]
    .filter((slug) => !existing.has(slug))
    .map(
      (slug) =>
        `YOPLAI.link("${slug}") points to a dashboard that does not exist; create data/dashboards/${slug} or remove the link (the page throws when it renders the link).`
    );
  return {
    queryErrors: errors,
    problems: [
      ...lintDashboardHtml(html),
      ...missingLinks,
      ...emptyQueryWarnings,
    ],
  };
}

async function dashboardInfo(
  agent: AgentConfig,
  entry: { id: string; slug: string },
  config: GatewayConfig
) {
  const file = await openDashboardFile(agent, entry.slug);
  try {
    const stat = await file.stat();
    const html = await file.readFile("utf8");
    return {
      slug: entry.slug,
      updatedAt: stat.mtime.toISOString(),
      link: `${dashboardBaseUrl(config)}/d/${entry.id}`,
      ...(await dashboardDiagnostics(agent, html)),
    };
  } finally {
    await file.close();
  }
}

function toolContext(
  context: ExtensionAgentToolContext,
  config: GatewayConfig
): ExtensionAgentToolContext {
  return { ...context, config };
}

async function registeredDashboard(
  agent: AgentConfig,
  slug: string
): Promise<DashboardRegistration> {
  const entry = await registry().find(agent.id, slug);
  if (!entry) throw invalidInput("Dashboard not found");
  return entry;
}

async function withAuthorizedDashboard<T>(
  agent: AgentConfig,
  slug: string,
  context: ExtensionAgentToolContext,
  permission: "write" | "manage",
  operation: (entry: DashboardRegistration) => Promise<T>
): Promise<T> {
  const entry = await registeredDashboard(agent, slug);
  return registry().withRegistration(entry.id, async (current) => {
    const actor = await resolveDashboardActor(context, agent.id);
    const allowed =
      permission === "write"
        ? dashboardAccessPolicy.canWrite(current, actor)
        : dashboardAccessPolicy.canManage(current, actor);
    if (!actor.hasAgentAccess || !allowed)
      throw invalidInput("Dashboard not found");
    return operation(current);
  });
}

export const canvasExtension: Extension = {
  id: "canvas",
  displayName: "Canvas",
  description: "Serve agent-authored HTML dashboards.",
  dependencies: [],
  factory: true,
  routePrefixes: [],
  configSchema: z.object({}),
  validateConfig: () => ({ valid: true, errors: [] }),
  registerRoutes: () => {},
  async start(context) {
    extensionContext = context;
    extensionRegistry = getDashboardRegistry(
      path.join(extensionContext.getDataDir(), "canvas", "registry.json")
    );
  },
  async stop() {
    extensionContext = undefined;
    extensionRegistry = undefined;
  },
  capabilities: () => [],
  getSystemPromptContributions(_agent, hook) {
    if (hook?.config.canvas?.enabled === false) return undefined;
    return "Dashboards: dashboard_link is the only source for the current user's dashboards, not files, memory or notes. Treat a dashboard it does not return as nonexistent: never mention it or hint that other dashboards exist.";
  },
  getAgentTools(agent, hook) {
    if (hook?.config.canvas?.enabled === false) return [];
    return [
      {
        name: "dashboard_link",
        description:
          "Return a readable registered dashboard URL, or list readable dashboard URLs. Does not register, publish, or record history; use dashboard_create once and dashboard_update to publish changes.",
        parameters: {
          type: "object",
          properties: { slug: { type: "string" } },
        },
        async execute(raw, context) {
          const args = z.object({ slug: z.string().optional() }).parse(raw);
          const actor = await resolveDashboardActor(
            toolContext(context, hook!.config),
            agent.id
          );
          if (!actor.hasAgentAccess) throw invalidInput("Dashboard not found");
          if (args.slug) {
            const slug = normalizeDashboardSlug(args.slug);
            const entry = await registeredDashboard(agent, slug);
            if (!dashboardAccessPolicy.canRead(entry, actor))
              throw invalidInput("Dashboard not found");
            return {
              slug,
              link: `${dashboardBaseUrl(hook!.config)}/d/${entry.id}`,
            };
          }
          const dashboards = dashboardAccessPolicy
            .filterVisible(await registry().list(agent.id), actor)
            .map((entry) => ({
              slug: entry.slug,
              link: `${dashboardBaseUrl(hook!.config)}/d/${entry.id}`,
            }));
          return {
            dashboards,
            note: "This is the complete dashboard list for this user. Show only these. Never mention or hint at other dashboards from files, memory or notes.",
          };
        },
      },
      {
        name: "dashboard_create",
        description:
          "Register an unregistered data/dashboards/<slug>.html as private, owned by the requester, and publish its initial HTML. Fix returned problems and queryErrors before sharing. Existing registrations cannot be taken over.",
        parameters: {
          type: "object",
          properties: { slug: { type: "string" } },
          required: ["slug"],
        },
        async execute(raw, context) {
          const { slug: rawSlug } = z.object({ slug: z.string() }).parse(raw);
          const slug = normalizeDashboardSlug(rawSlug);
          const actor = await resolveDashboardActor(
            toolContext(context, hook!.config),
            agent.id
          );
          if (!actor.userId) {
            const link = await requestSlackPairingLink(context);
            if (link)
              return {
                isError: true,
                error: "slack_pairing_required",
                link,
                message: `Pair your Slack account at ${link}, then ask again. No dashboard was registered.`,
              };
          }
          if (!actor.userId || !actor.eligible || !actor.hasAgentAccess)
            throw invalidInput("Dashboard not found");
          const file = await openDashboardFile(agent, slug);
          let html: string;
          try {
            html = await file.readFile("utf8");
          } finally {
            await file.close();
          }
          const entry = await registry().createOwned(
            agent.id,
            slug,
            actor.userId,
            html
          );
          await recordDashboardVersion(agent, entry, html);
          return dashboardInfo(agent, entry, hook!.config);
        },
      },
      {
        name: "dashboard_update",
        description:
          "Publish the current working HTML of a registered dashboard you can write. Keeps its owner and shares; returns lint and query diagnostics. Writers see drafts live before publication, readers see this published copy.",
        parameters: {
          type: "object",
          properties: { slug: { type: "string" } },
          required: ["slug"],
        },
        async execute(raw, context) {
          const { slug: rawSlug } = z.object({ slug: z.string() }).parse(raw);
          const slug = normalizeDashboardSlug(rawSlug);
          return withAuthorizedDashboard(
            agent,
            slug,
            toolContext(context, hook!.config),
            "write",
            async (entry) => {
              const file = await openDashboardFile(agent, slug);
              let html: string;
              try {
                html = await file.readFile("utf8");
              } finally {
                await file.close();
              }
              if (entry.ownerUserId) await registry().publish(entry.id, html);
              await recordDashboardVersion(agent, entry, html);
              return dashboardInfo(agent, entry, hook!.config);
            }
          );
        },
      },
      {
        name: "dashboard_versions",
        description:
          "List saved versions of one dashboard, or restore a version without changing its link.",
        parameters: {
          type: "object",
          properties: {
            slug: { type: "string" },
            restore: { type: "string" },
          },
          required: ["slug"],
        },
        async execute(raw, context) {
          const args = z
            .object({ slug: z.string(), restore: z.string().optional() })
            .parse(raw);
          const slug = normalizeDashboardSlug(args.slug);
          return withAuthorizedDashboard(
            agent,
            slug,
            toolContext(context, hook!.config),
            "write",
            async (entry) => {
              const managed = !(await hasGitHistory(agent));
              if (!managed) {
                return {
                  slug,
                  link: `${dashboardBaseUrl(hook!.config)}/d/${entry.id}`,
                  managed: false,
                  versions: [],
                };
              }

              const restoredContent = args.restore
                ? await registry().readVersion(entry.id, args.restore)
                : undefined;
              if (args.restore) {
                await writeDashboardFile(agent, slug, restoredContent!);
                if (entry.ownerUserId)
                  await registry().publish(entry.id, restoredContent!);
                await registry().recordVersion(entry.id, restoredContent!);
              }
              return {
                slug,
                link: `${dashboardBaseUrl(hook!.config)}/d/${entry.id}`,
                managed: true,
                restored: args.restore,
                versions: await registry().listVersions(entry.id),
              };
            }
          );
        },
      },
      {
        name: "dashboard_delete",
        description:
          "Delete one dashboard, its stable link registration, and its saved versions. SQLite database files are preserved.",
        parameters: {
          type: "object",
          properties: { slug: { type: "string" } },
          required: ["slug"],
        },
        async execute(raw, context) {
          const args = z.object({ slug: z.string() }).parse(raw);
          const slug = normalizeDashboardSlug(args.slug);
          if (!(await registry().find(agent.id, slug))) {
            const actor = await resolveDashboardActor(
              toolContext(context, hook!.config),
              agent.id
            );
            if (!actor.eligible || !actor.hasAgentAccess)
              throw invalidInput("Dashboard not found");
            return {
              slug,
              removed: { file: false, registry: false, versions: false },
              message: "Nothing to delete",
            };
          }
          return withAuthorizedDashboard(
            agent,
            slug,
            toolContext(context, hook!.config),
            "manage",
            async (entry) => {
              const file = await deleteDashboardFile(agent, slug);
              const removed = await registry().deleteId(entry.id);
              const result = {
                file,
                registry: Boolean(removed.registration),
                versions: removed.versions,
              };
              return {
                slug,
                removed: result,
                message: Object.values(result).some(Boolean)
                  ? "Dashboard deleted"
                  : "Nothing to delete",
              };
            }
          );
        },
      },
    ];
  },
};
