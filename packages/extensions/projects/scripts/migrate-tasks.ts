#!/usr/bin/env tsx
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readEnv } from "@yoplai/shared";

interface Args {
  root: string;
  apply: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const homeDir = readEnv("YOPLAI_HOME");
  const args: Args = {
    root: homeDir
      ? join(homeDir, "projects")
      : join(process.env.HOME ?? "", "projects"),
    apply: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--root") {
      const next = argv[++i];
      if (!next) throw new Error("--root requires a path");
      args.root = next;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`migrate-tasks — extract Tasks/Validation sections from SPECS.md

Usage:
  npx tsx packages/extensions/projects/scripts/migrate-tasks.ts [options]

Options:
  --root <path>   Projects root dir (default: $YOPLAI_HOME/projects or ~/projects)
  --apply         Write changes (default: dry-run)
  -h, --help      Show this help
`);
}

interface Frontmatter {
  raw: string;
  body: string;
}

function splitFrontmatter(src: string): Frontmatter {
  if (!src.startsWith("---")) return { raw: "", body: src };
  const end = src.indexOf("\n---", 3);
  if (end === -1) return { raw: "", body: src };
  const close = src.indexOf("\n", end + 4);
  const cut = close === -1 ? src.length : close + 1;
  return { raw: src.slice(0, cut), body: src.slice(cut) };
}

interface Section {
  startLine: number;
  endLine: number;
  headingLine: string;
  content: string;
}

function findSection(body: string, namesLower: string[]): Section | null {
  const lines = body.split("\n");
  let start = -1;
  let headingLine = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m && namesLower.includes(m[1].trim().toLowerCase())) {
      start = i;
      headingLine = line;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (/^##\s+/.test(lines[j])) {
      end = j;
      break;
    }
  }
  const content = lines.slice(start + 1, end).join("\n");
  return { startLine: start, endLine: end, headingLine, content };
}

function removeSection(body: string, sec: Section): string {
  const lines = body.split("\n");
  lines.splice(sec.startLine, sec.endLine - sec.startLine);
  // collapse 3+ blank lines into 2
  const out = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return out;
}

function buildExtracted(canonicalHeading: string, content: string): string {
  const trimmed = content.replace(/^\n+/, "").replace(/\n+$/, "");
  return `${canonicalHeading}\n\n${trimmed}\n`;
}

interface Stats {
  scanned: number;
  tasksCreated: number;
  validationCreated: number;
  skippedExisting: number;
  noSpecs: number;
}

async function processProject(
  dir: string,
  apply: boolean,
  stats: Stats,
): Promise<void> {
  const specsPath = join(dir, "SPECS.md");
  if (!existsSync(specsPath)) {
    stats.noSpecs++;
    return;
  }
  const tasksPath = join(dir, "TASKS.md");
  const validationPath = join(dir, "VALIDATION.md");
  const src = await readFile(specsPath, "utf8");
  const { raw: fm, body } = splitFrontmatter(src);

  let newBody = body;
  let changed = false;

  const tasksSec = findSection(newBody, ["tasks"]);
  if (tasksSec) {
    if (existsSync(tasksPath)) {
      console.log(`[skip] ${specsPath}: TASKS.md already exists`);
      stats.skippedExisting++;
    } else {
      const out = buildExtracted("## Tasks", tasksSec.content);
      console.log(`[tasks] ${specsPath} -> ${tasksPath} (${out.length} bytes)`);
      if (apply) await writeFile(tasksPath, out, "utf8");
      newBody = removeSection(newBody, tasksSec);
      changed = true;
      stats.tasksCreated++;
    }
  }

  const valSec = findSection(newBody, ["acceptance", "validation"]);
  if (valSec) {
    if (existsSync(validationPath)) {
      console.log(`[skip] ${specsPath}: VALIDATION.md already exists`);
      stats.skippedExisting++;
    } else {
      const out = buildExtracted("## Validation", valSec.content);
      console.log(
        `[validation] ${specsPath} -> ${validationPath} (${out.length} bytes)`,
      );
      if (apply) await writeFile(validationPath, out, "utf8");
      newBody = removeSection(newBody, valSec);
      changed = true;
      stats.validationCreated++;
    }
  }

  if (changed && apply) {
    await writeFile(specsPath, fm + newBody, "utf8");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.root) {
    console.error("No root provided. Use --root <path> or set YOPLAI_HOME.");
    process.exit(1);
  }
  if (!existsSync(args.root)) {
    console.error(`Root not found: ${args.root}`);
    process.exit(1);
  }

  console.log(`Root: ${args.root}`);
  console.log(`Mode: ${args.apply ? "APPLY" : "dry-run"}`);

  const entries = await readdir(args.root);
  const stats: Stats = {
    scanned: 0,
    tasksCreated: 0,
    validationCreated: 0,
    skippedExisting: 0,
    noSpecs: 0,
  };

  for (const name of entries) {
    const dir = join(args.root, name);
    let s;
    try {
      s = await stat(dir);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    stats.scanned++;
    await processProject(dir, args.apply, stats);
  }

  console.log("\n=== Summary ===");
  console.log(`Scanned: ${stats.scanned}`);
  console.log(`TASKS.md created: ${stats.tasksCreated}`);
  console.log(`VALIDATION.md created: ${stats.validationCreated}`);
  console.log(`Skipped (existing): ${stats.skippedExisting}`);
  console.log(`No SPECS.md: ${stats.noSpecs}`);
  if (!args.apply) console.log("\nDry-run. Re-run with --apply to write.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
