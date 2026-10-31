import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Restore whole declarations only from earlier, unredacted declarations in this file. */
export function repairSessionTools(lines: readonly unknown[]): {
  lines: readonly unknown[];
  restored: string[];
  unrestorable: string[];
} {
  const sources = new Map<string, Record<string, unknown>>();
  const restored = new Set<string>();
  const unrestorable = new Set<string>();
  const repaired = lines.map((entry) => {
    if (!isRecord(entry)) return entry;
    const holder =
      entry.type === "message"
        ? entry.message
        : entry.type === "compaction"
          ? entry.systemMessage
          : undefined;
    if (
      !isRecord(holder) ||
      holder.role !== "system" ||
      !Array.isArray(holder.toolsAdded)
    )
      return entry;
    const tools = holder.toolsAdded;
    const replacements = tools.map((tool: unknown) => {
      if (
        !JSON.stringify(tool)?.includes("[REDACTED]") ||
        entry.type !== "compaction"
      )
        return tool;
      const name =
        isRecord(tool) && typeof tool.name === "string"
          ? tool.name
          : "<unnamed>";
      const source = sources.get(name);
      if (!source) {
        unrestorable.add(name);
        return tool;
      }
      restored.add(name);
      return source;
    });
    for (const tool of tools) {
      if (
        isRecord(tool) &&
        typeof tool.name === "string" &&
        !JSON.stringify(tool).includes("[REDACTED]")
      ) {
        sources.set(tool.name, tool);
      }
    }
    if (replacements.every((tool, index) => tool === tools[index]))
      return entry;
    return { ...entry, systemMessage: { ...holder, toolsAdded: replacements } };
  });
  return {
    lines: unrestorable.size ? lines : repaired,
    restored: [...restored],
    unrestorable: [...unrestorable],
  };
}

async function sessionFiles(target: string): Promise<string[]> {
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) return target.endsWith(".jsonl") ? [target] : [];
  const files: string[] = [];
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...(await sessionFiles(child)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(child);
  }
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const targets = args.filter((arg) => arg !== "--write");
  if (!targets.length)
    throw new Error(
      "Usage: tsx scripts/repair-session-tools.ts [--write] <file-or-directory> [...paths]"
    );
  const files = new Set<string>();
  for (const target of targets) {
    for (const file of await sessionFiles(path.resolve(target)))
      files.add(file);
  }
  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    const chunks = content.split(/(\r\n|\n|\r)/);
    const lines = chunks
      .filter((_, index) => index % 2 === 0)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return undefined;
        }
      });
    const report = repairSessionTools(lines);
    const canWrite =
      write && report.restored.length > 0 && report.unrestorable.length === 0;
    if (canWrite) {
      await fs.copyFile(file, `${file}.bak`, constants.COPYFILE_EXCL);
      for (const [index, line] of report.lines.entries()) {
        if (line !== lines[index]) chunks[index * 2] = JSON.stringify(line);
      }
      await fs.writeFile(file, chunks.join(""), "utf8");
    }
    const status = !write ? "dry run" : canWrite ? "repaired" : "unchanged";
    console.log(
      `${file}: ${status}; restore: ${report.restored.join(", ") || "none"}; unrestorable: ${report.unrestorable.join(", ") || "none"}`
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
