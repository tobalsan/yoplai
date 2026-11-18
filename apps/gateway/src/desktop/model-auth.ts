import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import fs from "node:fs/promises";
import type { AnyModel, Api, AssistantMessage, AuthResult, Model } from "@earendil-works/pi-ai";
import type { ModelRuntimeAuthOverrides } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR } from "../config/index.js";
import { desktopEnabled } from "./guard.js";
import { isRelayEnabled } from "../relay/state.js";
import { CLAUDE_LOGIN_UNAVAILABLE, CLAUDE_WARNING_REQUIRED, getExternalSources } from "./external-sources.js";
import { modelReadiness } from "./model-picker.js";
import { CODEX_EXPIRED, isLiteralKey } from "./literal-key.js";
export { isLiteralKey } from "./literal-key.js";

type AuthMode = "oauth" | "api_key";
export type ExternalCredential = { type: AuthMode; key: string; source: string };
type ReadExternal = (provider: string, model: AnyModel | undefined, mode?: AuthMode) => Promise<ExternalCredential | undefined>;
const EXTERNAL_FAILURE = "The external login failed. Check the login in its app.";

export function isSafeModelAccessError(message: string | undefined): message is string {
  return message === CODEX_EXPIRED || message === CLAUDE_WARNING_REQUIRED || message === CLAUDE_LOGIN_UNAVAILABLE;
}

function safeExternalError(provider: string, message?: string): string {
  if (isSafeModelAccessError(message)) return message;
  if (provider === "openai-codex" && /\b401\b/.test(message ?? "")) return CODEX_EXPIRED;
  return EXTERNAL_FAILURE;
}

