import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  expandPath,
  getMaxContextTokens,
  type ContextEstimate,
  type GatewayConfig,
  type ModelUsage,
  type OrchestratorSource,
  type SubagentGlobalListItem,
} from "@yoplai/shared";
import { findProjectLocation } from "../projects/store.js";
import { parseMarkdownFile } from "../taskboard/parser.js";
import { dirExists } from "../util/fs.js";
import { getProjectsRoot } from "../util/paths.js";
import {
  readJsonFile,
  subagentRunStore,
  type SubagentRunConfig,
  type SubagentRunStatus as SubagentStatus,
} from "./run-store.js";

export type SubagentListItem = {
  slug: string;
  type?: "subagent";
  cli?: string;
  name?: string;
  model?: string;
  reasoningEffort?: string;
  thinking?: string;
  runMode?: string;
  projectId?: string;
  sliceId?: string;
  status: SubagentStatus;
  lastActive?: string;
  startedAt?: string;
  finishedAt?: string;
  baseBranch?: string;
  worktreePath?: string;
  source?: OrchestratorSource;
  lastError?: string;
  archived?: boolean;
};

export type SubagentLogEvent = {
  ts?: string;
  type: string;
  text?: string;
  tool?: { name?: string; id?: string };
  diff?: { path?: string; summary?: string };
  parentToolUseId?: string;
};

export type SubagentListResult =
  | { ok: true; data: { items: SubagentListItem[] } }
  | { ok: false; error: string };

export type SubagentLogsResult =
  | {
      ok: true;
      data: {
        cursor: number;
        events: SubagentLogEvent[];
        latestUsage?: ModelUsage;
        latestContextEstimate?: ContextEstimate;
      };
    }
  | { ok: false; error: string };

export type ProjectBranchesResult =
  | { ok: true; data: { branches: string[] } }
  | { ok: false; error: string };

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

function isShellToolName(name?: string): boolean {
  const normalized = (name ?? "").trim().toLowerCase();
  return normalized === "exec_command" || normalized === "bash";
}

function extractShellCommand(
  toolName: string | undefined,
  rawArgs: string | undefined
): string {
  if (!isShellToolName(toolName)) return "";
  const parsed = parseJsonObject(rawArgs ?? "");
  if (!parsed) return "";
  if (typeof parsed.cmd === "string" && parsed.cmd.trim()) {
    return parsed.cmd.trim();
  }
  if (typeof parsed.command === "string" && parsed.command.trim()) {
    return parsed.command.trim();
  }
  return "";
}

function parseShellExecutionResult(text: string): {
  stdout: string;
  stderr: string;
  isError: boolean;
} | null {
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  const output =
    parsed.output && typeof parsed.output === "object"
      ? (parsed.output as Record<string, unknown>)
      : parsed;
  const stdout = output.stdout;
  const stderr = output.stderr;
  const isError = output.is_error ?? output.isError;
  if (typeof stdout !== "string" || typeof stderr !== "string") return null;
  if (typeof isError !== "boolean") return null;
  return { stdout, stderr, isError };
}

function emptyShellOutputDiagnostic(command: string): string {
  return [
    `No output captured for shell command: ${command}`,
    "Hint: run `command -v yoplai && yoplai projects --version` before delegation, then retry (`yoplai projects ...` or `pnpm yoplai projects ...`).",
  ].join("\n");
}

const PI_MODEL_NAMES = [
  "qwen3.5-plus",
  "qwen3-max-2026-01-23",
  "minimax-m2.5",
  "glm-5",
  "kimi-k2.5",
];

