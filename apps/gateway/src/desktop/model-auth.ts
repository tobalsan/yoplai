import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import fs from "node:fs/promises";
import type { AnyModel, Api, AssistantMessage, AuthResult, Model } from "@earendil-works/pi-ai";
import type { ModelRuntimeAuthOverrides } from "@earendil-works/pi-coding-agent";
import { getProviderErrorCategory, isRetryableProviderError } from "@yoplai/shared";
import { classifyRunFailure } from "@yoplai/shared/run-failure";
import { CONFIG_DIR } from "../config/index.js";
import { desktopEnabled } from "./guard.js";
import { isRelayEnabled } from "../relay/state.js";
import { CLAUDE_LOGIN_UNAVAILABLE, getExternalSources } from "./external-sources.js";
import { modelReadiness } from "./model-picker.js";
import { CODEX_EXPIRED, isLiteralKey } from "./literal-key.js";
export { isLiteralKey } from "./literal-key.js";

type AuthMode = "oauth" | "api_key";
export type ExternalCredential = { type: AuthMode; key: string; source: string };
type ReadExternal = (provider: string, model: AnyModel | undefined, mode?: AuthMode) => Promise<ExternalCredential | undefined>;
const EXTERNAL_FAILURE = "The external login failed. Check the login in its app.";

export function isSafeModelAccessError(message: string | undefined): message is string {
  return message === CODEX_EXPIRED || message === CLAUDE_LOGIN_UNAVAILABLE;
}

function safeProviderError(provider: string, external: boolean, status: number | undefined, message = ""): string {
  if (isSafeModelAccessError(message)) return message;
  const response = status && status >= 400 ? { status } : undefined;
  const category = getProviderErrorCategory(response, message);
  if (status === 401 || category === "auth") {
    return external && provider === "openai-codex" ? CODEX_EXPIRED : "401 Unauthorized: provider authentication failed.";
  }
  switch (classifyRunFailure(response, message)) {
    case "safety_refusal": return "The model refused to complete the request.";
    case "context_overflow": return category === "invalid_request" ? "400 invalid_request_error: context window exceeded." : "The context window was exceeded.";
    case "quota": return "Provider quota exceeded.";
    case "rate_limit": return "429 Provider rate limit.";
    case "overloaded": return "529 Provider overloaded.";
  }
  switch (category) {
    case "invalid_request": return "400 invalid_request_error.";
    case "timeout": return "Provider request timed out.";
    case "network": return "Provider network error.";
    case "unavailable": return "503 Provider temporarily unavailable.";
  }
  if (isRetryableProviderError(response, message)) return "503 Provider temporarily unavailable.";
  return external ? EXTERNAL_FAILURE : "The model call failed.";
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
  const canReadExternal = () => desktopEnabled() && isRelayEnabled();
  const readExternal: ReadExternal = async (provider, model, mode) => {
    if (!canReadExternal()) return undefined;
    const credential = await (options.readExternal ?? getExternalSources(home).resolve)(provider, model, mode);
    return canReadExternal() ? credential : undefined;
  };
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
  const checkedModels = new Map<string, Model<Api>>();
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
    let externalDiagnosis: Error | undefined;
    if (canReadExternal()) {
      if (scope) scope.external = true;
      try {
        const externalMode = mode ?? (runtime.getProvider(provider)?.auth.apiKey ? undefined : "oauth");
        external = await readExternal(provider, model, externalMode);
      } catch (error) {
        if (!(error instanceof Error) || !isSafeModelAccessError(error.message)) throw error;
        if (canReadExternal()) externalDiagnosis = error;
      }
      if (scope) scope.external = external !== undefined;
    }
    if (external) {
      if (scope) scope.source = external.source;
      if (external.type === "api_key") return native({ ...overrides, apiKey: external.key });
      const headers = model && "reasoning" in model ? runtime.getCompatibilityRequestConfig(model).headers : undefined;
      return { auth: { apiKey: external.key, headers }, source: external.source };
    }
    if (scope) scope.source = "environment";
    const key = mode === "api_key" ? getEnvApiKey(provider) : undefined;
    const auth = mode === "oauth" ? undefined
      : mode === "api_key" ? (key ? await native({ ...overrides, apiKey: key }) : undefined)
      : await native(overrides);
    if (!auth && externalDiagnosis) throw externalDiagnosis;
    return auth;
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
      if (auth?.auth.apiKey || Object.keys(auth?.auth.headers ?? {}).length || Object.keys(auth?.env ?? {}).length) {
        checkedModels.set(provider, model);
        return;
      }
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
  if (!options.submitted) {
    const nativeCheck = runtime.checkAuth.bind(runtime);
    runtime.checkAuth = async (provider, checkOptions) => {
      const native = await nativeCheck(provider, checkOptions);
      const model = checkedModels.get(provider);
      if (native || !model || checkOptions?.signal?.aborted) return native;
      // Pi checks the provider before a prompt or a model switch. Check the selected model again.
      const mode = provider === options.primaryProvider ? options.mode : undefined;
      const external = await readExternal(provider, model, mode);
      return external && { type: external.type, source: external.source };
    };
  }
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
      if (!message.diagnostics && message.stopReason !== "error" && message.errorMessage === undefined) return message;
      const clean = { ...message };
      delete clean.diagnostics;
      if (clean.stopReason === "error" || clean.errorMessage !== undefined) {
        clean.errorMessage = safeProviderError(model.provider, scope.external, status, clean.errorMessage);
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

export async function readModelConfig(home: string): Promise<string | undefined> {
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

export async function checkLiteralModelKey(provider: string, key: string, modelId: string, home = CONFIG_DIR, snapshot?: { config: string | undefined }): Promise<boolean | "custom_headers"> {
  if (!isLiteralKey(key)) return false;
  try {
    const config = snapshot ? snapshot.config : await readModelConfig(home);
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
