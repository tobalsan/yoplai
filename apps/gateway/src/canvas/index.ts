import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  AgentConfig,
  Extension,
  ExtensionContext,
  GatewayConfig,
} from "@yoplai/shared";
import { resolveHomeDir } from "@yoplai/shared";
import { getAgentDataDir } from "../agents/container.js";
import {
  DashboardRegistry,
  getDashboardRegistry,
  type DashboardRegistration,
} from "./store.js";
import { executeDashboardQueries } from "./sql.js";

let extensionContext: ExtensionContext | undefined;
let extensionRegistry: DashboardRegistry | undefined;
const dashboardWrites = new Map<string, Promise<void>>();

class DashboardNotFoundError extends Error {
  code = "ENOENT";
}

export function normalizeDashboardSlug(value: string): string {
  if (
    !value ||
    value !== path.posix.basename(value) ||
    path.posix.extname(value).toLowerCase() !== ".html" ||
    value === ".html"
  ) {
    throw new Error(
      "Dashboard slug must be one .html filename, e.g. pto-team.html"
    );
  }
  return value;
}

function agentDataDirectory(agent: AgentConfig): string {
  if (agent.sandbox?.enabled) {
    return getAgentDataDir(resolveHomeDir(), agent.id);
  }
  return path.join(agent.workspaceDir ?? agent.workspace, "data");
}

export function dashboardDirectory(agent: AgentConfig): string {
  return path.join(agentDataDirectory(agent), "dashboards");
}

// Maps a data-db path (relative to the agent's own workspace root) to the
// host path and the root it must stay confined to. Sandboxed agents only see
// their data directory from the host, mounted at data/ in the container.
export function dashboardDatabasePath(
  agent: AgentConfig,
  database: string
): { root: string; path: string } {
  if (!database || path.isAbsolute(database)) {
    throw new Error(
      "Database path must be relative to the workspace root, e.g. data/app.db"
    );
  }
  if (!agent.sandbox?.enabled) {
    const root = agent.workspaceDir ?? agent.workspace;
    return { root, path: path.resolve(root, database) };
  }
  const normalized = path.posix.normalize(database);
  if (!normalized.startsWith("data/") || normalized === "data/") {
    throw new Error(
      "Sandboxed dashboards can only read databases under data/, e.g. data/app.db"
    );
  }
  const root = agentDataDirectory(agent);
  return { root, path: path.resolve(root, normalized.slice("data/".length)) };
}

