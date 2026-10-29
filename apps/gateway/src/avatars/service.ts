import fs from "node:fs/promises";
import path from "node:path";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { updateAgentAvatar } from "../extensions/agent-config-writer.js";
import { resolveWorkspaceDir } from "../config/index.js";
import { generateAvatarImage, type AvatarImageDeps } from "./generate.js";
import { buildAvatarPrompt } from "./prompt.js";
import { resolveAvatarStyle } from "./styles.js";

export const AVATAR_FILE = "avatar.png";

export type AvatarServiceDeps = {
  generateImage?: (prompt: string, settings: NonNullable<GatewayConfig["avatars"]>, signal?: AbortSignal) => Promise<Buffer>;
  imageDeps?: AvatarImageDeps;
};

/**
 * Generate an avatar for one agent in the given style (or the configured
 * default), save it as `avatar.png` in the agent's workspace and point
 * `agent.yaml` at it. The style is resolved first so a typo costs no image.
 */
export async function generateAgentAvatar(
  agent: AgentConfig,
  config: Pick<GatewayConfig, "avatars">,
  styleId?: string,
  deps: AvatarServiceDeps = {},
  signal?: AbortSignal
): Promise<{ style: string; file: string }> {
  if (!agent.workspace) throw new Error(`Agent "${agent.id}" has no workspace`);
  const style = resolveAvatarStyle(config, styleId);
  const settings = config.avatars ?? {};
  const prompt = buildAvatarPrompt(agent, style);
  const image = deps.generateImage
    ? await deps.generateImage(prompt, settings, signal)
    : await generateAvatarImage(prompt, settings, deps.imageDeps, signal);
  const workspaceDir = resolveWorkspaceDir(agent.workspace);
  const file = path.join(workspaceDir, AVATAR_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, image);
  await fs.rename(tmp, file);
  if (agent.avatar !== AVATAR_FILE) await updateAgentAvatar(workspaceDir, AVATAR_FILE);
  return { style: style.id, file };
}
