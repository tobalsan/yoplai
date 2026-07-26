import type { FileAttachment } from "@yoplai/shared";

/**
 * Telegram's Bot API caps file downloads at 20MB. Anything larger cannot be
 * fetched via getFile, so we reject it up front rather than letting the
 * download fail mid-flight.
 */
export const MAX_UPLOAD_SIZE_BYTES = 20 * 1024 * 1024;

const MIME_TYPES_BY_EXTENSION = new Map<string, string>([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["pdf", "application/pdf"],
  ["txt", "text/plain"],
  ["log", "text/plain"],
  ["csv", "text/csv"],
  ["json", "application/json"],
  ["md", "text/markdown"],
  ["doc", "application/msword"],
  [
    "docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ["xls", "application/vnd.ms-excel"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
]);

/** A normalized inbound Telegram media item, agnostic to photo vs document. */
export type TelegramMediaItem = {
  /** Telegram file_id used to resolve the download path via getFile. */
  fileId: string;
  /** Original filename when the sender provided one (documents only). */
  filename?: string;
  /** MIME type as declared by Telegram, when available. */
  mimeType?: string;
  /** Declared file size in bytes, when available. */
  size?: number;
  /** Whether this came from a photo (no filename/mime) or a document. */
  kind: "photo" | "document";
};

export type DownloadedTelegramFile = {
  buffer: Buffer;
  mimeType: string;
  filename: string;
};

/** Resolve a Telegram file_id to its temporary download path. */
export type GetFilePath = (fileId: string) => Promise<string | undefined>;

function getExtension(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const ext = filename.toLowerCase().split(".").pop();
  return ext && ext !== filename.toLowerCase() ? ext : undefined;
}

function extensionForMimeType(mimeType: string): string | undefined {
  for (const [ext, mime] of MIME_TYPES_BY_EXTENSION) {
    if (mime === mimeType) return ext;
  }
  return undefined;
}

export function getTelegramFilename(item: TelegramMediaItem): string {
  const declared = item.filename?.trim();
  if (declared) return declared;
  // Photos arrive without a name; synthesize one with a sensible extension so
  // downstream tooling can infer the type from the filename.
  const ext = item.mimeType
    ? extensionForMimeType(item.mimeType)
    : item.kind === "photo"
      ? "jpg"
      : undefined;
  const base = item.kind === "photo" ? "photo" : "document";
  return ext ? `${base}.${ext}` : base;
}

export function getTelegramMimeType(item: TelegramMediaItem): string {
  const declared = item.mimeType?.trim().toLowerCase();
  if (declared) return declared;
  const ext = getExtension(item.filename);
  if (ext) {
    const mapped = MIME_TYPES_BY_EXTENSION.get(ext);
    if (mapped) return mapped;
  }
  // Telegram photos are always served as JPEG.
  if (item.kind === "photo") return "image/jpeg";
  return "application/octet-stream";
}

export async function downloadTelegramFile(
  item: TelegramMediaItem,
  botToken: string,
  getFilePath: GetFilePath
): Promise<DownloadedTelegramFile> {
  const filePath = await getFilePath(item.fileId);
  if (!filePath) {
    throw new Error("Telegram file is missing a download path");
  }

  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Telegram download failed with ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_UPLOAD_SIZE_BYTES) {
    throw new Error("File exceeds the 20MB upload limit");
  }

  return {
    buffer,
    mimeType: getTelegramMimeType(item),
    filename: getTelegramFilename(item),
  };
}

export async function uploadTelegramFileToMedia(
  file: DownloadedTelegramFile,
  saveMediaFile: (
    data: Uint8Array,
    mimeType: string,
    filename?: string
  ) => Promise<FileAttachment>
): Promise<FileAttachment> {
  return saveMediaFile(file.buffer, file.mimeType, file.filename);
}

export function formatTelegramFileError(
  item: TelegramMediaItem,
  reason: string
): string {
  return `Could not process ${getTelegramFilename(item)}: ${reason}`;
}