function extractUsageFromRawEvent(
  raw: Record<string, unknown>
): { usage: ModelUsage; model?: string } | null {
  const topType = typeof raw.type === "string" ? raw.type : "";

  if (topType === "turn.completed") {
    const usage = raw.usage as Record<string, unknown> | undefined;
    if (!usage) return null;
    const input =
      typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const output =
      typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    const cacheRead =
      typeof usage.cached_input_tokens === "number"
        ? usage.cached_input_tokens
        : undefined;
    const totalTokens =
      typeof usage.total_tokens === "number"
        ? usage.total_tokens
        : input + output;
    return {
      usage: {
        input,
        output,
        cacheRead,
        totalTokens,
      },
      model: typeof raw.model === "string" ? raw.model : undefined,
    };
  }

  if (topType !== "assistant" && topType !== "message_end") {
    return null;
  }

  const message = raw.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!message || !usage) return null;

  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const output =
    typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const cacheRead =
    typeof usage.cache_read_input_tokens === "number"
      ? usage.cache_read_input_tokens
      : undefined;
  const cacheWrite =
    typeof usage.cache_creation_input_tokens === "number"
      ? usage.cache_creation_input_tokens
      : undefined;

  return {
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output,
    },
    model: typeof message.model === "string" ? message.model : undefined,
  };
}

function computeContextEstimate(
  usage?: ModelUsage,
  model?: string,
  codexTurnInfo?: { deltaInput: number; callCount: number }
): ContextEstimate | undefined {
  if (!usage) return undefined;

  const lowerModel = model?.toLowerCase() ?? "";
  const maxTokens = getMaxContextTokens(model);
  const promptTokens =
    usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const pct = Math.round((promptTokens / maxTokens) * 100);

  if (lowerModel.includes("gpt")) {
    if (codexTurnInfo && codexTurnInfo.callCount > 0) {
      const usedTokens = Math.max(
        0,
        Math.round(codexTurnInfo.deltaInput / codexTurnInfo.callCount)
      );
      return {
        usedTokens,
        maxTokens,
        pct: Math.round((usedTokens / maxTokens) * 100),
        basis: "codex_inferred",
        available: true,
      };
    }
    return {
      usedTokens: promptTokens,
      maxTokens,
      pct,
      basis: "codex_cumulative",
      available: false,
      reason: "codex_cumulative_only",
    };
  }

  if (PI_MODEL_NAMES.some((name) => lowerModel.includes(name))) {
    return {
      usedTokens: promptTokens,
      maxTokens,
      pct,
      basis: "pi_prompt_tokens",
      available: false,
      reason: "pi_unconfirmed",
    };
  }

  return {
    usedTokens: promptTokens,
    maxTokens,
    pct,
    basis: "claude_prompt_tokens",
    available: true,
  };
}

