import fs from "node:fs/promises";
import path from "node:path";
import type { FileAttachment } from "@yoplai/shared";
import { extractText, PDF_OCR_LIMITS } from "../media/extract.js";
import { getMediaInboundDir } from "../media/metadata.js";
import { logWarn } from "../logging.js";

// Longer extracted text is not pasted into the prompt: a multi-MB file
// overflows the model context and breaks the chat for good.
const MAX_INLINE_ATTACHMENT_CHARS = PDF_OCR_LIMITS.outputChars;

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
  attachments: FileAttachment[] | undefined,
  options?: { includeUnextractedPath?: boolean }
): Promise<string> {
  const documents = (attachments ?? []).filter(
    (attachment) => !isImageAttachment(attachment)
  );
  if (documents.length === 0) return "";

  const blocks: string[] = [];
  for (const attachment of documents) {
    let text: string | null;
    let validatedPath: string | undefined;
    try {
      const normalized = await normalizeInboundAttachment(attachment);
      text = await extractText(normalized.path, attachment.mimeType);
      validatedPath = normalized.path;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn("Failed to extract attachment text", {
        filename: getAttachmentFilename(attachment),
        error: message,
      });
      text = null;
    }
    const trimmed = text?.trim();
    const tooLong = !!trimmed && trimmed.length > MAX_INLINE_ATTACHMENT_CHARS;
    const content = tooLong ? undefined : trimmed;
    blocks.push(
      [
        `File: ${getAttachmentFilename(attachment)}`,
        `MIME type: ${attachment.mimeType}`,
        !content && options?.includeUnextractedPath && validatedPath
          ? `Path: ${validatedPath}`
          : "",
        tooLong
          ? `Content: not inlined: ${trimmed.length.toLocaleString("en-US")} characters, over the ${MAX_INLINE_ATTACHMENT_CHARS.toLocaleString("en-US")}-character limit; read the file at its path with bash/python.`
          : content
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
