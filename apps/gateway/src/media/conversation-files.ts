import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveHomeDir, type ExtensionAgentToolContext } from "@yoplai/shared";

export const CONTAINER_FILES_DIR = "/workspace/files";

export function getConversationFiles(
  agentId: string,
  sessionId: string,
  userId?: string,
  container = false,
  homeDir = resolveHomeDir()
): NonNullable<ExtensionAgentToolContext["conversationFiles"]> {
  const key = createHash("sha256")
    .update(JSON.stringify([agentId, userId ?? null, sessionId]))
    .digest("hex");
  const hostPath = path.join(homeDir, "conversation-files", key);
  fs.mkdirSync(hostPath, { recursive: true, mode: 0o700 });
  return { hostPath, runtimePath: container ? CONTAINER_FILES_DIR : hostPath };
}
