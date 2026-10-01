import fs from "node:fs/promises";
import path from "node:path";
import {
  isBuiltinTool,
  validateToolLabelTemplate,
  type ToolLabelTemplates,
} from "@yoplai/shared/tool-labels";
import { CONFIG_DIR, loadConfig } from "../config/index.js";
import { logWarn } from "../logging.js";
import { MaintenanceCompletion } from "./completion.js";

const TOOL_LABEL_PROMPT = [
  "You write short UI labels for tool calls in a chat activity log.",
  "Given a tool name and the argument names seen, reply with ONE past-tense, sentence-case label, max 60 characters, e.g. \"Listed Claap workspaces\" or \"Fetched recordings for {workspaceId}\".",
  "You may reference argument names as {argName} placeholders, only from the provided list, and only when the value is short and meaningful.",
  "No quotes, no trailing period, no explanation. Output only the label.",
].join(" ");
const TOOL_LABEL_TIMEOUT_MS = 30_000;
const TOOL_LABEL_MAX_TOKENS = 512;
const MAX_TOOL_NAME_LENGTH = 200;

type ToolLabelDeps = {
  filePath?: string;
  complete?: typeof MaintenanceCompletion.complete;
  hasMaintenanceModel?: () => boolean;
};

let testDeps: ToolLabelDeps = {};
let cache: { filePath: string; templates: ToolLabelTemplates } | undefined;
const inFlight = new Set<string>();

export function setToolLabelDepsForTests(deps: ToolLabelDeps): void {
  testDeps = deps;
  cache = undefined;
  inFlight.clear();
}

export function resetToolLabelDepsForTests(): void {
  setToolLabelDepsForTests({});
}

function storePath(deps: ToolLabelDeps): string {
  return deps.filePath ?? path.join(CONFIG_DIR, "tool-labels.json");
}

export async function readToolLabels(
  deps: ToolLabelDeps = {}
): Promise<ToolLabelTemplates> {
  const filePath = storePath({ ...testDeps, ...deps });
  if (cache?.filePath === filePath) return cache.templates;
  let templates: ToolLabelTemplates = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      templates = Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logWarn("[maintenance] tool-labels read failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  cache = { filePath, templates };
  return templates;
}

async function writeToolLabels(
  filePath: string,
  templates: ToolLabelTemplates
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(templates, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
  cache = { filePath, templates };
}

function configHasMaintenanceModel(): boolean {
  try {
    return Boolean(loadConfig().maintenance);
  } catch {
    return false;
  }
}

function argKeysOf(args: unknown): string[] {
  return args && typeof args === "object" && !Array.isArray(args)
    ? Object.keys(args)
    : [];
}

/** Generate and store a label template for `toolName` unless one exists or is in flight. */
export async function generateToolLabel(
  params: {
    agentId: string;
    sessionId?: string;
    userId?: string;
    toolName: string;
    args: unknown;
  },
  deps: ToolLabelDeps = {}
): Promise<string | null> {
  const active = { ...testDeps, ...deps };
  const { toolName } = params;
  if (!toolName || toolName.length > MAX_TOOL_NAME_LENGTH) return null;
  if (isBuiltinTool(toolName)) return null;
  if (!(active.hasMaintenanceModel ?? configHasMaintenanceModel)()) return null;
  if (inFlight.has(toolName)) return null;
  if ((await readToolLabels(active))[toolName]) return null;
  inFlight.add(toolName);
  try {
    const argKeys = argKeysOf(params.args);
    const generated = await (active.complete ?? MaintenanceCompletion.complete)({
      agentId: params.agentId,
      sessionId: params.sessionId,
      userId: params.userId,
      system: TOOL_LABEL_PROMPT,
      prompt: `Tool name: ${toolName}\nArgument names: ${argKeys.length ? argKeys.join(", ") : "(none)"}`,
      maxTokens: TOOL_LABEL_MAX_TOKENS,
      timeoutMs: TOOL_LABEL_TIMEOUT_MS,
    });
    const template = generated
      ? validateToolLabelTemplate(generated, argKeys)
      : null;
    if (!template) return null;
    const filePath = storePath(active);
    const templates = { ...(await readToolLabels(active)), [toolName]: template };
    await writeToolLabels(filePath, templates);
    return template;
  } finally {
    inFlight.delete(toolName);
  }
}

/** Fire-and-forget; never blocks or fails a run. */
export function maybeGenerateToolLabel(params: {
  agentId: string;
  sessionId?: string;
  userId?: string;
  toolName: string;
  args: unknown;
}): void {
  void generateToolLabel(params).catch((error: unknown) => {
    logWarn("[maintenance] tool-label generation failed", {
      toolName: params.toolName,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
