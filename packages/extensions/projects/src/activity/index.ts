import {
  DEFAULT_MAIN_KEY,
  normalizeProjectStatus,
  resolveHomeDir,
  type GatewayConfig,
} from "@yoplai/shared";
import fs from "node:fs";
import path from "node:path";
import { listProjects } from "../projects/index.js";
import { listAllSubagents } from "../subagents/index.js";
import { getProjectsContext } from "../context.js";

type ActivityColor = "green" | "purple" | "blue" | "yellow";

export type ActivityEvent = {
  id: string;
  type:
    | "project_status"
    | "agent_message"
    | "subagent_action"
    | "project_comment"
    | "slice_blocked"
    | "slice_unblocked";
  actor: string;
  action: string;
  projectId?: string;
  sliceId?: string;
  blockers?: string[];
  subagentSlug?: string;
  timestamp: string;
  color: ActivityColor;
};

const lastProjectStatuses = new Map<string, string>();
const lastAgentMessageTs = new Map<string, number>();
const lastSubagentFingerprint = new Map<string, string>();
const cachedEvents: ActivityEvent[] = [];
const STORE_PATH = path.join(resolveHomeDir(), "activity.json");
let loaded = false;

function ensureLoaded() {
  if (loaded) return;
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      cachedEvents.push(...(parsed as ActivityEvent[]));
    }
  } catch {
    // ignore missing/invalid store
  }
  loaded = true;
}

async function saveEvents(events: ActivityEvent[]) {
  await fs.promises.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const json = JSON.stringify(events, null, 2);
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, json, "utf-8");
  await fs.promises.rename(tmp, STORE_PATH);
}

function mergeEvents(events: ActivityEvent[]) {
  const merged = [...events, ...cachedEvents];
  const seen = new Set<string>();
  const deduped: ActivityEvent[] = [];
  for (const event of merged) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    deduped.push(event);
  }
  deduped.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  cachedEvents.length = 0;
  cachedEvents.push(...deduped.slice(0, 100));
}

async function recordActivityEvents(events: ActivityEvent[]) {
  if (events.length === 0) return;
  ensureLoaded();
  mergeEvents(events);
  await saveEvents(cachedEvents);
}

function formatStatus(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusColor(status: string): ActivityColor {
  if (status === "done" || status === "in_progress") return "green";
  if (status === "review") return "purple";
  if (status === "maybe" || status === "shaping") return "yellow";
  return "blue";
}

function truncate(text: string, max = 80): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function subagentColor(status: string): ActivityColor {
  if (status === "running") return "green";
  if (status === "error") return "yellow";
  if (status === "replied") return "purple";
  return "blue";
}

function buildSubagentFingerprint(subagent: {
  status: "running" | "replied" | "error" | "idle";
  lastActive?: string;
  runStartedAt?: string;
}): string {
  if (subagent.status === "running") {
    return `running:${subagent.runStartedAt ?? "none"}`;
  }
  return `${subagent.status}:${subagent.lastActive ?? "none"}`;
}

export async function getRecentActivity(
  config: GatewayConfig,
  options?: { offset?: number; limit?: number }
): Promise<ActivityEvent[]> {
  ensureLoaded();
  const events: ActivityEvent[] = [];
  const nowIso = new Date().toISOString();
  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);
  const offset = Math.max(options?.offset ?? 0, 0);

  const projects = await listProjects(config);
  if (projects.ok) {
    for (const project of projects.data) {
      const status = normalizeProjectStatus(
        String(project.frontmatter?.status ?? "")
      );
      const prev = lastProjectStatuses.get(project.id);
      lastProjectStatuses.set(project.id, status);
      if (prev && prev !== status) {
        events.push({
          id: `project-${project.id}-${Date.now()}`,
          type: "project_status",
          actor: "Yoplai",
          action: `moved ${project.id} to ${formatStatus(status)}`,
          projectId: project.id,
          timestamp: nowIso,
          color: statusColor(status),
        });
      }
    }
  }

  const agents = getProjectsContext().getAgents();
  for (const agent of agents) {
    const entry = await getProjectsContext().getSessionEntry(agent.id, DEFAULT_MAIN_KEY);
    if (!entry) continue;
    const history = await getProjectsContext().getSessionHistory(agent.id, entry.sessionId);
    const last = [...history].reverse().find((msg) => msg.role === "assistant");
    if (!last || typeof last.timestamp !== "number") continue;
    const prevTs = lastAgentMessageTs.get(agent.id);
    if (prevTs === last.timestamp) continue;
    lastAgentMessageTs.set(agent.id, last.timestamp);
    const assistantText =
      typeof last.content === "string"
        ? last.content
        : last.content
            .map((block) => {
              const maybeText = (block as { text?: unknown }).text;
              return typeof maybeText === "string" ? maybeText : "";
            })
            .join("\n");
    const text = truncate(assistantText.trim());
    if (!text) continue;
    events.push({
      id: `agent-${agent.id}-${last.timestamp}`,
      type: "agent_message",
      actor: agent.name,
      action: `said: ${text}`,
      timestamp: new Date(last.timestamp).toISOString(),
      color: "blue",
    });
  }

  const subagents = await listAllSubagents(config);
  for (const subagent of subagents) {
    const key = `${subagent.projectId}:${subagent.slug}`;
    const fingerprint = buildSubagentFingerprint(subagent);
    const prev = lastSubagentFingerprint.get(key);
    if (prev === fingerprint) continue;
    lastSubagentFingerprint.set(key, fingerprint);
    const actor = `${subagent.projectId}/${subagent.cli ?? subagent.slug}`;
    const action =
      subagent.status === "running"
        ? "is running"
        : subagent.status === "error"
          ? "errored"
          : subagent.status === "replied"
            ? "replied"
            : "is idle";
    events.push({
      id: `subagent-${key}-${fingerprint}`,
      type: "subagent_action",
      actor,
      action,
      projectId: subagent.projectId,
      subagentSlug: subagent.slug,
      timestamp:
        subagent.status === "running"
          ? (subagent.runStartedAt ?? subagent.lastActive ?? nowIso)
          : (subagent.lastActive ?? nowIso),
      color: subagentColor(subagent.status),
    });
  }

  if (events.length > 0) {
    await recordActivityEvents(events);
  }

  return cachedEvents.slice(offset, offset + limit);
}