function normalizeLogLine(line: string): SubagentLogEvent | SubagentLogEvent[] {
  const trimmed = line.trimEnd();
  if (!trimmed) {
    return { type: "stdout", text: "" };
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const topType = typeof parsed.type === "string" ? parsed.type : "";
    if (topType === "system") {
      return { type: "skip" };
    }
    if (topType === "message_end") {
      const message = parsed.message as Record<string, unknown> | undefined;
      const role = typeof message?.role === "string" ? message.role : "";
      const content = Array.isArray(message?.content) ? message.content : [];
      const events: SubagentLogEvent[] = [];

      for (const entry of content) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        const itemType = typeof item.type === "string" ? item.type : "";
        if (
          itemType === "text" ||
          itemType === "input_text" ||
          itemType === "output_text"
        ) {
          const text = typeof item.text === "string" ? item.text : "";
          if (!text) continue;
          if (role === "toolResult") {
            events.push({
              type: "tool_output",
              text,
              tool: {
                id:
                  typeof message?.toolCallId === "string"
                    ? message.toolCallId
                    : "",
                name:
                  typeof message?.toolName === "string" ? message.toolName : "",
              },
            });
          } else {
            events.push({
              type: role === "assistant" ? "assistant" : "user",
              text,
            });
          }
          continue;
        }
        if (itemType === "toolCall" || itemType === "tool_use") {
          const name = typeof item.name === "string" ? item.name : "";
          const id = typeof item.id === "string" ? item.id : "";
          const args =
            item.arguments ??
            item.input ??
            (typeof item.args === "object" ? item.args : undefined);
          const text =
            typeof args === "string" ? args : args ? JSON.stringify(args) : "";
          events.push({ type: "tool_call", text, tool: { name, id } });
        }
      }
      return events.length > 0 ? events : { type: "skip" };
    }
    if (topType === "tool_execution_start") {
      const toolName =
        typeof parsed.toolName === "string" ? parsed.toolName : "";
      const toolId =
        typeof parsed.toolCallId === "string" ? parsed.toolCallId : "";
      const args =
        typeof parsed.args === "string"
          ? parsed.args
          : parsed.args
            ? JSON.stringify(parsed.args)
            : "";
      return {
        type: "tool_call",
        text: args,
        tool: { name: toolName, id: toolId },
      };
    }
    if (topType === "tool_execution_end") {
      const toolId =
        typeof parsed.toolCallId === "string" ? parsed.toolCallId : "";
      const toolName =
        typeof parsed.toolName === "string" ? parsed.toolName : "";
      const result =
        typeof parsed.result === "string"
          ? parsed.result
          : parsed.result
            ? JSON.stringify(parsed.result)
            : "";
      const isError = parsed.isError === true;
      return {
        type: isError ? "error" : "tool_output",
        text: result,
        tool: { name: toolName, id: toolId },
      };
    }
    if (topType === "assistant" || topType === "user") {
      const message = parsed.message as Record<string, unknown> | undefined;
      const role = typeof message?.role === "string" ? message.role : topType;
      const content = Array.isArray(message?.content) ? message?.content : [];
      const events: SubagentLogEvent[] = [];
      for (const entry of content) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        const itemType = typeof item.type === "string" ? item.type : "";
        if (
          itemType === "text" ||
          itemType === "input_text" ||
          itemType === "output_text"
        ) {
          const text = typeof item.text === "string" ? item.text : "";
          if (text) {
            events.push({
              type: role === "assistant" ? "assistant" : "user",
              text,
            });
          }
          continue;
        }
        if (itemType === "tool_use") {
          const name = typeof item.name === "string" ? item.name : "";
          const id = typeof item.id === "string" ? item.id : "";
          const input = item.input as Record<string, unknown> | undefined;
          const text = input ? JSON.stringify(input) : "";
          events.push({ type: "tool_call", text, tool: { name, id } });
          continue;
        }
        if (itemType === "tool_result") {
          const toolId =
            typeof item.tool_use_id === "string" ? item.tool_use_id : "";
          let text = "";
          if (typeof item.content === "string") {
            text = item.content;
          } else if (Array.isArray(item.content)) {
            text = item.content
              .map((block) => {
                if (!block || typeof block !== "object") return "";
                const contentItem = block as Record<string, unknown>;
                return typeof contentItem.text === "string"
                  ? contentItem.text
                  : "";
              })
              .filter(Boolean)
              .join("\n");
          }
          if (text) {
            events.push({ type: "tool_output", text, tool: { id: toolId } });
          }
          continue;
        }
      }
      return events.length > 0 ? events : { type: "skip" };
    }
    if (topType === "result") {
      const text = typeof parsed.result === "string" ? parsed.result : "";
      return text ? { type: "assistant", text } : { type: "skip" };
    }
    if (
      topType === "session_meta" ||
      topType === "turn_context" ||
      topType === "session" ||
      topType === "agent_start" ||
      topType === "agent_end" ||
      topType === "turn_start" ||
      topType === "turn_end" ||
      topType === "message_start" ||
      topType === "thread.started" ||
      topType === "turn.started" ||
      topType === "turn.completed"
    ) {
      return { type: "skip" };
    }
    if (topType === "item.completed") {
      const item = parsed.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message") {
        return {
          type: "assistant",
          text: typeof item?.text === "string" ? item.text : "",
        };
      }
      if (item?.type === "command_execution") {
        const output =
          typeof item?.aggregated_output === "string"
            ? item.aggregated_output
            : "";
        return {
          type: "tool_output",
          text: output,
          tool: { id: typeof item?.id === "string" ? item.id : "" },
        };
      }
      if (item?.type === "error") {
        return {
          type: "error",
          text: typeof item?.message === "string" ? item.message : "",
        };
      }
      return { type: "skip" };
    }
    if (topType === "item.started") {
      const item = parsed.item as Record<string, unknown> | undefined;
      if (item?.type === "command_execution") {
        const command = typeof item?.command === "string" ? item.command : "";
        const payload = JSON.stringify({ cmd: command });
        return {
          type: "tool_call",
          text: payload,
          tool: {
            name: "exec_command",
            id: typeof item?.id === "string" ? item.id : "",
          },
        };
      }
      return { type: "skip" };
    }
    if (topType === "event_msg") {
      const payload = parsed.payload as Record<string, unknown> | undefined;
      const payloadType = typeof payload?.type === "string" ? payload.type : "";
      if (payloadType === "user_message") {
        return {
          type: "user",
          text: typeof payload?.message === "string" ? payload.message : "",
        };
      }
      if (payloadType === "agent_message") {
        return {
          type: "assistant",
          text: typeof payload?.message === "string" ? payload.message : "",
        };
      }
      return { type: "skip" };
    }
    if ("response" in parsed || "stats" in parsed || "error" in parsed) {
      const events: SubagentLogEvent[] = [];
      const response =
        typeof parsed.response === "string" ? parsed.response : "";
      if (response) {
        events.push({ type: "assistant", text: response });
      }
      const error = parsed.error as Record<string, unknown> | undefined;
      const errorMessage =
        typeof error?.message === "string" ? error.message : "";
      if (errorMessage) {
        events.push({ type: "error", text: errorMessage });
      }
      return events.length > 0 ? events : { type: "skip" };
    }
    if (topType === "response_item") {
      const payload = parsed.payload as Record<string, unknown> | undefined;
      const payloadType = typeof payload?.type === "string" ? payload.type : "";
      if (payloadType === "message") {
        const role = typeof payload?.role === "string" ? payload.role : "";
        if (role !== "assistant") return { type: "skip" };
        const content = payload?.content;
        let text = "";
        if (Array.isArray(content)) {
          text = content
            .map((entry) => {
              if (!entry || typeof entry !== "object") return "";
              const item = entry as Record<string, unknown>;
              if (
                item.type === "output_text" ||
                item.type === "input_text" ||
                item.type === "text"
              ) {
                return typeof item.text === "string" ? item.text : "";
              }
              return "";
            })
            .filter(Boolean)
            .join("\n");
        }
        return { type: "assistant", text };
      }
      if (payloadType === "function_call") {
        return {
          type: "tool_call",
          text: typeof payload?.arguments === "string" ? payload.arguments : "",
          tool: {
            name: typeof payload?.name === "string" ? payload.name : "",
            id: typeof payload?.call_id === "string" ? payload.call_id : "",
          },
        };
      }
      if (payloadType === "function_call_output") {
        return {
          type: "tool_output",
          text: typeof payload?.output === "string" ? payload.output : "",
          tool: {
            id: typeof payload?.call_id === "string" ? payload.call_id : "",
          },
        };
      }
      if (payloadType === "custom_tool_call") {
        return {
          type: "tool_call",
          text: typeof payload?.input === "string" ? payload.input : "",
          tool: {
            name: typeof payload?.name === "string" ? payload.name : "",
            id: typeof payload?.call_id === "string" ? payload.call_id : "",
          },
        };
      }
      if (payloadType === "custom_tool_call_output") {
        return {
          type: "tool_output",
          text: typeof payload?.output === "string" ? payload.output : "",
          tool: {
            id: typeof payload?.call_id === "string" ? payload.call_id : "",
          },
        };
      }
      return { type: "skip" };
    }
    const text =
      typeof parsed.text === "string"
        ? parsed.text
        : typeof parsed.content === "string"
          ? parsed.content
          : typeof parsed.message === "string"
            ? parsed.message
            : undefined;
    const parsedType =
      typeof parsed.type === "string" ? parsed.type : undefined;

    if (
      parsedType &&
      [
        "stdout",
        "stderr",
        "tool_call",
        "tool_output",
        "diff",
        "message",
        "error",
        "session",
      ].includes(parsedType)
    ) {
      return {
        ts: typeof parsed.ts === "string" ? parsed.ts : undefined,
        type: parsedType,
        text: text ?? trimmed,
      };
    }
  } catch {
    // fall through to raw
  }

  return { type: "stdout", text: trimmed };
}

