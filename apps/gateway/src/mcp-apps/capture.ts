import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAgentToolContext, McpToolMetadata, McpAppViewReference, McpAppView, McpAppFile } from "@yoplai/shared";
import { getUserHistoryDir } from "@yoplai/extension-multi-user/isolation";
import { CONFIG_DIR } from "../config/index.js";
import { logWarn } from "../logging.js";

export type McpAppRecord = {
  recordId: string;
  agentId: string;
  sessionId: string;
  ownerUserId: string | null;
  toolCallId: string;
  server: string;
  tool: string;
  resourceUri: string;
  args: unknown;
  result: Record<string, unknown>;
  createdAt: number;
};

type RecordScope = { agentId: string; sessionId: string; ownerUserId?: string | null };
type CaptureIdentity = { agentId: string; sessionId: string; userId?: string; sessionOwnerId?: string | null };
type CaptureContext = CaptureIdentity & { toolCallId?: string; signal?: AbortSignal };
export const yoplaiFileView: McpAppView = { server: "yoplai", tool: "send_file", resourceUri: "ui://yoplai/file-viewer" };
export const yoplaiPreviewView: McpAppView = { server: "yoplai", tool: "web_preview", resourceUri: "ui://yoplai/web-preview" };
type ViewExtras = Pick<McpAppViewReference, "file" | "key" | "preview">;
const referenceLifetime = 15 * 60 * 1000;
const references = new Map<string, { scope: string; view: McpAppViewReference; createdAt: number }>();
const recordFiles = new Map<string, Map<string, string>>();
const warnedReservedServers = new Set<string>();

function identityScope(identity: CaptureIdentity): string {
  return JSON.stringify([identity.agentId, identity.sessionId, identity.sessionOwnerId === undefined ? identity.userId ?? null : identity.sessionOwnerId]);
}

const sweep = setInterval(() => {
  for (const [key, entry] of references) {
    if (entry.createdAt <= Date.now() - referenceLifetime) references.delete(key);
  }
}, 60_000);
sweep.unref();

export function getMcpAppView(identity: CaptureIdentity, toolCallId: string): McpAppViewReference | undefined {
  const key = `${identityScope(identity)}:${toolCallId}`;
  const entry = references.get(key);
  if (entry && entry.createdAt > Date.now() - referenceLifetime) return entry.view;
  references.delete(key);
}

export function clearMcpAppViews(identity: CaptureIdentity): void {
  const scope = identityScope(identity);
  for (const [key, entry] of references) {
    if (entry.scope === scope) references.delete(key);
  }
}

function recordDirectory(scope: RecordScope): string | undefined {
  if (![scope.agentId, scope.sessionId, ...(scope.ownerUserId ? [scope.ownerUserId] : [])]
    .every(part => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(part))) return;
  return path.join(getUserHistoryDir(scope.ownerUserId ?? undefined, CONFIG_DIR), "mcp-apps", scope.agentId, scope.sessionId);
}

export async function readMcpAppRecord(scope: RecordScope, toolCallId: string): Promise<McpAppRecord | undefined> {
  const dir = recordDirectory(scope);
  if (!dir) return;
  const files = recordFiles.get(dir) ?? new Map<string, string>();
  recordFiles.set(dir, files);
  const read = async (name: string): Promise<McpAppRecord | undefined> => {
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as McpAppRecord;
      if (record.recordId === name.slice(0, -5) && record.agentId === scope.agentId &&
        record.sessionId === scope.sessionId && record.ownerUserId === (scope.ownerUserId ?? null) &&
        typeof record.toolCallId === "string" && typeof record.server === "string" &&
        typeof record.tool === "string" && typeof record.resourceUri === "string" &&
        record.result && Array.isArray(record.result.content)) return record;
    } catch { /* An incomplete or unreadable record cannot authorize a view. */ }
  };
  const cached = files.get(toolCallId);
  if (cached) {
    const record = await read(cached);
    if (record?.toolCallId === toolCallId) return record;
    files.delete(toolCallId);
  }
  const names = await fs.readdir(dir).catch(() => []);
  for (const name of names) {
    if (!/^[a-f0-9]{32,128}\.json$/.test(name)) continue;
    const record = await read(name);
    if (!record) continue;
    files.set(record.toolCallId, name);
    if (record.toolCallId === toolCallId) return record;
  }
}

