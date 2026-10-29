import path from "node:path";
import type { GatewayConfig } from "@yoplai/shared";
import { CONFIG_DIR } from "../config/index.js";

export type AvatarProvider = "openai-codex" | "openai";

type ProviderAuth = { apiKey?: string; headers?: Record<string, string>; baseUrl?: string };

export type AvatarImageDeps = {
  fetch: typeof fetch;
  /** Fresh credentials for a provider (OAuth tokens are refreshed), or undefined when unconfigured. */
  getAuth(provider: AvatarProvider): Promise<ProviderAuth | undefined>;
  /** Model ids the provider lists, oldest first, as the model catalog orders them. */
  listModels(provider: AvatarProvider): Promise<string[]>;
};

export class AvatarProviderUnavailableError extends Error {
  constructor(message = "No image source: log in with `yoplai auth login openai-codex` (ChatGPT) or set OPENAI_API_KEY") {
    super(message);
  }
}

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-1";

/**
 * Generate one square PNG for the prompt. Uses the configured provider, or the
 * first one with credentials: a ChatGPT subscription first, then an API key.
 */
export async function generateAvatarImage(
  prompt: string,
  settings: Pick<NonNullable<GatewayConfig["avatars"]>, "provider" | "model"> = {},
  deps: AvatarImageDeps = defaultDeps(),
  signal?: AbortSignal
): Promise<Buffer> {
  const candidates: AvatarProvider[] = settings.provider ? [settings.provider] : ["openai-codex", "openai"];
  for (const provider of candidates) {
    const auth = await deps.getAuth(provider);
    if (!auth?.apiKey) continue;
    if (provider === "openai") return generateWithOpenAi(prompt, auth, settings.model ?? DEFAULT_OPENAI_IMAGE_MODEL, deps, signal);
    // The catalog also lists models a ChatGPT account may not use: try the newest first, then older ones.
    const models = settings.model ? [settings.model] : [...(await deps.listModels(provider))].reverse();
    if (models.length === 0) throw new AvatarProviderUnavailableError("No ChatGPT model available for image generation");
    for (const model of models) {
      const image = await generateWithCodex(prompt, auth, model, deps, signal);
      if (image !== MODEL_NOT_SUPPORTED) return image;
    }
    throw new Error(`None of the ChatGPT models can generate images for this account: ${models.join(", ")}`);
  }
  throw new AvatarProviderUnavailableError();
}

const MODEL_NOT_SUPPORTED = Symbol("model not supported");

/** ChatGPT subscription: a Responses call to a chat model that uses the image_generation tool. */
async function generateWithCodex(
  prompt: string,
  auth: ProviderAuth,
  model: string,
  deps: AvatarImageDeps,
  signal?: AbortSignal
): Promise<Buffer | typeof MODEL_NOT_SUPPORTED> {
  const headers: Record<string, string> = {
    ...auth.headers,
    Authorization: `Bearer ${auth.apiKey}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
  };
  const accountId = chatgptAccountId(auth.apiKey!);
  if (accountId && !headers["chatgpt-account-id"]) headers["chatgpt-account-id"] = accountId;
  const response = await deps.fetch(`${auth.baseUrl ?? CODEX_BASE_URL}/codex/responses`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model,
      instructions: "Generate exactly one image with the image_generation tool. Do not reply with text only.",
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      tools: [{ type: "image_generation", size: "1024x1024", output_format: "png" }],
      tool_choice: "auto",
      stream: true,
      store: false,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 400 && detail.includes("model_not_found")) return MODEL_NOT_SUPPORTED;
    throw new Error(`ChatGPT image request failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  let image: string | undefined;
  let failure: string | undefined;
  for (const line of (await response.text()).split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: { type?: string; item?: { type?: string; result?: string }; response?: { error?: { message?: string } }; message?: string };
    try {
      event = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    if (event.item?.type === "image_generation_call" && event.item.result) image = event.item.result;
    if (event.type === "response.failed" || event.type === "error") {
      failure = event.response?.error?.message ?? event.message ?? "unknown error";
    }
  }
  if (image) return Buffer.from(image, "base64");
  throw new Error(`ChatGPT returned no image${failure ? `: ${failure}` : ""}`);
}

/** OpenAI API key: the Images API. */
async function generateWithOpenAi(
  prompt: string,
  auth: ProviderAuth,
  model: string,
  deps: AvatarImageDeps,
  signal?: AbortSignal
): Promise<Buffer> {
  const response = await deps.fetch(`${auth.baseUrl ?? OPENAI_BASE_URL}/images/generations`, {
    method: "POST",
    headers: { ...auth.headers, Authorization: `Bearer ${auth.apiKey}`, "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ model, prompt, size: "1024x1024", n: 1 }),
  });
  if (!response.ok) throw new Error(`OpenAI image request failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  const body = (await response.json()) as { data?: { b64_json?: string }[] };
  const image = body.data?.[0]?.b64_json;
  if (!image) throw new Error("OpenAI returned no image");
  return Buffer.from(image, "base64");
}

/** The account id ChatGPT expects next to the token, read from the token's own claims. */
export function chatgptAccountId(token: string): string | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"] as { chatgpt_account_id?: string } | undefined;
    return auth?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

function defaultDeps(): AvatarImageDeps {
  const runtime = (async () => {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    return ModelRuntime.create({
      authPath: path.join(CONFIG_DIR, "auth.json"),
      modelsPath: path.join(CONFIG_DIR, "models.json"),
    });
  })();
  return {
    fetch: (...args) => fetch(...args),
    async getAuth(provider) {
      // An unconfigured or expired provider is "no credentials", not a failure: the next one is tried.
      const result = await (await runtime).getAuth(provider).catch(() => undefined);
      return result?.auth as ProviderAuth | undefined;
    },
    async listModels(provider) {
      return (await runtime).getModels(provider).map((model) => model.id);
    },
  };
}
