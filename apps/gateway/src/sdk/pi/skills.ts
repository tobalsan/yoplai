import { fileURLToPath } from "node:url";

export function getBuiltInSkillsDir(): string {
  return fileURLToPath(new URL("../../skills", import.meta.url));
}
