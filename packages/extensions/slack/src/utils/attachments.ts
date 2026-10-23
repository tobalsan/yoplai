import type { FileAttachment } from "@yoplai/shared";
import { EXTENSION_TO_MIME_TYPES } from "@yoplai/shared/media-types";

export const MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "csv", "json"]);

export type SlackFile = {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
  subtype?: string;
  mode?: string;
  preview?: string;
};

export type DownloadedSlackFile = {
  buffer: Buffer;
  mimeType: string;
  filename: string;
};

function getSlackFilename(file: SlackFile): string {
  return file.name?.trim() || file.title?.trim() || file.id || "slack-file";
}

function getExtension(filename: string): string | undefined {
  const match = /.+\.([^.]+)$/.exec(filename);
  return match?.[1]?.toLowerCase();
}

export function isSlackSnippet(file: SlackFile): boolean {
  return file.subtype === "snippet" || file.mode === "snippet";
}

export function extractSlackFilePreview(file: SlackFile): string | null {
  if (!isSlackTextFile(file)) return null;
  const preview = file.preview?.trim();
  if (!preview) return null;
  const filename = getSlackFilename(file);
  return [
    `Snippet: ${filename} (truncated preview; the full file could not be downloaded)`,
    "```", preview, "```",
  ].join("\n");
}

export function isSlackTextFile(file: SlackFile): boolean {
  const ext = getExtension(getSlackFilename(file));
  return isSlackSnippet(file) || Boolean(ext && TEXT_EXTENSIONS.has(ext));
}

export function isSupportedSlackFile(file: SlackFile): boolean {
  if (isSlackTextFile(file)) return true;
  const ext = getExtension(getSlackFilename(file));
  if (!ext || ext === "svg" || !Object.hasOwn(EXTENSION_TO_MIME_TYPES, ext)) return false;
  const allowed = EXTENSION_TO_MIME_TYPES[ext];
  if (!allowed) return false;
  const mimeType = file.mimetype?.toLowerCase();
  return !mimeType || allowed.includes(mimeType);
}

export function getSlackFileMimeType(file: SlackFile): string {
  const ext = getExtension(getSlackFilename(file));
  if (isSlackTextFile(file)) {
    return ext && TEXT_EXTENSIONS.has(ext)
      ? EXTENSION_TO_MIME_TYPES[ext][0]
      : "text/plain";
  }
  return file.mimetype?.toLowerCase()
    || (ext && EXTENSION_TO_MIME_TYPES[ext]?.[0])
    || "application/octet-stream";
}

export function getSlackFileFilename(file: SlackFile): string {
  const filename = getSlackFilename(file);
  const ext = getExtension(filename);
  return isSlackTextFile(file) && (!ext || !TEXT_EXTENSIONS.has(ext))
    ? filename + ".txt"
    : filename;
}

export async function downloadSlackFile(
  file: SlackFile,
  botToken: string
): Promise<DownloadedSlackFile> {
  const url = file.url_private_download?.trim() || file.url_private?.trim();
  if (!url) {
    throw new Error("Slack file is missing a download URL");
  }

  const response = await fetch(url, {
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
    filename: getSlackFileFilename(file),
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
