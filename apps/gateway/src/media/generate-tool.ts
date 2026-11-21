import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ContainerExtensionTool, ExtensionAgentToolContext, GatewayConfig } from "@yoplai/shared";
import { ensurePathWithinDir, sanitizeFilename } from "../sdk/container/launch-spec.js";
import { generateImage } from "./generate.js";

export const generateImageTool = {
  extensionId: "gateway",
  name: "generate_image",
  description: "Generate one image from a text prompt and save it in the conversation files folder. Call send_file with the returned path to show it to the user. If the user rejects the image, call generate_image again with a reworded prompt to create a fresh image. On error, tell the user the reason and stop. The attempt is final and has no fallback.",
  parameters: {
    type: "object",
    properties: { prompt: { type: "string", description: "Text describing the image to generate" } },
    required: ["prompt"],
  },
} satisfies ContainerExtensionTool;

const imageExtensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

export async function executeGenerateImage(
  args: unknown,
  config: GatewayConfig,
  files: ExtensionAgentToolContext["conversationFiles"],
  signal?: AbortSignal,
  generate = generateImage,
): Promise<string> {
  if (config.imageGeneration?.enabled !== true) {
    throw new Error("Image generation is disabled; no fallback is configured");
  }
  const prompt = (args as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw Object.assign(new Error("generate_image requires a non-empty prompt"), { code: "invalid_input" });
  }
  if (!files) throw new Error("Conversation files are unavailable for this run; no fallback is configured");

  const { bytes, mimeType } = await generate(prompt, config, signal);
  const name = `generated-image-${randomUUID()}.${imageExtensions[mimeType]}`;
  const filename = sanitizeFilename(name, name);
  const hostPath = path.join(files.hostPath, filename);
  ensurePathWithinDir(hostPath, files.hostPath);
  signal?.throwIfAborted();
  const handle = await fs.open(hostPath, "wx", 0o600).catch(() => {
    throw new Error("Could not save the generated image to conversation files; no fallback is configured");
  });
  try {
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    signal?.throwIfAborted();
  } catch {
    await fs.rm(hostPath, { force: true }).catch(() => {});
    signal?.throwIfAborted();
    throw new Error("Could not save the generated image to conversation files; no fallback is configured");
  }

  const runtimePath = path.join(files.runtimePath, filename);
  return `Image saved at ${runtimePath}\nCall send_file with this path to show the image to the user.`;
}
