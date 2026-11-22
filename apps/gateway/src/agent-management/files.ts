import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { writeFileAtomic, writeJsonAtomic } from "../util/atomic-write.js";

export const creatorFile = ".created-by.json";
const avatarFile = ".agent-avatar.json";
export const defaultFaceSchema = z.number().int().min(1).max(10);
export const modelChoiceSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict();
const generatedAvatar = /^avatar-[a-f0-9-]{36}\.(?:png|jpg|gif|webp)$/;
const defaultAvatar = /^default-([1-9]|10)\.webp$/;
const avatarStateSchema = z.object({
  filename: z.string(), face: defaultFaceSchema, custom: z.boolean(),
  obsolete: z.array(z.string().refine((name) => generatedAvatar.test(name) || defaultAvatar.test(name))).optional(),
});
type AvatarState = z.infer<typeof avatarStateSchema>;

export class AgentManagementError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 413 | 500, message: string) {
    super(message);
  }
}

export function isReservedText(value: string | undefined | null): boolean {
  return !!value && /^\$(?:env|secret):/.test(value.trimStart());
}

export function readAgentOwner(directory: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(path.join(directory, creatorFile), "utf8")) as { userId?: unknown } | null;
    return typeof value?.userId === "string" && value.userId ? value.userId : undefined;
  } catch {
    return undefined;
  }
}

export function readAvatarState(directory: string, avatar: string | undefined): {
  custom: boolean;
  face?: number;
  generatedFile?: string;
  obsolete?: string[];
} {
  try {
    const state = avatarStateSchema.parse(JSON.parse(readFileSync(path.join(directory, avatarFile), "utf8")));
    if (state.filename === avatar && (generatedAvatar.test(state.filename) || state.filename === `default-${state.face}.webp`)) {
      return { custom: state.custom, face: state.face, generatedFile: state.filename, obsolete: state.obsolete };
    }
  } catch {
    // Older workspaces have no avatar metadata.
  }
  const legacyFace = avatar && defaultAvatar.exec(avatar)?.[1];
  return { custom: !!avatar && !legacyFace && !(/^\p{Emoji}/u.test(avatar) && avatar.length <= 4), ...(legacyFace ? { face: Number(legacyFace) } : {}) };
}

export type UploadedAvatar = { bytes: Buffer; extension: "png" | "jpg" | "webp" | "gif" };
const maxAvatarSize = 2 * 1024 * 1024;

export async function readAvatarUpload(file: File): Promise<UploadedAvatar> {
  if (file.size > maxAvatarSize) throw new AgentManagementError("avatar_too_large", 413, "Choose an image of 2 MB or less.");
  const bytes = Buffer.from(await file.arrayBuffer());
  const extension = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? "png"
    : bytes.subarray(0, 3).toString("hex") === "ffd8ff" ? "jpg"
    : bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP" ? "webp"
    : /^(GIF87a|GIF89a)$/.test(bytes.toString("latin1", 0, 6)) ? "gif"
    : undefined;
  if (!extension) throw new AgentManagementError("invalid_avatar", 400, "Choose a PNG, JPEG, WebP, or GIF image.");
  return { bytes, extension };
}

async function defaultFaceBytes(face: number) {
  const filename = `default-${face}.webp`;
  if (process.env.YOPLAI_WEB_DIST) return fs.readFile(path.join(process.env.YOPLAI_WEB_DIST, "avatars", filename));
  const bundled = fileURLToPath(new URL(`./avatars/${filename}`, import.meta.url));
  try {
    return await fs.readFile(bundled);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return fs.readFile(new URL(`../../../web/public/avatars/${filename}`, import.meta.url));
  }
}

export async function stageAvatar(directory: string, face: number, upload?: UploadedAvatar, onboarding = false): Promise<AvatarState> {
  const filename = onboarding ? `default-${face}.webp` : `avatar-${randomUUID()}.${upload?.extension ?? "webp"}`;
  await writeFileAtomic(path.join(directory, filename), upload?.bytes ?? await defaultFaceBytes(face));
  return { filename, face, custom: !!upload };
}

export function writeAvatarState(directory: string, state: AvatarState) {
  return writeJsonAtomic(path.join(directory, avatarFile), state);
}
