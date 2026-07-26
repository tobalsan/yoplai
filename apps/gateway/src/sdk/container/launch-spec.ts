import fs from "node:fs";
import path from "node:path";
import { resolveHomeDir, type FileAttachment, type GatewayConfig } from "@yoplai/shared";
import type { SdkRunParams } from "../types.js";
import {
  buildContainerArgs,
  buildVolumeMounts,
  CONTAINER_UPLOADS_DIR,
  getAgentDataDir,
  getSessionUploadsDir,
} from "../../agents/container.js";
import { getMediaInboundDir } from "../../media/metadata.js";

export type ContainerLaunchSpec = {
  args: string[];
  containerName: string;
  homeDir: string;
  ipcDir: string;
  ipcInputDir: string;
  hostDataDir: string;
  hostUploadsDir: string;
};

export function buildContainerLaunchSpec(
  params: SdkRunParams,
  config: GatewayConfig
): ContainerLaunchSpec {
  const globalSandbox = config.sandbox ?? {};
  const homeDir = resolveHomeDir();
  const mounts = buildVolumeMounts(
    params.agent,
    globalSandbox,
    homeDir,
    params.userId,
    config.onecli,
    params.sessionId
  );
  const args = buildContainerArgs(
    params.agent,
    globalSandbox,
    mounts,
    homeDir,
    params.userId,
    config.onecli,
    config.env
  );
  const containerName = getArgValue(args, "--name");
  const ipcDir = path.join(homeDir, "ipc", params.agentId);
  return {
    args,
    containerName,
    homeDir,
    ipcDir,
    ipcInputDir: path.join(ipcDir, "input"),
    hostDataDir: getAgentDataDir(homeDir, params.agentId),
    hostUploadsDir: getSessionUploadsDir(
      homeDir,
      params.agentId,
      params.sessionId
    ),
  };
}

export function prepareLaunchFilesystem(
  params: SdkRunParams,
  spec: ContainerLaunchSpec
): void {
  fs.rmSync(spec.ipcInputDir, { recursive: true, force: true });
  fs.mkdirSync(spec.ipcInputDir, { recursive: true });
  fs.mkdirSync(path.join(spec.homeDir, "sessions", params.agentId), {
    recursive: true,
  });
  if (params.userId) {
    fs.mkdirSync(path.join(spec.homeDir, "users", params.userId), {
      recursive: true,
    });
  }
  prepareContainerUploads(params.attachments, spec.hostUploadsDir);
}

export function prepareContainerUploads(
  attachments: FileAttachment[] | undefined,
  uploadsDir: string
): void {
  fs.rmSync(uploadsDir, { recursive: true, force: true });
  fs.mkdirSync(uploadsDir, { recursive: true });

  if (!attachments?.length) return;

  const realInboundDir = fs.realpathSync(getMediaInboundDir());
  attachments.forEach((attachment, index) => {
    copyUploadAttachment(attachment, index, realInboundDir, uploadsDir);
  });
}

export function remapAttachmentsToContainer(
  attachments: FileAttachment[] | undefined
): FileAttachment[] | undefined {
  if (!attachments?.length) return attachments;
  return attachments.map((attachment, index) => {
    const safeName = sanitizeFilename(
      attachment.filename ?? path.basename(attachment.path),
      path.basename(attachment.path)
    );
    return {
      ...attachment,
      path: path.join(CONTAINER_UPLOADS_DIR, `${index + 1}-${safeName}`),
    };
  });
}

export function sanitizeFilename(
  filename: string | undefined,
  fallback: string
): string {
  if (!filename) return fallback;
  const cleaned = filename
    .replace(/\0/g, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1);
  return cleaned?.replace(/["\\\r\n]/g, "_") || fallback;
}

function copyUploadAttachment(
  attachment: FileAttachment,
  index: number,
  realInboundDir: string,
  uploadsDir: string
): void {
  const source = fs.realpathSync(attachment.path);
  ensurePathWithinDir(source, realInboundDir);
  const safeName = sanitizeFilename(
    attachment.filename ?? path.basename(source),
    path.basename(source)
  );
  const target = path.join(uploadsDir, `${index + 1}-${safeName}`);
  fs.copyFileSync(source, target);
}

export function ensurePathWithinDir(filePath: string, dir: string): void {
  const relative = path.relative(dir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside expected directory: ${filePath}`);
  }
}

function getArgValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value) {
    throw new Error(`Missing docker arg: ${flag}`);
  }
  return value;
}
