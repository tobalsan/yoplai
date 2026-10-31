import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizeForStorage, sanitizeSensitiveText } from "../sanitize.js";

/**
 * Pi replays system-message tool declarations (`toolsAdded`/`toolsRemoved`),
 * including the system message captured by a compaction entry, as
 * the provider tool list, so they must stay verbatim: redacting schema keys
 * such as `assignee` (matches `sig`) makes the provider reject the tool schema.
 * They are model-facing declarations, not credentials.
 */
function sanitizeSessionEntry(entry: unknown): unknown {
  const sanitized = sanitizeForStorage(entry);
  if (!isRecord(entry) || !isRecord(sanitized)) return sanitized;
  const holder =
    entry.type === "message"
      ? "message"
      : entry.type === "compaction"
        ? "systemMessage"
        : undefined;
  if (!holder) return sanitized;
  const message = entry[holder];
  const sanitizedMessage = sanitized[holder];
  if (!isRecord(message) || !isRecord(sanitizedMessage)) {
    return sanitized;
  }
  if (message.role === "system") {
    for (const key of ["toolsAdded", "toolsRemoved"] as const) {
      if (key in message) sanitizedMessage[key] = message[key];
    }
  }
  // OpenAI Responses text signatures carry replay item IDs and phases, not
  // credentials. Preserve only the SDK's assistant text-block metadata.
  if (
    entry.type === "message" &&
    message.role === "assistant" &&
    Array.isArray(message.content) &&
    Array.isArray(sanitizedMessage.content)
  ) {
    for (const [index, block] of message.content.entries()) {
      const sanitizedBlock = sanitizedMessage.content[index];
      if (
        isRecord(block) &&
        block.type === "text" &&
        typeof block.textSignature === "string" &&
        isRecord(sanitizedBlock)
      ) {
        sanitizedBlock.textSignature = block.textSignature;
      }
    }
  }
  return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
        return JSON.stringify(sanitizeSessionEntry(JSON.parse(line)));
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