export async function listSubagents(
  config: GatewayConfig,
  projectId: string,
  includeArchived = false
): Promise<SubagentListResult> {
  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, projectId);
  if (!location) {
    return { ok: false, error: `Project not found: ${projectId}` };
  }

  const projectDir = path.join(location.baseRoot, location.dirName);
  await subagentRunStore.migrateProject(root, projectId, projectDir);
  const items = await subagentRunStore.list(projectDir, { includeArchived });

  return { ok: true, data: { items } };
}

export type ArchiveSubagentResult =
  | { ok: true; data: { slug: string; archived: boolean } }
  | { ok: false; error: string };

type SubagentStoredConfig = SubagentRunConfig;

export type ReadSubagentConfigResult =
  | { ok: true; data: SubagentStoredConfig }
  | { ok: false; error: string };

export type UpdateSubagentConfigInput = {
  name?: string;
  model?: string;
  reasoningEffort?: string;
  thinking?: string;
};

export type UpdateSubagentConfigResult =
  | {
      ok: true;
      data: {
        slug: string;
        name?: string;
        model?: string;
        reasoningEffort?: string;
        thinking?: string;
      };
    }
  | { ok: false; error: string };

async function resolveSubagentConfigPath(
  config: GatewayConfig,
  projectId: string,
  slug: string
): Promise<
  { ok: true; data: { configPath: string } } | { ok: false; error: string }
