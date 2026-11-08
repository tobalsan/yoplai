import { EXTENSION_TO_MIME_TYPES } from "@yoplai/shared/media-types";
import type { FileAttachment, FileBlock } from "../api/types";

export const MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;

const SUPPORTED_FILE_TYPES = new Set(Object.values(EXTENSION_TO_MIME_TYPES).flat());
const ACCEPTED_FILE_TYPES = Array.from(SUPPORTED_FILE_TYPES).join(",");
const SUPPORTED_FILE_EXTENSIONS = new Set(Object.keys(EXTENSION_TO_MIME_TYPES));

export const FILE_INPUT_ACCEPT = [
  ACCEPTED_FILE_TYPES,
  ...Array.from(SUPPORTED_FILE_EXTENSIONS, (ext) => `.${ext}`),
].join(",");

export type PendingFile = {
  id: string;
  file: File;
  name: string;
  mimeType: string;
  size: number;
  previewUrl?: string;
};

export function isSupportedFile(file: File): boolean {
  if (SUPPORTED_FILE_TYPES.has(file.type)) return true;
  const ext = file.name.toLowerCase().split(".").pop();
  return ext ? SUPPORTED_FILE_EXTENSIONS.has(ext) : false;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

export function createPendingFile(file: File): PendingFile {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    file,
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    previewUrl: isImageFile(file) ? URL.createObjectURL(file) : undefined,
  };
}

export function revokePendingFile(item: PendingFile): void {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
}

export function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

export function getFileIcon(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "IMG";
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.includes("word")) return "DOC";
  if (mimeType.includes("excel") || mimeType.includes("spreadsheet"))
    return "XLS";
  if (mimeType === "text/csv") return "CSV";
  if (mimeType === "text/markdown") return "MD";
  if (mimeType === "text/html") return "HTML";
  return "FILE";
}

export function classifyFile(file: { filename: string; mimeType: string }): "html" | "markdown" | "pdf" | "image" | "svg" | "text" | "other" {
  let mime = file.mimeType?.split(";")[0].trim().toLowerCase();
  if (!mime || mime === "application/octet-stream") {
    const ext = file.filename.split(".").at(-1)?.toLowerCase() ?? "";
    const types: Record<string, string> = { pdf: "application/pdf", html: "text/html", htm: "text/html", md: "text/markdown", markdown: "text/markdown", json: "application/json", csv: "text/csv", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
    mime = types[ext] || (/^(txt|log|[cm]?[jt]sx?|py|rb|sh|bash|css|xml|ya?ml|toml|sql|rs|go|java|c|cpp|h)$/.test(ext) ? "text/plain" : "application/octet-stream");
  }
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "text/markdown") return "markdown";
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/svg+xml") return "svg";
  if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) return "image";
  if (mime.startsWith("text/") || /^(application\/(json|javascript|x-javascript|xml|yaml|x-yaml|sql|toml|x-sh|typescript))$/.test(mime) || /\+(json|xml)$/.test(mime)) return "text";
  return "other";
}

function getAttachmentFileId(attachment: FileAttachment): string {
  const name = attachment.path.split(/[\\/]/).pop() ?? attachment.path;
  return name.replace(/\.[^.]+$/, "");
}

export function attachmentToFileBlock(
  attachment: FileAttachment,
  pending?: PendingFile
): FileBlock {
  return {
    type: "file",
    fileId: getAttachmentFileId(attachment),
    filename:
      pending?.name ??
      attachment.filename ??
      attachment.path.split(/[\\/]/).pop() ??
      "file",
    mimeType: pending?.mimeType || attachment.mimeType,
    size: pending?.size ?? 0,
    direction: "inbound",
  };
}
