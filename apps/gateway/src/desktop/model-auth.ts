import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import fs from "node:fs/promises";
import type { AnyModel, Api, AssistantMessage, AuthResult, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime, ModelRuntimeAuthOverrides } from "@earendil-works/pi-coding-agent";
import { getProviderErrorCategory, isRetryableProviderError, type ModelSource } from "@yoplai/shared";
import { classifyRunFailure } from "@yoplai/shared/run-failure";
import { CONFIG_DIR } from "../config/index.js";
import { desktopEnabled } from "./guard.js";
import { isRelayEnabled } from "../relay/state.js";
import { CLAUDE_LOGIN_UNAVAILABLE, getExternalSources, type ExternalSource } from "./external-sources.js";
import { modelReadiness } from "./model-picker.js";
import { CODEX_EXPIRED, isLiteralKey } from "./literal-key.js";
export { isLiteralKey } from "./literal-key.js";

type AuthMode = "oauth" | "api_key";
export const canReadExternal = () => desktopEnabled() && isRelayEnabled();
export type ExternalCredential = { type: AuthMode; key: string; source: string };
export async function environmentCredential(runtime: ModelRuntime, provider: string, hasOwned: boolean, env?: Record<string, string>) {
  const { getEnvApiKey } = await import("@earendil-works/pi-ai/compat");
  const key = getEnvApiKey(provider, env);
  if (key && key !== "<authenticated>") return { key, native: false } as const;
  if (hasOwned) return undefined;
  const status = runtime.getProviderAuthStatus(provider);
  if (status.configured && status.source !== "stored" && status.source !== "runtime") return { native: true } as const;
}

type ReadExternal = (provider: string, model: AnyModel | undefined, mode?: AuthMode, onlySource?: ExternalSource) => Promise<ExternalCredential | undefined>;
const EXTERNAL_FAILURE = "The external login failed. Check the login in its app.";
const sourceLabels: Record<ModelSource, string> = {
  owned: "Yoplai credential", environment: "Environment credential",
  pi: "Pi CLI login", codex: "Codex CLI login", "claude-code": "Claude Code login", opencode: "OpenCode CLI login",
};
const unavailable = Object.fromEntries(Object.entries(sourceLabels).map(([source, label]) => [source,
  `${label} is not available. ${source === "environment" ? "Check your configuration" : "Sign in again"} or pick another source.`,
]));

export function isUnavailableModelSourceMessage(message: string | undefined): message is string {
  return message !== undefined && Object.values(unavailable).includes(message);
}

