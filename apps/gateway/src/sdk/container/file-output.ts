import { randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { ContainerFileOutputRequest } from "@yoplai/shared";
import { CONTAINER_DATA_DIR } from "../../agents/container.js";
import {
  ensureMediaDirectories,
  getMediaOutboundDir,
  registerMediaFile,
} from "../../media/metadata.js";
import type { SdkRunParams } from "../types.js";
import { ensurePathWithinDir, sanitizeFilename } from "./launch-spec.js";

export class ContainerFileOutputAdapter {
  async handle(
    params: SdkRunParams,
    event: ContainerFileOutputRequest,
    hostDataDir: string
  ): Promise<void> {
    const source = resolveContainerDataFile(hostDataDir, event.path);
    const realDataDir = await fsPromises.realpath(hostDataDir);
    const realSource = await fsPromises.realpath(source);
    ensurePathWithinDir(realSource, realDataDir);

    const stat = await fsPromises.stat(realSource);
    if (!stat.isFile()) {
      throw new Error(`file_output path is not a file: ${event.path}`);
    }

    const filename = sanitizeFilename(
      event.filename,
      path.basename(realSource) || "download"
    );
    const ext = path.extname(filename);
    const fileId = randomUUID();
    const storedFilename = `${fileId}${ext}`;
    const target = path.join(getMediaOutboundDir(), storedFilename);
    const mimeType = event.mimeType || "application/octet-stream";

    await ensureMediaDirectories();
    await fsPromises.copyFile(realSource, target);
    const metadata = await registerMediaFile({
      direction: "outbound",
      fileId,
      filename,
      storedFilename,
      path: target,
      mimeType,
      size: stat.size,
      agentId: params.agentId,
      sessionId: params.sessionId,
    });

    const timestamp = Date.now();
    params.onHistoryEvent({
      type: "assistant_file",
      fileId: metadata.fileId,
      filename: metadata.filename,
      mimeType: metadata.mimeType,
      size: metadata.size,
      direction: "outbound",
      timestamp,
    });
    params.onEvent({
      type: "file_output",
      fileId: metadata.fileId,
      filename: metadata.filename,
      mimeType: metadata.mimeType,
      size: metadata.size,
    });
  }
}

export function resolveContainerDataFile(
  hostDataDir: string,
  containerPath: string
): string {
  const normalized = path.posix.normalize(containerPath);
  const relative = path.posix.relative(CONTAINER_DATA_DIR, normalized);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.posix.isAbsolute(relative)
  ) {
    throw new Error(`file_output path must be under ${CONTAINER_DATA_DIR}`);
  }
  return path.join(hostDataDir, ...relative.split("/"));
}
