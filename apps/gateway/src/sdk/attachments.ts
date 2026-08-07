import fs from "node:fs/promises";
import path from "node:path";
import type { FileAttachment } from "@yoplai/shared";
import { extractText } from "../media/extract.js";
import { getMediaInboundDir } from "../media/metadata.js";
import { logWarn } from "../logging.js";

export function isImageAttachment(attachment: FileAttachment): boolean {
  return attachment.mimeType.startsWith("image/");
}

export function getAttachmentFilename(attachment: FileAttachment): string {
  return attachment.filename ?? path.basename(attachment.path);
}

function ensurePathWithinDir(filePath: string, dir: string): void {
  const relative = path.relative(dir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Attachment path is outside inbound media directory");
  }
}

export async function normalizeInboundAttachment(
  attachment: FileAttachment
): Promise<FileAttachment> {
  const [realInboundDir, realPath] = await Promise.all([
    fs.realpath(getMediaInboundDir()),
    fs.realpath(attachment.path),
  ]);
  ensurePathWithinDir(realPath, realInboundDir);
  return { ...attachment, path: realPath };
}

export async function normalizeInboundAttachments(
  attachments: FileAttachment[] | undefined
): Promise<FileAttachment[] | undefined> {
  if (!attachments?.length) return attachments;
  return Promise.all(attachments.map(normalizeInboundAttachment));
}

export async function readInboundAttachment(
  attachment: FileAttachment
): Promise<Buffer> {
  const normalized = await normalizeInboundAttachment(attachment);
  return fs.readFile(normalized.path);
}

export async function buildDocumentAttachmentContext(
  attachments: FileAttachment[] | undefined
): Promise<string> {
  const documents = (attachments ?? []).filter(
    (attachment) => !isImageAttachment(attachment)
  );
  if (documents.length === 0) return "";

  const blocks: string[] = [];
  for (const attachment of documents) {
    let text: string | null;
    try {
      const normalized = await normalizeInboundAttachment(attachment);
      text = await extractText(normalized.path, attachment.mimeType);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn("Failed to extract attachment text", {
        filename: getAttachmentFilename(attachment),
        error: message,
      });
      text = null;
    }
    const content = text?.trim();
    blocks.push(
      [
        `File: ${getAttachmentFilename(attachment)}`,
        `MIME type: ${attachment.mimeType}`,
        content
          ? ""
          : "Content: not extracted; inspect the attached file path if available.",
        content ?? "",
      ]
        .filter((line) => line !== "")
        .join("\n")
    );
  }

  if (blocks.length === 0) return "";
  return `Attached document text:\n\n${blocks.join("\n\n---\n\n")}`;
}

export function appendAttachmentContext(
  message: string,
  attachmentContext: string
): string {
  if (!attachmentContext) return message;
  return `${message}\n\n${attachmentContext}`;
}
