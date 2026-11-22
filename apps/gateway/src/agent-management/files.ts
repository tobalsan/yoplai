import fs from "node:fs/promises";
import path from "node:path";
import { AgentYamlConfigSchema, ThinkLevelSchema } from "@yoplai/shared";
import { parseDocument } from "yaml";
import { z } from "zod";
import { writeFileAtomic } from "../util/atomic-write.js";

export const OWNER_FILE = ".created-by.json";
export const INSTRUCTIONS_FILE = "AGENTS.md";

export const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(280).optional(),
  role: z.string().trim().max(60).optional(),
  avatar: z.number().int().min(1).max(10).optional(),
  model: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict().optional(),
  reasoning: ThinkLevelSchema.nullable().optional(),
  instructions: z.string().max(100_000).optional(),
  skills: z.object({ disabled: z.array(z.string().min(1)).max(500) }).strict().optional(),
}).strict();
export type AgentPatch = z.infer<typeof patchSchema>;

export async function readOwner(workspace: string): Promise<string | undefined> {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(workspace, OWNER_FILE), "utf8")) as { userId?: unknown };
    return typeof owner.userId === "string" ? owner.userId : undefined;
  } catch {
    return undefined;
  }
}

export async function readInstructions(workspace: string): Promise<string> {
  return fs.readFile(path.join(workspace, INSTRUCTIONS_FILE), "utf8").catch(() => "");
}

/** Set a key, or remove it when the value is empty. */
function setOrDelete(doc: ReturnType<typeof parseDocument>, key: string, value: string | undefined) {
  if (value === undefined) return;
  if (value === "") doc.delete(key);
  else doc.set(key, value);
}

/**
 * Apply a patch to agent.yaml under a lock. The YAML document keeps comments and unrelated keys.
 * The result must still pass the agent schema before anything is written.
 */
export async function applyPatch(workspace: string, patch: AgentPatch, avatarFile?: { name: string; source: string }): Promise<void> {
  // Imported lazily so proper-lockfile's signal handlers do not shadow the gateway shutdown handler.
  const { default: lockfile } = await import("proper-lockfile");
  const release = await lockfile.lock(workspace, { retries: { retries: 5, minTimeout: 20, maxTimeout: 100 }, realpath: false });
  try {
    const agentPath = path.join(workspace, "agent.yaml");
    const doc = parseDocument(await fs.readFile(agentPath, "utf8"));
    setOrDelete(doc, "name", patch.name);
    setOrDelete(doc, "description", patch.description);
    setOrDelete(doc, "role", patch.role);
    if (patch.model) {
      doc.setIn(["model", "provider"], patch.model.provider);
      doc.setIn(["model", "model"], patch.model.model);
    }
    if (patch.reasoning !== undefined) {
      if (patch.reasoning === null) doc.delete("reasoning");
      else doc.set("reasoning", patch.reasoning);
    }
    if (patch.skills) {
      if (patch.skills.disabled.length === 0) doc.delete("skills");
      else doc.setIn(["skills", "disabled"], patch.skills.disabled);
    }
    if (avatarFile) doc.set("avatar", avatarFile.name);
    const validation = AgentYamlConfigSchema.safeParse(doc.toJS());
    if (!validation.success) throw new Error(`agent.yaml would be invalid after update: ${validation.error.message}`);
    if (avatarFile) await fs.copyFile(avatarFile.source, path.join(workspace, avatarFile.name));
    if (patch.instructions !== undefined) await writeFileAtomic(path.join(workspace, INSTRUCTIONS_FILE), patch.instructions);
    await writeFileAtomic(agentPath, doc.toString());
  } finally {
    await release();
  }
}
