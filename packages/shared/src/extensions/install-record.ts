import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const extensionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const extensionDigestSchema = z.string().regex(/^[a-fA-F0-9]{64}$/);

const installRecordSchema = z.object({
  id: extensionIdSchema,
  version: z.string().min(1),
  sha256: extensionDigestSchema.transform((value) => value.toLowerCase()),
  url: z.string().url(),
  release: z.string().min(1),
  installedAt: z.string().datetime(),
  installedBy: z.string().min(1),
});

export type InstallRecord = z.infer<typeof installRecordSchema>;

export async function readInstallRecord(directory: string): Promise<InstallRecord | undefined> {
  try {
    const record = installRecordSchema.safeParse(
      JSON.parse(await readFile(path.join(directory, ".install.json"), "utf8"))
    );
    if (record.success && record.data.id === path.basename(directory)) return record.data;
  } catch {
    return undefined;
  }
}
