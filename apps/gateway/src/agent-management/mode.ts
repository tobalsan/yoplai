import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CONFIG_DIR, loadConfig } from "../config/index.js";
import { effectiveAgentManagement, type AgentManagementMode } from "./policy.js";

export const agentManagementModeBody = z.object({
  mode: z.enum(["off", "superadmin", "admin", "anyone"]),
}).strict();

const modeFile = path.join(CONFIG_DIR, "agent-management.json");

function readStoredMode(): AgentManagementMode | undefined {
  try {
    return agentManagementModeBody.safeParse(JSON.parse(fs.readFileSync(modeFile, "utf8"))).data?.mode;
  } catch {
    return undefined;
  }
}

export function readAgentManagementMode() {
  const config = loadConfig().agentManagement;
  return effectiveAgentManagement(config, config === undefined ? readStoredMode() : undefined);
}

export function writeAgentManagementMode(mode: AgentManagementMode): void {
  const temp = `${modeFile}.${randomUUID()}.tmp`;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ mode })}\n`, { mode: 0o600 });
    fs.renameSync(temp, modeFile);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
