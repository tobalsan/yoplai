import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GatewayConfig, Task } from "@yoplai/shared";
import { TaskSchema } from "@yoplai/shared";
import { getProjectsRoot } from "../util/paths.js";
import { findProjectLocation } from "./store.js";

function parseMetadata(raw: string): {
  status?: Task["status"];
  agentId?: string;
} {
  const metadataMatches = raw.matchAll(/`([^:`]+):([^`]+)`/g);
  let status: Task["status"] | undefined;
  let agentId: string | undefined;
  for (const match of metadataMatches) {
    const key = (match[1] ?? "").trim();
    const value = (match[2] ?? "").trim();
    if (key === "status" && ["todo", "in_progress", "done"].includes(value)) {
      status = value as Task["status"];
    }
    if (key === "agent" && value) {
      agentId = value;
    }
  }
  return { status, agentId };
}

function extractSectionLines(content: string, heading: string): string[] {
  const lines = content.split(/\r?\n/);
  const sectionStart = lines.findIndex(
    (line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase()
  );
  if (sectionStart < 0) return [];

  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  return lines.slice(sectionStart + 1, sectionEnd);
}

const TASK_LINE_PATTERN = /^- \[( |x)\] \*\*(.+?)\*\*(.*)$/;
const SUBSECTION_H3_PATTERN = /^###\s+(.+?)\s*$/;

function parseSectionTaskEntries(
  content: string,
  heading: string
): Array<{ task: Task; subsection: string | null }> {
  const lines = extractSectionLines(content, heading);
  const entries: Array<{ task: Task; subsection: string | null }> = [];
  let currentSubsection: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const subsectionMatch = line.match(SUBSECTION_H3_PATTERN);
    if (subsectionMatch) {
      currentSubsection = subsectionMatch[1]?.trim() || null;
      continue;
    }

    const taskMatch = line.match(TASK_LINE_PATTERN);
    if (!taskMatch) continue;

    const checked = taskMatch[1] === "x";
    const title = taskMatch[2]?.trim() ?? "";
    const metadataText = taskMatch[3] ?? "";
    const metadata = parseMetadata(metadataText);

    const descriptionLines: string[] = [];
    let cursor = i + 1;
    while (cursor < lines.length) {
      const next = lines[cursor] ?? "";
      if (/^\s{2,}.*$/.test(next) || /^\t.*$/.test(next)) {
        descriptionLines.push(next.replace(/^\s{2}|\t/, ""));
        cursor += 1;
        continue;
      }
      break;
    }
    i = cursor - 1;

    const derivedStatus: Task["status"] = checked ? "done" : "todo";
    entries.push({
      subsection: currentSubsection,
      task: TaskSchema.parse({
        title,
        description:
          descriptionLines.length > 0 ? descriptionLines.join("\n") : undefined,
        status: metadata.status ?? derivedStatus,
        checked,
        agentId: metadata.agentId,
        order: entries.length,
      }),
    });
  }

  return entries;
}

function parseTasksFromSection(content: string, heading: string): Task[] {
  return parseSectionTaskEntries(content, heading).map((entry) => entry.task);
}

function parseTaskSubsections(
  content: string,
  heading: string
): { perTask: Array<string | null>; lastSeen: string | null } {
  const lines = extractSectionLines(content, heading);
  const perTask: Array<string | null> = [];
  let currentSubsection: string | null = null;

  for (const line of lines) {
    const subsectionMatch = line.match(SUBSECTION_H3_PATTERN);
    if (subsectionMatch) {
      currentSubsection = subsectionMatch[1]?.trim() || null;
      continue;
    }
    if (TASK_LINE_PATTERN.test(line)) {
      perTask.push(currentSubsection);
    }
  }

  return { perTask, lastSeen: currentSubsection };
}

export function parseTasks(specsContent: string): Task[] {
  return parseTasksFromSection(specsContent, "Tasks");
}

export function parseAcceptanceCriteria(specsContent: string): Task[] {
  return parseTasksFromSection(specsContent, "Acceptance Criteria");
}

function renderTasks(tasks: Task[]): string {
  return tasks.map(renderTask).join("\n\n");
}

function renderTask(task: Task): string {
  const checked = task.checked ? "x" : " ";
  const metadata = [`status:${task.status}`];
  if (task.agentId) {
    metadata.push(`agent:${task.agentId}`);
  }
  const header =
    `- [${checked}] **${task.title}** ${metadata.map((item) => `\`${item}\``).join(" ")}`.trim();
  const description = task.description
    ? `\n${task.description
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}`
    : "";
  return `${header}${description}`;
}

function renderTasksWithSubsections(
  tasks: Task[],
  subsectionByOrder: Array<string | null>,
  fallbackSubsection: string | null
): string {
  if (tasks.length === 0) return "";

  const grouped: Array<{ subsection: string | null; items: Task[] }> = [];
  for (let i = 0; i < tasks.length; i += 1) {
    const subsection = subsectionByOrder[i] ?? fallbackSubsection ?? null;
    const task = tasks[i];
    const lastGroup = grouped[grouped.length - 1];
    if (!lastGroup || lastGroup.subsection !== subsection) {
      grouped.push({ subsection, items: [task] });
      continue;
    }
    lastGroup.items.push(task);
  }

  const blocks = grouped.map((group) => {
    const taskBlock = group.items.map(renderTask).join("\n\n");
    if (!group.subsection) return taskBlock;
    return `### ${group.subsection}\n\n${taskBlock}`;
  });
  return blocks.join("\n\n");
}

function upsertSection(
  specsContent: string,
  heading: string,
  body: string
): string {
  const lines = specsContent.split(/\r?\n/);
  const sectionStart = lines.findIndex(
    (line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase()
  );

  if (sectionStart < 0) {
    const trimmed = specsContent.trimEnd();
    if (!trimmed) {
      return `## ${heading}\n\n${body}\n`;
    }
    return `${trimmed}\n\n## ${heading}\n\n${body}\n`;
  }

  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  const next = [
    ...lines.slice(0, sectionStart + 1),
    "",
    ...body.split("\n"),
    ...lines.slice(sectionEnd),
  ];

  return `${next.join("\n").trimEnd()}\n`;
}

export function serializeTasks(tasks: Task[], specsContent: string): string {
  const normalized = tasks.map((task, order) => ({ ...task, order }));
  const subsectionLayout = parseTaskSubsections(specsContent, "Tasks");
  const body =
    subsectionLayout.perTask.length > 0 || subsectionLayout.lastSeen
      ? renderTasksWithSubsections(
          normalized,
          subsectionLayout.perTask,
          subsectionLayout.lastSeen
        )
      : renderTasks(normalized);
  return upsertSection(specsContent, "Tasks", body);
}

export async function readSpec(
  config: GatewayConfig,
  projectId: string
): Promise<string> {
  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, projectId);
  if (!location) return "";
  const filePath = path.join(location.baseRoot, location.dirName, "SPECS.md");
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function writeSpec(
  config: GatewayConfig,
  projectId: string,
  content: string
): Promise<void> {
  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, projectId);
  if (!location) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const filePath = path.join(location.baseRoot, location.dirName, "SPECS.md");
  await fs.writeFile(filePath, content, "utf8");
}
