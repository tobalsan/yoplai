import type { FileAttachment } from "@yoplai/shared";

export const MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export type DiscordAttachment = { filename: string; url: string; size?: number; content_type?: string | null };

function extension(filename: string): string { return filename.toLowerCase().split(".").pop() ?? ""; }

export function isSupportedDiscordAttachment(file: DiscordAttachment): boolean {
  const expected = MIME_BY_EXTENSION[extension(file.filename)];
  return Boolean(expected && (!file.content_type || file.content_type.toLowerCase() === expected));
}

export async function collectDiscordAttachments(
  files: DiscordAttachment[],
  saveMediaFile: (data: Uint8Array, mimeType: string, filename?: string) => Promise<FileAttachment>
): Promise<{ attachments: FileAttachment[]; errors: string[] }> {
  const attachments: FileAttachment[] = [];
  const errors: string[] = [];
  for (const file of files) {
    if (file.size && file.size > MAX_UPLOAD_SIZE_BYTES) { errors.push(`Could not process ${file.filename}: File exceeds the 25MB upload limit`); continue; }
    if (!isSupportedDiscordAttachment(file)) { errors.push(`Could not process ${file.filename}: Unsupported file type ${file.content_type ?? "unknown"}`); continue; }
    try {
      const response = await fetch(file.url);
      if (!response.ok) throw new Error(`Download failed with ${response.status}`);
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.byteLength > MAX_UPLOAD_SIZE_BYTES) throw new Error("File exceeds the 25MB upload limit");
      attachments.push(await saveMediaFile(data, file.content_type ?? MIME_BY_EXTENSION[extension(file.filename)]!, file.filename));
    } catch (error) { errors.push(`Could not process ${file.filename}: ${error instanceof Error ? error.message : "Download failed"}`); }
  }
  return { attachments, errors };
}
