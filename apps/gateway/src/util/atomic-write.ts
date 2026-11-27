import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Writes via a sibling temp file then rename; a failed write leaves the
// previous file intact and no temp file behind.
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  mode?: number,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, data, { mode });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function writeJsonAtomic(file: string, value: unknown, mode?: number): Promise<void> {
  return writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}
