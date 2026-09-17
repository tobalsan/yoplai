import fs from "node:fs/promises";
import path from "node:path";
import type { McpServerConfig } from "./catalog.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge one server into the agent-owned mcp.json without replacing peers. */
export async function mergeMcpServerConfig(
  workspaceDir: string,
  name: string,
  server: McpServerConfig
): Promise<void> {
  const filePath = path.join(workspaceDir, "mcp.json");
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("mcp.json must contain an object");
    current = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const mcpServers = isRecord(current.mcpServers)
    ? { ...current.mcpServers }
    : {};
  mcpServers[name] = server;
  const next = { ...current, mcpServers };
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  await fs.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}
