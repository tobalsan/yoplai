import * as fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { GatewayConfig } from "@yoplai/shared";
import { getProjectsContext } from "../context.js";
import { getProjectsRoot } from "../util/paths.js";

const DEBOUNCE_MS = 300;
const COLLECTION_DIRS = new Set([".archive", ".done"]);

export function inferProjectIdFromDirName(dirName: string): string {
  const match = /^(PRO-\d+)/.exec(dirName);
  if (match) return match[1];
  const base = dirName.split("_")[0];
  return base || dirName;
}

function parseProjectPath(
  projectsRoot: string,
  targetPath: string
): { projectId: string; relativePath: string; parts: string[] } | null {
  const relativePath = path.relative(projectsRoot, targetPath);
  if (!relativePath || relativePath.startsWith("..")) return null;
  const parts = relativePath.split(path.sep).filter(Boolean);
  const projectOffset = COLLECTION_DIRS.has(parts[0] ?? "") ? 1 : 0;
  const projectParts = parts.slice(projectOffset);
  const projectId = inferProjectIdFromDirName(projectParts[0] ?? "");
  if (!projectId || projectId.startsWith(".")) return null;
  return {
    projectId,
    relativePath: parts.join("/"),
    parts: projectParts,
  };
}

function isAgentSessionEvent(event: string, parts: string[]): boolean {
  if (parts[1] !== "sessions") return false;
  if ((event === "addDir" || event === "unlinkDir") && parts.length === 3) {
    return true;
  }
  if (
    (event === "add" || event === "change" || event === "unlink") &&
    parts.length === 4 &&
    parts[3] === "state.json"
  ) {
    return true;
  }
  return false;
}

function shouldIgnoreSessionPath(
  projectsRoot: string,
  targetPath: string,
  stats?: fs.Stats
): boolean {
  if (!stats) return false;
  const parsed = parseProjectPath(projectsRoot, targetPath);
  if (!parsed || parsed.parts[1] !== "sessions") return true;
  if (stats.isDirectory()) {
    return parsed.parts.length !== 2 && parsed.parts.length !== 3;
  }
  return parsed.parts.length !== 4 || parsed.parts[3] !== "state.json";
}

function shouldIgnoreMarkdownPath(targetPath: string, stats?: fs.Stats): boolean {
  const parts = targetPath.split(path.sep);
  if (parts.includes("sessions") || parts.includes(".git")) return true;
  if (stats?.isFile()) return path.extname(targetPath).toLowerCase() !== ".md";
  return false;
}

function readSessionDirs(scanRoot: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scanRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessionDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("PRO-")) continue;
    const sessionsDir = path.join(scanRoot, entry.name, "sessions");
    try {
      if (fs.statSync(sessionsDir).isDirectory()) {
        sessionDirs.push(sessionsDir);
      }
    } catch {
      // Missing sessions dirs are normal for projects without agents.
    }
  }
  return sessionDirs;
}

function discoverSessionDirs(projectsRoot: string): string[] {
  return [
    projectsRoot,
    ...[...COLLECTION_DIRS].map((dir) => path.join(projectsRoot, dir)),
  ].flatMap(readSessionDirs);
}

function closeOnWatcherError(watcher: FSWatcher) {
  watcher.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[watcher] file watcher error, disabling realtime:", message);
    watcher.close().catch(() => {});
  });
}

export type ProjectWatcher = {
  close: () => Promise<void>;
};

export function startProjectWatcher(config: GatewayConfig): ProjectWatcher {
  const projectsRoot = getProjectsRoot(config);
  const fileTimers = new Map<string, NodeJS.Timeout>();
  const filePayloads = new Map<string, Set<string>>();
  const agentTimers = new Map<string, NodeJS.Timeout>();

  const queueFileChanged = (projectId: string, file: string) => {
    const existingFiles = filePayloads.get(projectId) ?? new Set<string>();
    existingFiles.add(file);
    filePayloads.set(projectId, existingFiles);
    const existing = fileTimers.get(projectId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      fileTimers.delete(projectId);
      const nextFiles = filePayloads.get(projectId);
      if (!nextFiles || nextFiles.size === 0) return;
      filePayloads.delete(projectId);
      for (const nextFile of nextFiles) {
        getProjectsContext().emit("file.changed", {
          type: "file_changed",
          projectId,
          file: nextFile,
        });
      }
    }, DEBOUNCE_MS);
    fileTimers.set(projectId, timer);
  };

  const queueAgentChanged = (projectId: string) => {
    const existing = agentTimers.get(projectId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      agentTimers.delete(projectId);
      getProjectsContext().emit("agent.changed", {
        type: "agent_changed",
        projectId,
      });
    }, DEBOUNCE_MS);
    agentTimers.set(projectId, timer);
  };

  const markdownWatcher: FSWatcher = chokidar.watch(
    [
      projectsRoot,
      ...[...COLLECTION_DIRS].map((dir) => path.join(projectsRoot, dir)),
    ],
    {
      ignoreInitial: true,
      ignored: shouldIgnoreMarkdownPath,
    }
  );
  closeOnWatcherError(markdownWatcher);

  markdownWatcher.on("all", (event, changedPath) => {
    if (event !== "add" && event !== "change" && event !== "unlink") return;
    if (path.extname(changedPath).toLowerCase() !== ".md") return;
    const parsed = parseProjectPath(projectsRoot, changedPath);
    if (!parsed) return;
    queueFileChanged(parsed.projectId, parsed.relativePath);
  });

  const sessionsWatcher: FSWatcher = chokidar.watch(
    discoverSessionDirs(projectsRoot),
    {
      ignoreInitial: true,
      depth: 1,
      ignored: (targetPath, stats) =>
        shouldIgnoreSessionPath(projectsRoot, targetPath, stats),
      usePolling: true,
    }
  );
  closeOnWatcherError(sessionsWatcher);

  sessionsWatcher.on("all", (event, changedPath) => {
    const parsed = parseProjectPath(projectsRoot, changedPath);
    if (!parsed) return;
    if (!isAgentSessionEvent(event, parsed.parts)) return;
    queueAgentChanged(parsed.projectId);
  });

  return {
    close: async () => {
      for (const timer of fileTimers.values()) clearTimeout(timer);
      for (const timer of agentTimers.values()) clearTimeout(timer);
      fileTimers.clear();
      filePayloads.clear();
      agentTimers.clear();
      await Promise.allSettled([
        markdownWatcher.close(),
        sessionsWatcher.close(),
      ]);
    },
  };
}