export function isSafeModelAccessError(message: string | undefined): message is string {
  return message === CODEX_EXPIRED || message === CLAUDE_LOGIN_UNAVAILABLE || isUnavailableModelSourceMessage(message);
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
    case "context_overflow": return category === "invalid_request" ? "400 invalid_request_error: context window exceeded." : "Context window exceeded.";
    case "quota":
      if (category === "invalid_request") return "400 invalid_request_error: provider billing refusal.";
      return isRetryableProviderError(response, message) ? "Provider quota exceeded." : "Provider billing refusal.";
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
  primarySource?: ModelSource;
  primaryModel?: string;
  readExternal?: ReadExternal;
  allowExternal?: boolean;
  refreshOnCreate?: boolean;
  submitted?: { provider: string; key: string };
} = {}) {
  const { ModelRuntime, readStoredCredential } = await import("@earendil-works/pi-coding-agent");
  const { getEnvApiKey } = await import("@earendil-works/pi-ai/compat");
  const home = options.home ?? CONFIG_DIR;
  const externalAvailable = () => options.allowExternal !== false && canReadExternal();
  const readExternal: ReadExternal = async (provider, model, mode, onlySource) => {
    if (!externalAvailable()) return undefined;
    const credential = await (options.readExternal ?? getExternalSources(home).resolve)(provider, model, mode, onlySource);
    return externalAvailable() ? credential : undefined;
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
  } : { authPath, modelsPath, refreshOnCreate: options.refreshOnCreate });
  const nativeAuth = runtime.getAuth.bind(runtime);
  const checkedModels = new Map<string, Model<Api>>();
  const request = new AsyncLocalStorage<{ external: boolean; source?: string }>();

  function pinnedSource(provider: string, model?: AnyModel) {
    if (provider === options.primaryProvider && (!options.primaryModel || !model || model.id === options.primaryModel)) return options.primarySource;
  }

  function externalAuth(external: ExternalCredential, model?: AnyModel): AuthResult {
    const headers = model && "reasoning" in model ? runtime.getCompatibilityRequestConfig(model).headers : undefined;
    return { auth: { apiKey: external.key, headers }, source: external.source };
  }

  async function resolvePinned(source: ModelSource, target: string | AnyModel, overrides?: ModelRuntimeAuthOverrides) {
    const provider = typeof target === "string" ? target : target.provider;
    const model = typeof target === "string" && options.primaryModel ? runtime.getModel(provider, options.primaryModel) : typeof target === "string" ? undefined : target;
    const native = (apiKey?: string, env = overrides?.env) => model
      ? nativeAuth(model, { ...overrides, apiKey, env })
      : nativeAuth(provider, { ...overrides, apiKey, env });
    let auth: AuthResult | undefined;
    let type: AuthMode = "api_key";
    try {
      if (source === "owned") {
        const owned = readStoredCredential(provider, authPath);
        if (owned) {
          type = owned.type;
          // Pi labels ambient Cloudflare keys as stored when a stored key expression fails.
          const mask = owned.type === "api_key" && !isLiteralKey(owned.key) &&
            (provider === "cloudflare-workers-ai" || provider === "cloudflare-ai-gateway");
          const missingKey = "yoplai-unavailable-cloudflare-key";
          auth = await native(undefined, mask ? { ...overrides?.env, CLOUDFLARE_API_KEY: missingKey } : undefined);
          if (mask && (auth?.auth.apiKey === missingKey || auth?.auth.headers?.["cf-aig-authorization"] === `Bearer ${missingKey}`)) auth = undefined;
          // Some Pi API-key methods consult ambient auth when a stored key resolves to nothing.
          if (auth?.source !== (type === "oauth" ? "OAuth" : "stored credential")) auth = undefined;
        }
      } else if (source === "environment") {
        const owned = readStoredCredential(provider, authPath);
        const credential = await environmentCredential(runtime, provider, Boolean(owned), overrides?.env);
        if (credential) {
          auth = await native(credential.native ? undefined : credential.key);
          if (credential.native && readStoredCredential(provider, authPath)) auth = undefined;
        }
      } else {
        const providerAuth = runtime.getProvider(provider)?.auth;
        const external = await readExternal(provider, model, providerAuth?.apiKey ? undefined : "oauth", source);
        if (external?.source === source) {
          type = external.type;
          auth = type === "api_key" ? await native(external.key) : externalAuth(external, model);
        }
      }
    } catch {
      overrides?.signal?.throwIfAborted();
    }
    if (!auth) throw new Error(unavailable[source]);
    return { type, auth };
  }

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
    const pinned = pinnedSource(provider, model);
    if (pinned) {
      if (scope) {
        scope.source = pinned;
        scope.external = pinned !== "owned" && pinned !== "environment";
      }
      return (await resolvePinned(pinned, target, overrides)).auth;
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
    if (externalAvailable()) {
      if (scope) scope.external = true;
      try {
        const externalMode = mode ?? (runtime.getProvider(provider)?.auth.apiKey ? undefined : "oauth");
        external = await readExternal(provider, model, externalMode);
      } catch (error) {
        if (!(error instanceof Error) || !isSafeModelAccessError(error.message)) throw error;
        if (externalAvailable()) externalDiagnosis = error;
      }
      if (scope) scope.external = external !== undefined;
    }
    if (external) {
      if (scope) scope.source = external.source;
      if (external.type === "api_key") return native({ ...overrides, apiKey: external.key });
      return externalAuth(external, model);
    }
    if (scope) scope.source = "environment";
    const key = mode === "api_key" ? getEnvApiKey(provider, overrides?.env) : undefined;
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
    const pinned = pinnedSource(provider, model);
    if (pinned) {
      await resolvePinned(pinned, model);
      checkedModels.set(provider, model);
      return;
    }
    const mode = provider === options.primaryProvider ? options.mode : undefined;
    if (!desktopEnabled() && mode === "api_key") {
      const stored = readStoredCredential(provider, authPath);
      const key = (stored?.type === "api_key" && stored.key) || getEnvApiKey(provider);
      if (key) {
        await runtime.setRuntimeApiKey(provider, key);
        checkedModels.set(provider, model);
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
  if (!desktopEnabled() && !options.submitted && !options.primarySource) return { runtime, resolveModelAuth, requireModelAuth };
  runtime.getAuth = resolveModelAuth;
  if (!options.submitted) {
    const nativeCheck = runtime.checkAuth.bind(runtime);
    runtime.checkAuth = async (provider, checkOptions) => {
      const model = checkedModels.get(provider);
      const pinned = pinnedSource(provider, model);
      if (pinned) {
        if (checkOptions?.signal?.aborted) return undefined;
        const { type } = await resolvePinned(pinned, model ?? provider, { signal: checkOptions?.signal });
        return { type, source: pinned };
      }
      const native = await nativeCheck(provider, checkOptions);
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
      // The provider can add diagnostics after emitting a clean partial.
      const clean = { ...message };
      delete clean.diagnostics;
      if (clean.stopReason === "error" || clean.errorMessage !== undefined) {
        clean.errorMessage = safeProviderError(model.provider, scope.external, status, clean.errorMessage);
      }
      return clean;
    }
    function remember(message: AssistantMessage) {
      if ((!desktopEnabled() && !options.primarySource) || !scope.source || message.stopReason === "aborted") return;
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

/** Plain request credentials for the versioned model adapter. */
export async function resolveGatewayModelCredentials(options: {
  provider: string;
  model: string;
  source?: ModelSource;
  mode?: AuthMode;
  env?: Record<string, string>;
  signal?: AbortSignal;
}) {
  const { runtime, resolveModelAuth } = await createModelAuth({
    primaryProvider: options.provider, primaryModel: options.model, primarySource: options.source,
    mode: options.mode, allowExternal: false, refreshOnCreate: false,
  });
  const model = runtime.getModel(options.provider, options.model);
  const auth = await resolveModelAuth(model ?? options.provider, {
    env: options.env, signal: options.signal,
  });
  if (!auth) return;
  return { apiKey: auth.auth.apiKey, headers: auth.auth.headers, baseUrl: auth.auth.baseUrl ?? model?.baseUrl, env: auth.env };
}

export async function completeModelOnce(runtime: Awaited<ReturnType<typeof createModelAuth>>["runtime"], model: Model<Api>, text: string, signal = AbortSignal.timeout(20_000), maxTokens = 256, onLength?: (text: string) => string) {
  const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: text, timestamp: Date.now() }] }, { maxTokens, signal, ...(model.provider === "openai-codex" && { transport: "sse" }) });
  if (result.stopReason === "aborted" || result.stopReason === "error") throw new Error(isSafeModelAccessError(result.errorMessage) ? result.errorMessage : "The model call failed.");
  const output = result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  return result.stopReason === "length" && onLength ? onLength(output) : output;
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