> {
  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, projectId);
  if (!location) {
    return { ok: false, error: `Project not found: ${projectId}` };
  }

  const projectDir = path.join(location.baseRoot, location.dirName);
  await subagentRunStore.migrateProject(root, projectId, projectDir);
  const run = await subagentRunStore.read(projectDir, slug);
  if (!run) {
    return { ok: false, error: `Subagent not found: ${slug}` };
  }

  const configPath = path.join(run.runDir, "config.json");
  if (!(await pathExists(configPath))) {
    return { ok: false, error: `Subagent config missing: ${slug}` };
  }

  return { ok: true, data: { configPath } };
}

export async function readSubagentConfig(
  config: GatewayConfig,
  projectId: string,
  slug: string
): Promise<ReadSubagentConfigResult> {
  const resolved = await resolveSubagentConfigPath(config, projectId, slug);
  if (!resolved.ok) return resolved;
  const configData = await readJsonFile<SubagentStoredConfig>(
    resolved.data.configPath
  );
  if (!configData) {
    return { ok: false, error: `Subagent config missing: ${slug}` };
  }
  return { ok: true, data: configData };
}

export async function updateSubagentConfig(
  config: GatewayConfig,
  projectId: string,
  slug: string,
  patch: UpdateSubagentConfigInput
): Promise<UpdateSubagentConfigResult> {
  const resolved = await resolveSubagentConfigPath(config, projectId, slug);
  if (!resolved.ok) return resolved;
  const current = await readJsonFile<SubagentStoredConfig>(
    resolved.data.configPath
  );
  if (!current) {
    return { ok: false, error: `Subagent config missing: ${slug}` };
  }

  const next: SubagentStoredConfig = { ...current };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.reasoningEffort !== undefined) {
    next.reasoningEffort = patch.reasoningEffort;
  }
  if (patch.thinking !== undefined) next.thinking = patch.thinking;

  await fs.writeFile(resolved.data.configPath, JSON.stringify(next, null, 2));

  return {
    ok: true,
    data: {
      slug,
      name: next.name,
      model: next.model,
      reasoningEffort: next.reasoningEffort,
      thinking: next.thinking,
    },
  };
}

export async function archiveSubagent(
  config: GatewayConfig,
  projectId: string,
  slug: string
): Promise<ArchiveSubagentResult> {
  return updateSubagentArchive(config, projectId, slug, true);
}

export async function unarchiveSubagent(
  config: GatewayConfig,
  projectId: string,
  slug: string
): Promise<ArchiveSubagentResult> {
  return updateSubagentArchive(config, projectId, slug, false);
}

async function updateSubagentArchive(
  config: GatewayConfig,
  projectId: string,
  slug: string,
  archived: boolean
): Promise<ArchiveSubagentResult> {
  const resolved = await resolveSubagentConfigPath(config, projectId, slug);
  if (!resolved.ok) return resolved;

  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, projectId);
  if (!location) {
    return { ok: false, error: `Project not found: ${projectId}` };
  }
  const projectDir = path.join(location.baseRoot, location.dirName);
  if (archived) await subagentRunStore.archive(projectDir, slug);
  else await subagentRunStore.unarchive(projectDir, slug);

  return { ok: true, data: { slug, archived } };
}

