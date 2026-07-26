import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expandHomePlaceholder } from "@yoplai/shared";
import type { ProjectDescriptor } from "../types.js";

export class InvalidProjectsError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid orchestrator projects:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  }
}

function expandProjectPath(raw: string, dataDir: string): string {
  const value = raw.trim();
  if (!value) return value;
  const expanded = expandHomePlaceholder(value, dataDir);
  if (expanded !== value) return expanded;
  if (value.startsWith("~")) return path.join(process.env.HOME ?? "", value.slice(1));
  return path.isAbsolute(value) ? value : path.join(dataDir, value);
}

export async function resolveProjects(input: { paths: string[]; dataDir: string }): Promise<ProjectDescriptor[]> {
  const issues: string[] = [];
  const seen = new Set<string>();
  const projects: ProjectDescriptor[] = [];
  const basenames = new Map<string, number>();

  for (const raw of input.paths) {
    const projectPath = path.resolve(expandProjectPath(raw, input.dataDir));
    if (!projectPath) {
      issues.push("empty project path");
      continue;
    }
    if (seen.has(projectPath)) {
      issues.push(`duplicate project path: ${projectPath}`);
      continue;
    }
    seen.add(projectPath);
    try {
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) issues.push(`project path is not a directory: ${projectPath}`);
    } catch {
      issues.push(`project path not found: ${projectPath}`);
      continue;
    }
    const workflowPath = path.join(projectPath, "WORKFLOW.md");
    try {
      const stat = await fs.stat(workflowPath);
      if (!stat.isFile()) issues.push(`WORKFLOW.md is not a file: ${workflowPath}`);
    } catch {
      issues.push(`missing WORKFLOW.md: ${workflowPath}`);
      continue;
    }
    const basename = path.basename(projectPath);
    basenames.set(basename, (basenames.get(basename) ?? 0) + 1);
    projects.push({ id: basename, path: projectPath, workflowPath });
  }

  if (issues.length) throw new InvalidProjectsError(issues);
  return projects.map((project) => basenames.get(project.id)! > 1 ? { ...project, id: `${project.id}-${crypto.createHash("sha1").update(project.path).digest("hex").slice(0, 8)}` } : project);
}
