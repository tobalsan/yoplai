import { realpathSync } from "node:fs";
import path from "node:path";

function contains(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function realPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

export function filterDisabledWorkspaceSkills<T extends { name: string; filePath: string }>(
  skills: T[],
  directory: string,
  disabled?: readonly string[],
): T[] {
  if (!disabled?.length) return skills;
  const names = new Set(disabled);
  const realDirectory = realPath(directory);
  return skills.filter(({ name, filePath }) => !names.has(name) ||
    (!contains(directory, filePath) && !contains(realDirectory, realPath(filePath))));
}
