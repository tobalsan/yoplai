import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ensureMediaDirectories,
  getMediaInboundDir,
  MEDIA_INBOUND_DIR,
  registerMediaFile,
} from "./metadata.js";

export { MEDIA_INBOUND_DIR };

export const MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;

// Allowed MIME types for upload
const ALLOWED_MIME_TYPES = new Set([
  // Images
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // Documents
  "application/pdf",
  "text/markdown",
  "text/plain",
  "text/csv",
  // Office formats
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.ms-excel", // .xls
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
]);

const MIME_TO_EXTENSIONS: Record<string, string[]> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "image/svg+xml": ["svg"],
  "application/pdf": ["pdf"],
  "text/markdown": ["md", "markdown"],
  "text/plain": ["txt"],
  "text/csv": ["csv"],
  "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    "docx",
  ],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
};

const EXTENSION_TO_MIME_TYPES: Record<string, string[]> = {
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  svg: ["image/svg+xml"],
  pdf: ["application/pdf"],
  txt: ["text/plain"],
  md: ["text/markdown", "text/plain"],
  csv: ["text/csv", "text/plain", "application/vnd.ms-excel"],
  doc: ["application/msword"],
  docx: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  xls: ["application/vnd.ms-excel"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
};

const ALLOWED_EXTENSIONS = new Set(Object.keys(EXTENSION_TO_MIME_TYPES));

export interface UploadResult {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface UploadError {
  error: string;
}

export class UploadTooLargeError extends Error {
  constructor(size: number) {
    super(
      `File size ${size} bytes exceeds the ${MAX_UPLOAD_SIZE_BYTES} byte limit`
    );
    this.name = "UploadTooLargeError";
  }
}

export class UploadTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadTypeError";
  }
}

/**
 * Check if a MIME type is allowed for upload
 */
export function isAllowedMimeType(mimeType: string): boolean {
  return ALLOWED_MIME_TYPES.has(mimeType);
}

function getExtension(originalFilename?: string): string | null {
  if (!originalFilename) return null;
  const ext = path.extname(originalFilename).slice(1).toLowerCase();
  return ext || null;
}

export function resolveUploadMimeType(
  mimeType: string | undefined,
  originalFilename?: string
): string {
  const ext = getExtension(originalFilename);
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    throw new UploadTypeError(
      `Unsupported file extension: ${ext ? `.${ext}` : "(none)"}`
    );
  }

  const allowedForExtension = EXTENSION_TO_MIME_TYPES[ext] ?? [];
  const normalizedMimeType = (mimeType ?? "").toLowerCase();

  if (
    !normalizedMimeType ||
    normalizedMimeType === "application/octet-stream"
  ) {
    return allowedForExtension[0] ?? "application/octet-stream";
  }

  if (!isAllowedMimeType(normalizedMimeType)) {
    throw new UploadTypeError(`Unsupported file type: ${normalizedMimeType}`);
  }

  if (!allowedForExtension.includes(normalizedMimeType)) {
    throw new UploadTypeError(
      `File extension .${ext} does not match MIME type ${normalizedMimeType}`
    );
  }

  return normalizedMimeType;
}

/**
 * Get file extension from MIME type
 */
function getExtensionFromMime(
  mimeType: string,
  originalFilename?: string
): string {
  const allowedExtensions = MIME_TO_EXTENSIONS[mimeType] ?? [];

  if (originalFilename) {
    const ext = getExtension(originalFilename);
    if (ext && allowedExtensions.includes(ext)) return ext;
  }

  return allowedExtensions[0] ?? "bin";
}

function sanitizeFilename(
  filename: string | undefined,
  fallback: string
): string {
  if (!filename) return fallback;

  const cleaned = filename
    .replace(/\0/g, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1);

  return cleaned || fallback;
}

/**
 * Save uploaded file to disk
 */
export async function saveUploadedFile(
  data: ArrayBuffer | Buffer,
  mimeType: string,
  originalFilename?: string,
  binding?: { agentId?: string; sessionId?: string }
): Promise<UploadResult> {
  const resolvedMimeType = resolveUploadMimeType(mimeType, originalFilename);
  const originalExt = getExtension(originalFilename);
  const ext =
    originalExt && ALLOWED_EXTENSIONS.has(originalExt)
      ? originalExt
      : getExtensionFromMime(resolvedMimeType, originalFilename);
  const fileId = randomUUID();
  const filename = `${fileId}.${ext}`;
  const filepath = path.join(getMediaInboundDir(), filename);

  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length > MAX_UPLOAD_SIZE_BYTES) {
    throw new UploadTooLargeError(buffer.length);
  }

  await ensureMediaDirectories();
  await fs.writeFile(filepath, buffer);
  await registerMediaFile({
    direction: "inbound",
    fileId,
    filename: sanitizeFilename(originalFilename, filename),
    storedFilename: filename,
    path: filepath,
    mimeType: resolvedMimeType,
    size: buffer.length,
    agentId: binding?.agentId,
    sessionId: binding?.sessionId,
  });

  return {
    path: filepath,
    filename,
    mimeType: resolvedMimeType,
    size: buffer.length,
  };
}

/**
 * List allowed MIME types (for documentation/validation)
 */
export function getAllowedMimeTypes(): string[] {
  return Array.from(ALLOWED_MIME_TYPES);
}
