import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function getBuiltInSkillsDir(): string {
  return fileURLToPath(new URL("../../skills", import.meta.url));
}

export async function createManagedSkillsStaging(skills: readonly { name: string; directory: string }[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-run-skills-"));
  const cleanup = () => fs.rm(directory, { recursive: true, force: true });
  try {
    for (const skill of skills) await fs.symlink(skill.directory, path.join(directory, skill.name), "dir");
    return { directory, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