export async function deleteMcpAppRecords(scope: RecordScope): Promise<void> {
  const dir = recordDirectory(scope);
  if (!dir) return;
  clearMcpAppViews({ agentId: scope.agentId, sessionId: scope.sessionId, sessionOwnerId: scope.ownerUserId ?? null });
  recordFiles.delete(dir);
  await fs.rm(dir, { recursive: true, force: true });
}

export async function captureMcpApp(
  mcp: McpToolMetadata | undefined,
  context: ExtensionAgentToolContext,
  args: unknown,
  result: unknown
): Promise<void> {
  if (mcp?.server === "yoplai") {
    if (mcp.tool === yoplaiPreviewView.tool && mcp.ui?.resourceUri === yoplaiPreviewView.resourceUri) return;
    if (!warnedReservedServers.has(mcp.server)) {
      warnedReservedServers.add(mcp.server);
      logWarn("[mcp-apps] external app server name is reserved", { server: mcp.server, outcome: "reserved_server" });
    }
    return;
  }
  if (!mcp?.ui?.resourceUri || !context.sessionId || !context.toolCallId || context.signal?.aborted ||
    !result || typeof result !== "object" || Array.isArray(result) ||
    !("content" in result) || !Array.isArray(result.content)) return;
  await captureYoplaiView({ ...context, agentId: context.agent.id, sessionId: context.sessionId },
    { server: mcp.server, tool: mcp.tool, resourceUri: mcp.ui.resourceUri }, args, result as Record<string, unknown>);
}

export async function captureSendFile(context: CaptureContext, args: unknown, file: McpAppFile): Promise<void> {
  await captureYoplaiView(context, yoplaiFileView, args, {
    content: [{ type: "text", text: "File sent to user" }],
    structuredContent: { uri: `yoplai-file://${file.fileId}`, ...file },
  }, { file });
}

export async function captureYoplaiView(context: CaptureContext, view: McpAppView, args: unknown, result: Record<string, unknown>, extras: ViewExtras = {}): Promise<void> {
  if (!context.sessionId || !context.toolCallId || context.signal?.aborted) return;
  const ownerUserId = context.sessionOwnerId === undefined ? context.userId ?? null : context.sessionOwnerId;
  const record: McpAppRecord = {
    recordId: randomBytes(24).toString("hex"), agentId: context.agentId,
    sessionId: context.sessionId, ownerUserId, toolCallId: context.toolCallId,
    ...view, args, result, createdAt: Date.now(),
  };
  const dir = recordDirectory(record);
  if (!dir) return;
  const target = path.join(dir, `${record.recordId}.json`);
  const temporary = `${target}.tmp`;
  try {
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, "utf8") > 5 * 1024 * 1024) {
      logWarn("[mcp-apps] capture unavailable", { agentId: record.agentId, sessionId: record.sessionId, toolCallId: record.toolCallId, outcome: "too_large" });
      return;
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(temporary, serialized, { mode: 0o600 });
    await fs.rename(temporary, target);
    if (context.signal?.aborted) {
      await fs.rm(target, { force: true });
      return;
    }
    const files = recordFiles.get(dir) ?? new Map<string, string>();
    files.set(record.toolCallId, `${record.recordId}.json`);
    recordFiles.set(dir, files);
    const scope = identityScope({ agentId: record.agentId, sessionId: record.sessionId, sessionOwnerId: ownerUserId });
    references.set(`${scope}:${record.toolCallId}`, { scope, createdAt: record.createdAt, view: {
      recordId: record.recordId, server: record.server, tool: record.tool, resourceUri: record.resourceUri,
      ...extras,
    } });
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => {});
    logWarn("[mcp-apps] capture unavailable", { agentId: record.agentId, sessionId: record.sessionId, toolCallId: record.toolCallId, outcome: "write_failed" });
  }
}