export async function recordProjectStatusActivity(params: {
  actor?: string;
  projectId: string;
  status: string;
  timestamp?: string;
}): Promise<void> {
  ensureLoaded();
  const normalizedStatus = normalizeProjectStatus(params.status);
  const actor = params.actor?.trim() ? params.actor.trim() : "Yoplai";
  const event: ActivityEvent = {
    id: `project-${params.projectId}-${Date.now()}`,
    type: "project_status",
    actor,
    action: `moved ${params.projectId} to ${formatStatus(normalizedStatus)}`,
    projectId: params.projectId,
    timestamp: params.timestamp ?? new Date().toISOString(),
    color: statusColor(normalizedStatus),
  };
  lastProjectStatuses.set(params.projectId, normalizedStatus);
  await recordActivityEvents([event]);
}

export async function recordCommentActivity(params: {
  actor: string;
  projectId: string;
  commentExcerpt: string;
  timestamp?: string;
}): Promise<void> {
  ensureLoaded();
  const excerpt = truncate(params.commentExcerpt, 80);
  const event: ActivityEvent = {
    id: `comment-${params.projectId}-${Date.now()}`,
    type: "project_comment",
    actor: params.actor,
    action: `commented on ${params.projectId}: ${excerpt}`,
    projectId: params.projectId,
    timestamp: params.timestamp ?? new Date().toISOString(),
    color: "blue",
  };
  await recordActivityEvents([event]);
}

export async function recordSliceBlockedActivity(params: {
  actor: string;
  projectId: string;
  sliceId: string;
  blockers: string[];
  timestamp?: string;
}): Promise<void> {
  ensureLoaded();
  const event: ActivityEvent = {
    id: `slice-blocked-${params.sliceId}-${Date.now()}`,
    type: "slice_blocked",
    actor: params.actor,
    action: `blocked ${params.sliceId} on ${params.blockers.join(", ")}`,
    projectId: params.projectId,
    sliceId: params.sliceId,
    blockers: params.blockers,
    timestamp: params.timestamp ?? new Date().toISOString(),
    color: "yellow",
  };
  await recordActivityEvents([event]);
}

export async function recordSliceUnblockedActivity(params: {
  actor: string;
  projectId: string;
  sliceId: string;
  blockers?: string[];
  timestamp?: string;
}): Promise<void> {
  ensureLoaded();
  const action =
    params.blockers && params.blockers.length > 0
      ? `unblocked ${params.sliceId} from ${params.blockers.join(", ")}`
      : `cleared blockers for ${params.sliceId}`;
  const event: ActivityEvent = {
    id: `slice-unblocked-${params.sliceId}-${Date.now()}`,
    type: "slice_unblocked",
    actor: params.actor,
    action,
    projectId: params.projectId,
    sliceId: params.sliceId,
    blockers: params.blockers ?? [],
    timestamp: params.timestamp ?? new Date().toISOString(),
    color: "blue",
  };
  await recordActivityEvents([event]);
}
