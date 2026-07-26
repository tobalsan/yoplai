import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expandHomePlaceholder, resolveHomeDir } from "../config-path.js";
import type { SystemFileEntry } from "../types.js";

export type ResolvedSystemFile = { path: string; absolutePath: string; content: string };

export const DEFAULT_SYSTEM_FILES: Array<{ path: string; required: boolean }> = [
  { path: "SOUL.md", required: true },
  { path: "USER.md", required: false },
];

export type ResolveSystemFilesOptions = {
  workspaceDir: string;
  systemFiles?: SystemFileEntry[];
  warn?: (message: string) => void;
};

function normalizeEntry(entry: SystemFileEntry): { filePath: string; required?: boolean } {
  if (typeof entry === "string") return { filePath: entry };
  return { filePath: entry.path, required: entry.required };
}

function expandPath(filePath: string, workspaceDir: string): string {
  const expanded = filePath.startsWith("~")
    ? path.join(os.homedir(), filePath.slice(1))
    : expandHomePlaceholder(filePath, resolveHomeDir());
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(workspaceDir, expanded);
}

function displayPath(absolutePath: string, workspaceDir: string): string {
  const relative = path.relative(workspaceDir, absolutePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : absolutePath;
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function resolveSystemFiles({
  workspaceDir,
  systemFiles,
  warn = () => undefined,
}: ResolveSystemFilesOptions): Promise<ResolvedSystemFile[]> {
  const out: ResolvedSystemFile[] = [];
  const seen = new Set<string>();
  const add = async (filePath: string, required: boolean, implicit = false) => {
    const absolutePath = expandPath(filePath, workspaceDir);
    const key = path.resolve(absolutePath);
    if (seen.has(key)) return;
    seen.add(key);
    const content = await readIfExists(absolutePath);
    if (content === null) {
      if (required) throw new Error(`Required system file not found: ${filePath}`);
      if (!implicit) warn(`[system_files] optional file not found: ${filePath}`);
      return;
    }
    out.push({ path: displayPath(absolutePath, workspaceDir), absolutePath, content });
  };

  await add("AGENTS.md", false, true);

  const entries = systemFiles?.length
    ? systemFiles.map(normalizeEntry)
    : DEFAULT_SYSTEM_FILES.map(({ path: filePath, required }) => ({ filePath, required }));

  for (const entry of entries) {
    if (path.basename(entry.filePath) === "AGENTS.md") {
      warn("[system_files] AGENTS.md is auto-included; ignoring entry");
      continue;
    }
    await add(entry.filePath, entry.required ?? false);
  }

  return out;
}
