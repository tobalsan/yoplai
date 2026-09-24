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
      relative.startsWith("..") ||
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
          "Link one HTML dashboard from dashboards/, or list linked dashboards when slug is omitted.",
        parameters: {
          type: "object",
          properties: { slug: { type: "string" } },
        },
        async execute(raw) {
          const args = z.object({ slug: z.string().optional() }).parse(raw);
          let entries;
          if (args.slug) {
            const slug = normalizeDashboardSlug(args.slug);
            const file = await openDashboardFile(agent, slug);
            await file.close();
            entries = [await registry().link(agent.id, slug)];
          } else {
            entries = await registry().list(agent.id);
          }
          const results = await Promise.all(
            entries.map((entry) => dashboardInfo(agent, entry, hook!.config))
          );
          return args.slug ? results[0] : results;
        },
      },
    ];
  },
};