export function dashboardBaseUrl(config: GatewayConfig): string {
  const configured =
    config.canvas?.baseUrl ?? config.server?.baseUrl ?? config.web?.baseUrl;
  return (configured ?? `http://localhost:${config.ui?.port ?? 3000}`).replace(
    /\/+$/,
    ""
  );
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

export async function openDashboardFile(
  agent: AgentConfig,
  slug: string
): Promise<fs.FileHandle> {
  const directory = dashboardDirectory(agent);
  const candidate = path.join(directory, slug);
  const notFound = `Dashboard not found: data/dashboards/${slug}`;
  let fileHandle: fs.FileHandle | undefined;
  try {
    const directoryStat = await fs.lstat(directory);
    const realDirectory = await fs.realpath(directory);
    if (!directoryStat.isDirectory()) {
      throw new DashboardNotFoundError(notFound);
    }
    fileHandle = await fs.open(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    const [openedStat, candidateStat, directoryStatAfter, realCandidate] =
      await Promise.all([
        fileHandle.stat(),
        fs.lstat(candidate),
        fs.lstat(directory),
        fs.realpath(candidate),
      ]);
    const relative = path.relative(realDirectory, realCandidate);
    if (
      !openedStat.isFile() ||
      !candidateStat.isFile() ||
      !directoryStatAfter.isDirectory() ||
      openedStat.dev !== candidateStat.dev ||
      openedStat.ino !== candidateStat.ino ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new DashboardNotFoundError(notFound);
    }
    return fileHandle;
  } catch (error) {
    await fileHandle?.close();
    if (error instanceof DashboardNotFoundError) throw error;
    throw new DashboardNotFoundError(notFound, {
      cause: error,
    });
  }
}

async function deleteDashboardFile(
  agent: AgentConfig,
  slug: string
): Promise<boolean> {
  let file: fs.FileHandle;
  try {
    file = await openDashboardFile(agent, slug);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const directory = dashboardDirectory(agent);
    const candidate = path.join(directory, slug);
    const [expected, expectedDirectory, realDirectory] = await Promise.all([
      file.stat(),
      fs.lstat(directory),
      fs.realpath(directory),
    ]);
    const [actual, actualDirectory, currentRealDirectory] = await Promise.all([
      fs.lstat(candidate),
      fs.lstat(directory),
      fs.realpath(directory),
    ]);
    if (
      expected.dev !== actual.dev ||
      expected.ino !== actual.ino ||
      expectedDirectory.dev !== actualDirectory.dev ||
      expectedDirectory.ino !== actualDirectory.ino ||
      realDirectory !== currentRealDirectory
    ) {
      throw new DashboardNotFoundError(
        `Dashboard not found: data/dashboards/${slug}`
      );
    }
    await fs.unlink(candidate);
    return true;
  } finally {
    await file.close();
  }
}

async function replaceDashboardFile(
  agent: AgentConfig,
  slug: string,
  content: string
): Promise<void> {
  const directory = dashboardDirectory(agent);
  const readable = await openDashboardFile(agent, slug);
  const candidate = path.join(directory, slug);
  const temporary = path.join(
    directory,
    `.${slug}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  );
  let writable: fs.FileHandle | undefined;
  try {
    const [expected, expectedDirectory, realDirectory] = await Promise.all([
      readable.stat(),
      fs.lstat(directory),
      fs.realpath(directory),
    ]);
    writable = await fs.open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600
    );
    await writable.writeFile(content, "utf8");
    await writable.sync();
    await writable.close();
    writable = undefined;

    const [actual, actualDirectory, currentRealDirectory] = await Promise.all([
      fs.lstat(candidate),
      fs.lstat(directory),
      fs.realpath(directory),
    ]);
    if (
      expected.dev !== actual.dev ||
      expected.ino !== actual.ino ||
      expectedDirectory.dev !== actualDirectory.dev ||
      expectedDirectory.ino !== actualDirectory.ino ||
      realDirectory !== currentRealDirectory
    ) {
      throw new DashboardNotFoundError(`Dashboard not found: ${slug}`);
    }
    await fs.rename(temporary, candidate);
  } finally {
    await writable?.close();
    await readable.close();
    await fs.rm(temporary, { force: true });
  }
}

async function writeDashboardFile(
  agent: AgentConfig,
  slug: string,
  content: string
): Promise<void> {
  const candidate = path.join(dashboardDirectory(agent), slug);
  const previous = dashboardWrites.get(candidate) ?? Promise.resolve();
  const current = previous.then(
    () => replaceDashboardFile(agent, slug, content),
    () => replaceDashboardFile(agent, slug, content)
  );
  const settled = current.then(
    () => undefined,
    () => undefined
  );
  dashboardWrites.set(candidate, settled);
  try {
    await current;
  } finally {
    if (dashboardWrites.get(candidate) === settled) {
      dashboardWrites.delete(candidate);
    }
  }
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
    await recordDashboardVersion(agent, entry, html);
    const { errors } = await executeDashboardQueries(agent, html, {
      viewer_email: null,
      viewer_name: null,
      today: new Date().toISOString().slice(0, 10),
    });
    return {
      slug: entry.slug,
      updatedAt: stat.mtime.toISOString(),
      link: `${dashboardBaseUrl(config)}/d/${entry.id}`,
      queryErrors: errors,
    };
  } finally {
    await file.close();
  }
}

async function discoverDashboards(agent: AgentConfig, config: GatewayConfig) {
  let files: string[];
  try {
    files = (
      await fs.readdir(dashboardDirectory(agent), { withFileTypes: true })
    )
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          normalizeDashboardSlug(name);
          return true;
        } catch {
          return false;
        }
      })
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const results = [];
  for (const slug of files) {
    let file: fs.FileHandle | undefined;
    try {
      file = await openDashboardFile(agent, slug);
      const [entry, stat] = await Promise.all([
        registry().link(agent.id, slug),
        file.stat(),
      ]);
      const html = await file.readFile("utf8");
      await recordDashboardVersion(agent, entry, html);
      const { errors } = await executeDashboardQueries(agent, html, {
        viewer_email: null,
        viewer_name: null,
        today: new Date().toISOString().slice(0, 10),
      });
      results.push({
        slug,
        updatedAt: stat.mtime.toISOString(),
        link: `${dashboardBaseUrl(config)}/d/${entry.id}`,
        queryErrors: errors,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await file?.close();
    }
  }
  return results;
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
  getAgentTools(agent, hook) {
    if (hook?.config.canvas?.enabled === false) return [];
    return [
      {
        name: "dashboard_link",
        description:
          "Link one HTML dashboard from data/dashboards/<slug>.html, or list all dashboards when slug is omitted. SQL data-db paths are relative to the workspace root, e.g. data/app.db.",
        parameters: {
          type: "object",
          properties: { slug: { type: "string" } },
        },
        async execute(raw) {
          const args = z.object({ slug: z.string().optional() }).parse(raw);
          if (args.slug) {
            const slug = normalizeDashboardSlug(args.slug);
            const file = await openDashboardFile(agent, slug);
            await file.close();
            const entry = await registry().link(agent.id, slug);
            return dashboardInfo(agent, entry, hook!.config);
          }
          return discoverDashboards(agent, hook!.config);
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
        async execute(raw) {
          const args = z
            .object({ slug: z.string(), restore: z.string().optional() })
            .parse(raw);
          const slug = normalizeDashboardSlug(args.slug);
          const file = await openDashboardFile(agent, slug);
          let html: string;
          try {
            html = await file.readFile("utf8");
          } finally {
            await file.close();
          }
          const entry = await registry().link(agent.id, slug);
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
          await registry().recordVersion(entry.id, html);
          if (args.restore) {
            await writeDashboardFile(agent, slug, restoredContent!);
          }
          return {
            slug,
            link: `${dashboardBaseUrl(hook!.config)}/d/${entry.id}`,
            managed: true,
            restored: args.restore,
            versions: await registry().listVersions(entry.id),
          };
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
        async execute(raw) {
          const args = z.object({ slug: z.string() }).parse(raw);
          const slug = normalizeDashboardSlug(args.slug);
          const file = await deleteDashboardFile(agent, slug);
          const removed = await registry().delete(agent.id, slug);
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
        },
      },
    ];
  },
};
