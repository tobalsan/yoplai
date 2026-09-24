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
import { DashboardRegistry } from "./store.js";

let extensionContext: ExtensionContext | undefined;
let extensionRegistry: DashboardRegistry | undefined;

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
    throw new Error("Dashboard slug must be one .html filename");
  }
  return value;
}

export function dashboardDirectory(agent: AgentConfig): string {
  if (agent.sandbox?.enabled) {
    return path.join(getAgentDataDir(resolveHomeDir(), agent.id), "dashboards");
  }
  return path.join(agent.workspaceDir ?? agent.workspace, "dashboards");
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

export async function openDashboardFile(
  agent: AgentConfig,
  slug: string
): Promise<fs.FileHandle> {
  const directory = dashboardDirectory(agent);
  const candidate = path.join(directory, slug);
  let fileHandle: fs.FileHandle | undefined;
  try {
    const directoryStat = await fs.lstat(directory);
    const realDirectory = await fs.realpath(directory);
    if (!directoryStat.isDirectory()) {
      throw new DashboardNotFoundError(`Dashboard not found: ${slug}`);
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
      throw new DashboardNotFoundError(`Dashboard not found: ${slug}`);
    }
    return fileHandle;
  } catch (error) {
    await fileHandle?.close();
    if (error instanceof DashboardNotFoundError) throw error;
    throw new DashboardNotFoundError(`Dashboard not found: ${slug}`, {
      cause: error,
    });
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
    return {
      slug: entry.slug,
      updatedAt: stat.mtime.toISOString(),
      link: `${dashboardBaseUrl(config)}/d/${entry.id}`,
    };
  } finally {
    await file.close();
  }
}

async function discoverDashboards(agent: AgentConfig, config: GatewayConfig) {
  let files: string[];
  try {
    files = (await fs.readdir(dashboardDirectory(agent), { withFileTypes: true }))
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
      results.push({
        slug,
        updatedAt: stat.mtime.toISOString(),
        link: `${dashboardBaseUrl(config)}/d/${entry.id}`,
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
    extensionRegistry = new DashboardRegistry(
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
          "Link one HTML dashboard from dashboards/, or list all dashboards when slug is omitted.",
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
    ];
  },
};
