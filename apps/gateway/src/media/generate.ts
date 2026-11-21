import path from "node:path";
import type { AssistantImages, ImageApi, ImageModel } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { GatewayConfig } from "@yoplai/shared";
import { CONFIG_DIR } from "../config/index.js";
import { logWarn } from "../logging.js";
import { extractCodexAccountId } from "../model-quota/identity.js";
import {
  describeRefreshError,
  resolveOAuthToken,
  type OAuthTokenLookup,
  type OAuthTokensDeps,
} from "../sdk/container/oauth-tokens.js";

const CODEX_PROVIDER = "openai-codex";
const CODEX_URL = "https://chatgpt.com/backend-api/codex/images/generations";
const RECONNECT = "The ChatGPT connection is missing or expired. Ask an admin to reconnect it";
const QUOTA_CODES = new Set(["usage_limit_reached", "usage_not_included", "rate_limit_exceeded"]);

type ImageRuntime = Pick<ModelRuntime, "generateImages"> & {
  getModelOfType(type: "image", provider: string, model: string): ImageModel<ImageApi> | undefined;
};

type GenerateImageDeps = {
  createRuntime?: () => Promise<ImageRuntime>;
  fetch?: typeof fetch;
  oauth?: OAuthTokensDeps;
};

type CodexImageResponse = {
  error?: { code?: string; type?: string; resets_at?: number };
  data?: { b64_json?: string }[];
};

type GeneratedImage = { bytes: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp" };

function finalError(message: string): Error {
  return new Error(`${message}; no fallback is configured`);
}

function logBackendFailure(provider: string, error: unknown, status?: number, knownSecret?: string): void {
  logWarn("Image generation backend failed", {
    provider, status, error: describeRefreshError(error, knownSecret),
  });
}

function codexHttpError(status: number, error?: CodexImageResponse["error"]): Error {
  if (status === 429 || QUOTA_CODES.has(error?.code ?? error?.type ?? "")) {
    const reset = typeof error?.resets_at === "number" ? new Date(error.resets_at * 1000) : undefined;
    const when = reset && Number.isFinite(reset.getTime()) ? ` (resets at ${reset.toISOString()})` : "";
    return finalError(`The ChatGPT image quota is used up${when}`);
  }
  if (status === 401 || status === 403) {
    return finalError("The ChatGPT connection was rejected or the account has no image access");
  }
  return finalError(`Image generation failed (HTTP ${status})`);
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw finalError("Image generation was cancelled");
}

function detectImageMimeType(bytes: Buffer): GeneratedImage["mimeType"] | undefined {
  if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

async function generateCodexImage(
  prompt: string,
  model: string,
  signal: AbortSignal | undefined,
  deps: GenerateImageDeps,
): Promise<GeneratedImage> {
  const timeout = AbortSignal.timeout(120_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const checkRequestSignal = () => {
    checkCancelled(signal);
    if (timeout.aborted) throw finalError("Image generation timed out");
  };

  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(requestSignal.reason);
    requestSignal.addEventListener("abort", onAbort, { once: true });
  });
  let token: OAuthTokenLookup;
  try {
    // Stop waiting when this run ends. The refresh is shared with other runs.
    token = await Promise.race([
      resolveOAuthToken(CODEX_PROVIDER, [CODEX_PROVIDER], deps.oauth),
      aborted,
    ]);
  } catch (error) {
    checkRequestSignal();
    logBackendFailure(CODEX_PROVIDER, error);
    throw finalError(RECONNECT);
  } finally {
    requestSignal.removeEventListener("abort", onAbort);
  }
  checkRequestSignal();
  if (token.status !== "ok") throw finalError(RECONNECT);
  const accountId = extractCodexAccountId(token.accessToken);
  if (!accountId) throw finalError(RECONNECT);
  let response: Response | undefined;
  let raw: string;
  try {
    response = await (deps.fetch ?? fetch)(CODEX_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "chatgpt-account-id": accountId,
        originator: "pi",
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt, model, n: 1 }),
      redirect: "error",
      signal: requestSignal,
    });
    raw = await response.text();
  } catch (error) {
    checkRequestSignal();
    logBackendFailure(CODEX_PROVIDER, error, response?.status, token.accessToken);
    throw response ? codexHttpError(response.status) : finalError("Image generation failed");
  }
  checkRequestSignal();

  let payload: CodexImageResponse | undefined;
  try {
    payload = JSON.parse(raw) ?? undefined;
  } catch {
    if (response.ok) {
      logBackendFailure(CODEX_PROVIDER, "Invalid JSON response", response.status);
      throw codexHttpError(response.status);
    }
  }
  if (!response.ok) {
    logBackendFailure(CODEX_PROVIDER, raw, response.status, token.accessToken);
    throw codexHttpError(response.status, payload?.error);
  }

  const data = payload?.data?.[0]?.b64_json;
  if (typeof data !== "string" || !data) throw finalError("Image generation returned no image");
  const bytes = Buffer.from(data, "base64");
  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) throw finalError("Image generation returned an unsupported image format");
  return { bytes, mimeType };
}

function createImageRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: path.join(CONFIG_DIR, "auth.json"),
    modelsPath: path.join(CONFIG_DIR, "models.json"),
  });
}

export async function generateImage(
  prompt: string,
  config: GatewayConfig,
  signal?: AbortSignal,
  deps: GenerateImageDeps = {},
): Promise<GeneratedImage> {
  const setting = config.imageGeneration;
  if (setting?.enabled !== true) throw finalError("Image generation is disabled");
  checkCancelled(signal);
  if (setting.provider === CODEX_PROVIDER) {
    return generateCodexImage(prompt, setting.model ?? "gpt-image-2", signal, deps);
  }

  const { provider, model: modelId } = setting;
  const failure = `Image generation failed on ${provider}/${modelId}`;
  let response: AssistantImages | undefined;
  try {
    const runtime = await (deps.createRuntime ?? createImageRuntime)();
    const model = modelId && runtime.getModelOfType("image", provider, modelId);
    if (model && !signal?.aborted) {
      response = await runtime.generateImages(model, { input: [{ type: "text", text: prompt }] }, { signal });
    }
  } catch (error) {
    checkCancelled(signal);
    logBackendFailure(provider, error);
    throw finalError(failure);
  }
  checkCancelled(signal);
  if (!response) throw finalError("The configured image generation model was not found");
  if (response.stopReason !== "stop") {
    logBackendFailure(provider, response.errorMessage ?? response.stopReason);
    throw finalError(failure);
  }
  const image = response.output.find((part) => part.type === "image");
  if (!image?.data) throw finalError("Image generation returned no image");
  const bytes = Buffer.from(image.data, "base64");
  const mimeType = detectImageMimeType(bytes);
  if (mimeType !== image.mimeType) throw finalError("Image generation returned an invalid image");
  return { bytes, mimeType };
}
