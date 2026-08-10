import path from "node:path";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { modelSupportsImages, type GatewayConfig } from "@yoplai/shared";
import { CONFIG_DIR } from "../config/index.js";

const SYSTEM_PROMPT = `Describe this image for another model. Transcribe every visible string verbatim. Preserve tables with explicit rows and columns. Describe charts as data and relationships. Mark any unreadable text or detail as [illegible]; never guess.`;

export async function describeImage(
  bytes: Buffer,
  mimeType: string,
  config: GatewayConfig,
  question?: string
): Promise<string> {
  const configured = config.imageDescription;
  if (!configured?.enabled) throw new Error("Image description is not configured");
  const auth = AuthStorage.create(path.join(CONFIG_DIR, "auth.json"));
  const registry = ModelRegistry.create(auth, path.join(CONFIG_DIR, "models.json"));
  const model = registry.find(configured.provider, configured.model) as Model<Api> | undefined;
  if (!model) throw new Error(`Image description model not found: ${configured.provider}/${configured.model}`);
  if (!modelSupportsImages(model)) throw new Error("Image description model does not support image input");
  const context: Context = { messages: [{ role: "user", timestamp: Date.now(), content: [
    { type: "text", text: question ? `${SYSTEM_PROMPT}\n\nQuestion: ${question}` : SYSTEM_PROMPT },
    { type: "image", data: bytes.toString("base64"), mimeType },
  ] }] };
  const response = await completeSimple(model, context, { maxTokens: 8_000, temperature: 0 });
  if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Image description failed");
  const description = response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n").trim();
  // An empty description reads as a successful "nothing there"; fail instead so callers emit the failure notice.
  if (!description) throw new Error("Image description returned no text");
  return description;
}

export function configuredModelSupportsImages(config: GatewayConfig, provider: string, modelId: string): boolean {
  const auth = AuthStorage.create(path.join(CONFIG_DIR, "auth.json"));
  const registry = ModelRegistry.create(auth, path.join(CONFIG_DIR, "models.json"));
  return modelSupportsImages(registry.find(provider, modelId));
}