export type ListAllSubagentsOptions = {
  projectId?: string;
  sliceId?: string;
  status?: string;
  includeArchived?: boolean;
  cwd?: string;
};

function toGlobalSubagentItem(
  run: SubagentListItem,
  projectId: string
): SubagentGlobalListItem {
  return {
    projectId: run.projectId ?? projectId,
    sliceId: run.sliceId,
    slug: run.slug,
    type: run.type,
    cli: run.cli,
    name: run.name,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    thinking: run.thinking,
    runMode: run.runMode,
    baseBranch: run.baseBranch,
    worktreePath: run.worktreePath,
    source: run.source,
    status: run.status,
    lastActive: run.lastActive,
    runStartedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

function matchesSubagentFilters(
  item: SubagentGlobalListItem,
  options: ListAllSubagentsOptions
): boolean {
  if (options.projectId && item.projectId !== options.projectId) return false;
  if (options.sliceId && item.sliceId !== options.sliceId) return false;
  if (options.status && item.status !== options.status) return false;
  if (options.cwd && item.worktreePath !== options.cwd) return false;
  return true;
}

export async function listAllSubagents(
  config: GatewayConfig,
  options: ListAllSubagentsOptions = {}
): Promise<SubagentGlobalListItem[]> {
  const root = getProjectsRoot(config);
  if (!(await dirExists(root))) return [];

  const items: SubagentGlobalListItem[] = [];

  if (options.projectId) {
    const result = await listSubagents(
      config,
      options.projectId,
      options.includeArchived
    );
    if (!result.ok) return [];
    return result.data.items
      .map((run) => toGlobalSubagentItem(run, options.projectId!))
      .filter((item) => matchesSubagentFilters(item, options));
  }

  const roots = [root, path.join(root, ".done")];
  for (const scanRoot of roots) {
    if (!(await dirExists(scanRoot))) continue;
    const projectDirs = await fs.readdir(scanRoot, { withFileTypes: true });
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith("PRO-")) continue;
      const projectId = entry.name.split("_")[0];
      const projectDir = path.join(scanRoot, entry.name);
      await subagentRunStore.migrateProject(root, projectId, projectDir);
      const runs = await subagentRunStore.list(projectDir, {
        includeArchived: options.includeArchived,
      });
      for (const run of runs) {
        const item = toGlobalSubagentItem(run, projectId);
        if (matchesSubagentFilters(item, options)) items.push(item);
      }
    }
  }

  return items;
}

