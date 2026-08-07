import fs from "node:fs/promises";
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