export async function createModelAuth(options: {
  home?: string;
  mode?: AuthMode;
  primaryProvider?: string;
  readExternal?: ReadExternal;
  submitted?: { provider: string; key: string };
} = {}) {
  const { ModelRuntime, readStoredCredential } = await import("@earendil-works/pi-coding-agent");
  const { getEnvApiKey } = await import("@earendil-works/pi-ai/compat");
  const home = options.home ?? CONFIG_DIR;
  const readExternal = options.readExternal ?? (isRelayEnabled() ? getExternalSources(home).resolve : undefined);
  const authPath = path.join(home, "auth.json");
  const modelsPath = path.join(home, "models.json");
  const runtime = await ModelRuntime.create(options.submitted ? {
    modelsPath,
    refreshOnCreate: false,
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => { throw new Error("This store cannot save keys."); },
      delete: async () => { throw new Error("This store cannot delete keys."); },
    },
  } : { authPath, modelsPath });
  const nativeAuth = runtime.getAuth.bind(runtime);
  const request = new AsyncLocalStorage<{ external: boolean; source?: string }>();

  async function resolveModelAuth(target: string | AnyModel, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined> {
    const model = typeof target === "string" ? undefined : target;
    const provider = typeof target === "string" ? target : target.provider;
    const mode = provider === options.primaryProvider ? options.mode : undefined;
    const scope = request.getStore();
    const native = (override?: ModelRuntimeAuthOverrides) => {
      const args = override ? [override] as const : [] as const;
      return typeof target === "string" ? nativeAuth(target, ...args) : nativeAuth(target, ...args);
    };
    if (options.submitted) {
      const { key } = options.submitted;
      if (options.submitted.provider !== provider || !isLiteralKey(key) || !runtime.getProvider(provider)?.auth.apiKey) return undefined;
      return native({ ...overrides, apiKey: key });
    }
    const credential = readStoredCredential(provider, authPath);
    const explicit = overrides?.apiKey;
    const ownedKey = mode === "api_key" && credential?.type === "api_key" ? credential.key : undefined;
    if (explicit !== undefined || ownedKey || (credential && (!mode || mode === credential.type))) {
      if (scope && credential && explicit === undefined) scope.source = "owned";
      return explicit !== undefined || ownedKey ? native({ ...overrides, apiKey: explicit ?? ownedKey }) : native(overrides);
    }

    let external: ExternalCredential | undefined;
    if (desktopEnabled() && readExternal) {
      if (scope) scope.external = true;
      external = await readExternal(provider, model, mode);
      if (scope) scope.external = external !== undefined;
    }
    if (external) {
      if (scope) scope.source = external.source;
      if (external.type === "api_key") return native({ ...overrides, apiKey: external.key });
      const headers = model && "reasoning" in model ? runtime.getCompatibilityRequestConfig(model).headers : undefined;
      return { auth: { apiKey: external.key, headers }, source: external.source };
    }
    if (mode === "oauth") return undefined;
    if (scope) scope.source = "environment";
    if (mode === "api_key") {
      const key = getEnvApiKey(provider);
      return key ? native({ ...overrides, apiKey: key }) : undefined;
    }
    return native(overrides);
  }

  const providerApiKeyEnv: Readonly<Record<string, string>> = {
    "opencode-go": "OPENCODE_API_KEY", "github-copilot": "COPILOT_GITHUB_TOKEN",
    google: "GEMINI_API_KEY", huggingface: "HF_TOKEN", moonshotai: "MOONSHOT_API_KEY", "moonshotai-cn": "MOONSHOT_API_KEY",
    "kimi-coding": "KIMI_API_KEY", "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
    azure: "AZURE_OPENAI_API_KEY", "cloudflare-workers-ai": "CLOUDFLARE_API_KEY", "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
  };
  async function requireModelAuth(model: Model<Api>) {
    const provider = model.provider;
    const mode = provider === options.primaryProvider ? options.mode : undefined;
    if (!desktopEnabled() && mode === "api_key") {
      const stored = readStoredCredential(provider, authPath);
      const key = (stored?.type === "api_key" && stored.key) || getEnvApiKey(provider);
      if (key) {
        await runtime.setRuntimeApiKey(provider, key);
        return;
      }
    } else {
      const auth = await resolveModelAuth(model);
      if (auth?.auth.apiKey || Object.keys(auth?.auth.headers ?? {}).length || Object.keys(auth?.env ?? {}).length) return;
    }
    if (mode === "oauth" && readStoredCredential(provider, authPath)?.type !== "oauth") {
      throw new Error(`No OAuth credentials for provider: ${provider}. Run 'yoplai auth login ${provider}' first.`);
    }
    if (mode === "api_key") {
      const envVar = providerApiKeyEnv[provider] ?? `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
      throw new Error(`No API key for provider: ${provider}. Set ${envVar} env var.`);
    }
    throw new Error(`No API key for provider: ${provider}`);
  }
  if (!desktopEnabled() && !options.submitted) return { runtime, resolveModelAuth, requireModelAuth };
  runtime.getAuth = resolveModelAuth;
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, requestOptions) => {
    const scope: { external: boolean; source?: string } = { external: false };
    let status: number | undefined;
    const result = request.run(scope, () => stream(model, context, {
      ...requestOptions,
      // Pi reads this option after it resolves the credential for the request.
      get transport() {
        return model.provider === "openai-codex" && scope.external ? "sse" : requestOptions?.transport;
      },
      async onResponse(response, target) {
        status = response.status;
        await requestOptions?.onResponse?.(response, target);
      },
    }));
    const push = result.push.bind(result);
    const end = result.end.bind(result);
    function safe(message: AssistantMessage): AssistantMessage {
      if (!scope.external) return message;
      const clean = { ...message };
      delete clean.diagnostics;
      if (clean.stopReason === "error" || clean.errorMessage !== undefined) {
        clean.errorMessage = safeExternalError(model.provider, status === 401 ? "401" : clean.errorMessage);
      }
      return clean;
    }
    function remember(message: AssistantMessage) {
      if (!desktopEnabled() || !scope.source || message.stopReason === "aborted") return;
      const ok = message.stopReason !== "error" && message.content.some((part) => part.type === "text" && part.text.trim());
      modelReadiness.record(scope.source, message.provider, message.model, ok);
    }
    result.push = (event) => {
      if (event.type === "done") remember(event.message);
      if (event.type === "error") remember(event.error);
      if (event.type === "error") push({ ...event, error: safe(event.error) });
      else if (event.type === "done") push({ ...event, message: safe(event.message) });
      else push({ ...event, partial: safe(event.partial) });
    };
    result.end = (message) => end(message ? safe(message) : undefined);
    return result;
  };

  return { runtime, resolveModelAuth, requireModelAuth };
}

export async function completeModelOnce(runtime: Awaited<ReturnType<typeof createModelAuth>>["runtime"], model: Model<Api>, text: string, signal = AbortSignal.timeout(20_000), maxTokens = 256) {
  const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: text, timestamp: Date.now() }] }, { maxTokens, signal, ...(model.provider === "openai-codex" && { transport: "sse" }) });
  if (result.stopReason === "aborted" || result.stopReason === "error") throw new Error(isSafeModelAccessError(result.errorMessage) ? result.errorMessage : "The model call failed.");
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

type ModelHeaderConfig = {
  providers?: Record<string, {
    headers?: Record<string, unknown>;
    models?: Array<{ id: string; headers?: Record<string, unknown> }>;
    modelOverrides?: Record<string, { headers?: Record<string, unknown> }>;
  }>;
};

async function readModelConfig(home: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(home, "models.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function hasCustomHeaders(raw: string, provider: string, model: string): boolean {
  // Pi accepts line comments and trailing commas in models.json.
  const json = raw.replace(/^\uFEFF/, "")
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => match.startsWith('"') ? match : "")
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? match);
  const config = (JSON.parse(json) as ModelHeaderConfig).providers?.[provider];
  const headers = [config?.headers, config?.modelOverrides?.[model]?.headers, config?.models?.find((entry) => entry.id === model)?.headers];
  return headers.some((value) => value && Object.keys(value).length > 0);
}

export const CUSTOM_KEY_CHECK_HEADERS = "Yoplai cannot check this key because the model config adds custom headers.";

export async function checkLiteralModelKey(provider: string, key: string, modelId: string, home = CONFIG_DIR): Promise<boolean | "custom_headers"> {
  if (!isLiteralKey(key)) return false;
  try {
    const config = await readModelConfig(home);
    const { runtime } = await createModelAuth({ home, submitted: { provider, key } });
    if (runtime.getError() || config !== await readModelConfig(home)) return false;
    if (config !== undefined && hasCustomHeaders(config, provider, modelId)) return "custom_headers";
    const model = runtime.getModel(provider, modelId);
    if (!model || !runtime.getProvider(provider)?.auth.apiKey) return false;
    return Boolean((await completeModelOnce(runtime, model, "Reply with OK.", undefined, 16)).trim());
  } catch {
    return false;
  }
}