export async function getSubagentLogs(
  config: GatewayConfig,
  projectId: string,
  slug: string,
  since: number
): Promise<SubagentLogsResult> {
  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, projectId);
  if (!location) {
    return { ok: false, error: `Project not found: ${projectId}` };
  }

  const projectDir = path.join(location.baseRoot, location.dirName);
  await subagentRunStore.migrateProject(root, projectId, projectDir);
  const sessionDir = subagentRunStore.locate(projectDir, slug);
  const logsPath = path.join(sessionDir, "logs.jsonl");
  const storedConfig = await readJsonFile<{ model?: string }>(
    path.join(sessionDir, "config.json")
  );
  let stat;
  try {
    stat = await fs.stat(logsPath);
  } catch {
    return {
      ok: true,
      data: { cursor: 0, events: [], latestUsage: undefined },
    };
  }

  const size = stat.size;
  const buffer = await fs.readFile(logsPath);
  const allText = buffer.toString("utf8");
  const allLines = allText.split(/\r?\n/).filter((line) => line.length > 0);
  let latestRawUsage: ModelUsage | undefined;
  let latestModel = storedConfig?.model;
  let prevCumulativeInput = 0;
  let agentMessageCount = 0;
  let latestCodexTurnInfo:
    | { deltaInput: number; callCount: number }
    | undefined;

  for (const line of allLines) {
    const raw = parseJsonObject(line);
    if (raw) {
      const rawType = typeof raw.type === "string" ? raw.type : "";
      if (rawType === "item.completed") {
        const item = raw.item as Record<string, unknown> | undefined;
        if (item?.type === "agent_message") {
          agentMessageCount += 1;
        }
      }
      const extracted = extractUsageFromRawEvent(raw);
      if (extracted) {
        latestRawUsage = extracted.usage;
        latestModel = extracted.model ?? latestModel;
        if (rawType === "turn.completed") {
          const deltaInput = Math.max(
            0,
            extracted.usage.input - prevCumulativeInput
          );
          const callCount = Math.max(agentMessageCount, 1);
          latestCodexTurnInfo = { deltaInput, callCount };
          prevCumulativeInput = extracted.usage.input;
          agentMessageCount = 0;
        }
      }
    }
  }

  if (since >= size) {
    return {
      ok: true,
      data: {
        cursor: size,
        events: [],
        latestUsage: latestRawUsage,
        latestContextEstimate: computeContextEstimate(
          latestRawUsage,
          latestModel,
          latestCodexTurnInfo
        ),
      },
    };
  }

  const slice = buffer.subarray(Math.max(0, since));
  const text = slice.toString("utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const events: SubagentLogEvent[] = [];
  const shellCommandByToolId = new Map<string, string>();
  for (const line of lines) {
    const raw = parseJsonObject(line);

    const parentToolUseId =
      raw && typeof raw.parent_tool_use_id === "string"
        ? raw.parent_tool_use_id
        : undefined;
    const normalized = normalizeLogLine(line);
    const attach = (ev: SubagentLogEvent): SubagentLogEvent =>
      parentToolUseId ? { ...ev, parentToolUseId } : ev;
    const appendEvent = (ev: SubagentLogEvent): void => {
      const next = attach(ev);
      events.push(next);
      const toolId = next.tool?.id?.trim();
      if (next.type === "tool_call" && toolId) {
        const command = extractShellCommand(next.tool?.name, next.text);
        if (command) shellCommandByToolId.set(toolId, command);
      }
      if (next.type !== "tool_output" || !toolId) return;
      const command = shellCommandByToolId.get(toolId);
      if (!command) return;
      const shellResult = parseShellExecutionResult(next.text ?? "");
      if (!shellResult) return;
      if (
        shellResult.stdout === "" &&
        shellResult.stderr === "" &&
        shellResult.isError === false
      ) {
        events.push(
          attach({
            type: "warning",
            text: emptyShellOutputDiagnostic(command),
            tool: { id: toolId, name: next.tool?.name },
          })
        );
      }
    };
    if (Array.isArray(normalized)) {
      for (const ev of normalized) {
        appendEvent(ev);
      }
    } else if (normalized.type !== "skip") {
      appendEvent(normalized);
    }
  }

  return {
    ok: true,
    data: {
      cursor: size,
      events,
      latestUsage: latestRawUsage,
      latestContextEstimate: computeContextEstimate(
        latestRawUsage,
        latestModel,
        latestCodexTurnInfo
      ),
    },
  };
}

export async function listProjectBranches(
  config: GatewayConfig,
  projectId: string
): Promise<ProjectBranchesResult> {
  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, projectId);
  if (!location) {
    return { ok: false, error: `Project not found: ${projectId}` };
  }

  const readmePath = path.join(
    location.baseRoot,
    location.dirName,
    "README.md"
  );
  const specsPath = path.join(location.baseRoot, location.dirName, "SPECS.md");
  let frontmatter: Record<string, unknown> = {};
  try {
    if (await pathExists(readmePath)) {
      frontmatter = (await parseMarkdownFile(readmePath)).frontmatter;
    } else if (await pathExists(specsPath)) {
      frontmatter = (await parseMarkdownFile(specsPath)).frontmatter;
    }
  } catch {
    frontmatter = {};
  }
  const repo =
    typeof frontmatter.repo === "string" ? expandPath(frontmatter.repo) : "";
  if (!repo) {
    return { ok: true, data: { branches: [] } };
  }

  if (!(await pathExists(path.join(repo, ".git")))) {
    return { ok: true, data: { branches: [] } };
  }

  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("git", [
      "-C",
      repo,
      "branch",
      "--format=%(refname:short)",
    ]);
    const branches = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return { ok: true, data: { branches } };
  } catch {
    return { ok: true, data: { branches: [] } };
  }
}
