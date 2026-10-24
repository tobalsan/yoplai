import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAgentToolContext, McpToolMetadata, McpAppViewReference } from "@yoplai/shared";
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
const referenceLifetime = 15 * 60 * 1000;
const references = new Map<string, { scope: string; view: McpAppViewReference; createdAt: number }>();

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
  const names = await fs.readdir(dir).catch(() => []);
  for (const name of names) {
    if (!/^[a-f0-9]{32,128}\.json$/.test(name)) continue;
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as McpAppRecord;
      if (record.recordId === name.slice(0, -5) && record.agentId === scope.agentId &&
        record.sessionId === scope.sessionId && record.ownerUserId === (scope.ownerUserId ?? null) &&
        record.toolCallId === toolCallId && typeof record.server === "string" &&
        typeof record.tool === "string" && typeof record.resourceUri === "string" &&
        record.result && Array.isArray(record.result.content)) return record;
    } catch { /* An incomplete or unreadable record cannot authorize a view. */ }
  }
}

export async function deleteMcpAppRecords(scope: RecordScope): Promise<void> {
  const dir = recordDirectory(scope);
  if (!dir) return;
  clearMcpAppViews({ agentId: scope.agentId, sessionId: scope.sessionId, sessionOwnerId: scope.ownerUserId ?? null });
  await fs.rm(dir, { recursive: true, force: true });
}

export async function captureMcpApp(
  mcp: McpToolMetadata | undefined,
  context: ExtensionAgentToolContext,
  args: unknown,
  result: unknown
): Promise<void> {
  if (!mcp?.ui?.resourceUri || !context.sessionId || !context.toolCallId || context.signal?.aborted ||
    !result || typeof result !== "object" || Array.isArray(result) ||
    !("content" in result) || !Array.isArray(result.content)) return;
  const ownerUserId = context.sessionOwnerId === undefined ? context.userId ?? null : context.sessionOwnerId;
  const record: McpAppRecord = {
    recordId: randomBytes(24).toString("hex"), agentId: context.agent.id,
    sessionId: context.sessionId, ownerUserId, toolCallId: context.toolCallId,
    server: mcp.server, tool: mcp.tool, resourceUri: mcp.ui.resourceUri,
    args, result: result as Record<string, unknown>, createdAt: Date.now(),
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
    const scope = identityScope({ agentId: record.agentId, sessionId: record.sessionId, sessionOwnerId: ownerUserId });
    references.set(`${scope}:${record.toolCallId}`, { scope, createdAt: record.createdAt, view: {
      recordId: record.recordId, server: record.server, tool: record.tool, resourceUri: record.resourceUri,
    } });
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => {});
    logWarn("[mcp-apps] capture unavailable", { agentId: record.agentId, sessionId: record.sessionId, toolCallId: record.toolCallId, outcome: "write_failed" });
  }
}
