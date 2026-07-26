import type { FileAttachment } from "@yoplai/shared";

export const MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;

const SUPPORTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const SUPPORTED_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
]);

const MIME_TYPES_BY_EXTENSION = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["pdf", "application/pdf"],
  ["doc", "application/msword"],
  [
    "docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ["xls", "application/vnd.ms-excel"],
  [
    "xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
]);

export type SlackFile = {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private_download?: string;
  subtype?: string;
  mode?: string;
  preview?: string;
};

export type DownloadedSlackFile = {
  buffer: Buffer;
  mimeType: string;
  filename: string;
};

export function getSlackFilename(file: SlackFile): string {
  return file.name?.trim() || file.title?.trim() || file.id || "slack-file";
}

function getExtension(filename: string): string | undefined {
  return filename.toLowerCase().split(".").pop();
}

export function isSlackSnippet(file: SlackFile): boolean {
  return file.subtype === "snippet" || file.mode === "snippet";
}

export function extractSnippetText(file: SlackFile): string | null {
  if (!isSlackSnippet(file)) return null;
  const preview = file.preview?.trim();
  if (!preview) return null;
  const filename = getSlackFilename(file);
  return [`Snippet: ${filename}`, "```", preview, "```"].join("\n");
}

export function isSupportedSlackFile(file: SlackFile): boolean {
  const mimeType = file.mimetype?.toLowerCase();
  const ext = getExtension(getSlackFilename(file));
  if (!ext || !SUPPORTED_EXTENSIONS.has(ext)) return false;
  const expectedMimeType = MIME_TYPES_BY_EXTENSION.get(ext);
  if (!mimeType) return true;
  return Boolean(
    expectedMimeType &&
      mimeType === expectedMimeType &&
      SUPPORTED_MIME_TYPES.has(mimeType)
  );
}

export function getSlackFileMimeType(file: SlackFile): string {
  const mimeType = file.mimetype?.toLowerCase();
  if (mimeType) return mimeType;
  const ext = getExtension(getSlackFilename(file));
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xls":
      return "application/vnd.ms-excel";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default:
      return "application/octet-stream";
  }
}

export async function downloadSlackFile(
  file: SlackFile,
  botToken: string
): Promise<DownloadedSlackFile> {
  if (!file.url_private_download) {
    throw new Error("Slack file is missing a download URL");
  }

  const response = await fetch(file.url_private_download, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!response.ok) {
    throw new Error(`Slack download failed with ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_UPLOAD_SIZE_BYTES) {
    throw new Error("File exceeds the 25MB upload limit");
  }

  return {
    buffer,
    mimeType: getSlackFileMimeType(file),
    filename: getSlackFilename(file),
  };
}

export async function uploadSlackFileToMedia(
  file: DownloadedSlackFile,
  saveMediaFile: (
    data: Uint8Array,
    mimeType: string,
    filename?: string
  ) => Promise<FileAttachment>
): Promise<FileAttachment> {
  return saveMediaFile(file.buffer, file.mimeType, file.filename);
}

export function formatSlackFileError(file: SlackFile, reason: string): string {
  return `Could not process ${getSlackFilename(file)}: ${reason}`;
}
