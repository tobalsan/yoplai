import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type {
  ContainerFileOutputRequest,
  ExtensionAgentToolContext,
} from "@yoplai/shared";
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
    hostDataDir: string | undefined,
    signal?: AbortSignal,
    conversationFiles?: ExtensionAgentToolContext["conversationFiles"]
  ): Promise<void> {
    signal?.throwIfAborted();
    const files =
      conversationFiles &&
      event.path.startsWith(`${conversationFiles.runtimePath}/`)
        ? conversationFiles
        : undefined;
    if (!files && !hostDataDir)
      throw new Error(
        "File path must be under the conversation files directory"
      );
    const source = resolveContainerDataFile(
      files?.hostPath ?? hostDataDir!,
      event.path,
      files?.runtimePath
    );
    const realDataDir = await fsPromises.realpath(
      files?.hostPath ?? hostDataDir!
    );
    if (files && path.dirname(source) !== path.resolve(files.hostPath)) {
      throw new Error(
        "send_file requires a file directly in the conversation files directory; nested paths are not supported"
      );
    }
    const realSource = files
      ? path.join(realDataDir, path.basename(source))
      : await fsPromises.realpath(source);
    ensurePathWithinDir(realSource, realDataDir);

    const sourceFile = files
      ? await fsPromises.open(
          realSource,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        )
      : undefined;
    try {
      const stat = sourceFile
        ? await sourceFile.stat()
        : await fsPromises.stat(realSource);
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

      signal?.throwIfAborted();
      await ensureMediaDirectories();
      if (sourceFile) {
        try {
          await pipeline(
            sourceFile.createReadStream({ autoClose: false }),
            createWriteStream(target, { flags: "wx" }),
            { signal }
          );
        } catch (error) {
          await fsPromises.rm(target, { force: true });
          throw error;
        }
      } else {
        await fsPromises.copyFile(realSource, target);
      }
      signal?.throwIfAborted();
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
        userId: params.userId,
      });

      signal?.throwIfAborted();
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
    } finally {
      await sourceFile?.close();
    }
  }
}

export function resolveContainerDataFile(
  hostDataDir: string,
  containerPath: string,
  runtimeRoot = CONTAINER_DATA_DIR
): string {
  const normalized = path.posix.normalize(containerPath);
  const relative = path.posix.relative(runtimeRoot, normalized);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.posix.isAbsolute(relative)
  ) {
    throw new Error(`file_output path must be under ${runtimeRoot}`);
  }
  return path.join(hostDataDir, ...relative.split("/"));
}
