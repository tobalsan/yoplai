import type { FileAttachment } from "@yoplai/shared";
import type { MattermostFileInfo, MattermostRestClient } from "../client.js";

export const MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function extensionOf(file: MattermostFileInfo): string {
  return (file.extension || file.name.split(".").pop() || "").toLowerCase();
}

/** The MIME type to hand the agent, or undefined when the type is not supported. */
export function supportedMimeType(
  file: MattermostFileInfo
): string | undefined {
  return MIME_BY_EXTENSION[extensionOf(file)];
}

/**
 * Download the files of an inbound post and store them as agent attachments.
 * Unsupported, oversized or failed files are reported back as short notes
 * instead of failing the turn.
 */
export async function collectMattermostAttachments(
  files: MattermostFileInfo[],
  rest: Pick<MattermostRestClient, "downloadFile">,
  saveMediaFile: (
    data: Uint8Array,
    mimeType: string,
    filename?: string
  ) => Promise<FileAttachment>
): Promise<{ attachments: FileAttachment[]; errors: string[] }> {
  const attachments: FileAttachment[] = [];
  const errors: string[] = [];
  for (const file of files) {
    if (file.size && file.size > MAX_UPLOAD_SIZE_BYTES) {
      errors.push(
        `Could not process ${file.name}: File exceeds the 25MB upload limit`
      );
      continue;
    }
    const mimeType = supportedMimeType(file);
    if (!mimeType) {
      errors.push(
        `Could not process ${file.name}: Unsupported file type ${file.mime_type || extensionOf(file) || "unknown"}`
      );
      continue;
    }
    try {
      const data = await rest.downloadFile(file.id);
      if (data.byteLength > MAX_UPLOAD_SIZE_BYTES) {
        throw new Error("File exceeds the 25MB upload limit");
      }
      attachments.push(await saveMediaFile(data, mimeType, file.name));
    } catch (error) {
      errors.push(
        `Could not process ${file.name}: ${error instanceof Error ? error.message : "Download failed"}`
      );
    }
  }
  return { attachments, errors };
}
