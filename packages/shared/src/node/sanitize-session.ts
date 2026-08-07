import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizeForStorage, sanitizeSensitiveText } from "../sanitize.js";

/** Redacts a Pi SDK JSONL session after its authorized runtime use completes. */
export async function sanitizeSessionFile(file: string): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const sanitized = content
    .split("\n")
    .map((line) => {
      if (!line) return line;
      try {
        return JSON.stringify(sanitizeForStorage(JSON.parse(line)));
      } catch {
        return sanitizeSensitiveText(line);
      }
    })
    .join("\n");
  if (sanitized !== content) await fs.writeFile(file, sanitized, "utf8");
}

/** Uses an ephemeral Pi session file and publishes only its sanitized form. */
export async function createRuntimeSessionFile(
  persistentFile: string
): Promise<{ file: string; persist: () => Promise<void> }> {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-pi-"));
  const file = path.join(runtimeDir, path.basename(persistentFile));
  try {
    await fs.copyFile(persistentFile, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.writeFile(file, "");
  }

  let persisted = false;
  return {
    file,
    async persist() {
      if (persisted) return;
      persisted = true;
      try {
        await sanitizeSessionFile(file);
        await fs.mkdir(path.dirname(persistentFile), { recursive: true });
        await fs.copyFile(file, persistentFile);
      } finally {
        await fs.rm(runtimeDir, { recursive: true, force: true });
      }
    },
  };
}
