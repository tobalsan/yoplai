/** Browser-safe helpers that turn raw tool calls into friendly one-line labels. */

export const TOOL_LABEL_MAX_LENGTH = 80;
const ARG_VALUE_MAX_LENGTH = 60;
const PLACEHOLDER_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export type ToolLabelTemplates = Record<string, string>;

/** Core tools with built-in argument-aware labels; never templated. */
const BUILTIN_TOOLS = new Set(["bash", "read", "edit", "write", "grep", "find"]);

export function isBuiltinTool(name: string): boolean {
  return BUILTIN_TOOLS.has(name.toLowerCase());
}

function truncateText(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > max
    ? `${singleLine.slice(0, Math.max(0, max - 1))}…`
    : singleLine;
}

function words(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .toLowerCase();
}

/** `mcp__claap__list_workspaces` → "Claap · list workspaces". */
export function humanizeToolName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    const server = words(mcp[1]);
    const tool = words(mcp[2]);
    return `${server.charAt(0).toUpperCase()}${server.slice(1)} · ${tool}`;
  }
  const text = words(name);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function stringArg(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringifyArg(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      return undefined;
    }
  }
  text = truncateText(text, ARG_VALUE_MAX_LENGTH);
  return text || undefined;
}

/** Instant label with no stored template: key args for common tools, else humanized name. */
export function fallbackToolLabel(name: string, args: unknown): string {
  const lower = name.toLowerCase();
  const file = stringArg(args, "path") ?? stringArg(args, "file_path");
  const fileName = file ? (file.split("/").filter(Boolean).at(-1) ?? file) : undefined;
  const command = stringArg(args, "command");
  const pattern = stringArg(args, "pattern") ?? stringArg(args, "query");
  if (lower === "bash" && command) {
    return `Ran \`${truncateText(command, ARG_VALUE_MAX_LENGTH)}\``;
  }
  if (lower === "read" && fileName) return `Read ${fileName}`;
  if (lower === "edit" && fileName) return `Edited ${fileName}`;
  if (lower === "write" && fileName) return `Wrote ${fileName}`;
  if ((lower === "grep" || lower === "find") && pattern) {
    return `Searched for ${truncateText(pattern, ARG_VALUE_MAX_LENGTH)}`;
  }
  return `Called tool: ${humanizeToolName(name)}`;
}

/**
 * Clean a model-produced template. Returns null when it is unusable: empty, too
 * long, or referencing placeholders that are not known top-level argument keys.
 */
export function validateToolLabelTemplate(
  raw: string,
  argKeys: readonly string[]
): string | null {
  const template = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!template || template.length > TOOL_LABEL_MAX_LENGTH) return null;
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    if (!argKeys.includes(match[1])) return null;
  }
  return template;
}

/** Fill `{arg}` placeholders; null when any referenced arg is missing. */
export function fillToolLabelTemplate(
  template: string,
  args: unknown
): string | null {
  const record =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  let missing = false;
  const filled = template.replace(PLACEHOLDER_PATTERN, (_all, key: string) => {
    const value = stringifyArg(record[key]);
    if (value === undefined) missing = true;
    return value ?? "";
  });
  return missing ? null : filled;
}

export function toolLabel(
  name: string,
  args: unknown,
  templates?: ToolLabelTemplates
): string {
  if (isBuiltinTool(name)) return fallbackToolLabel(name, args);
  const template = templates?.[name];
  const filled = template ? fillToolLabelTemplate(template, args) : null;
  return filled ?? fallbackToolLabel(name, args);
}
