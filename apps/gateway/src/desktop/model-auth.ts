import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { AnyModel, Api, AssistantMessage, AuthResult, Model } from "@earendil-works/pi-ai";
import type { ModelRuntimeAuthOverrides } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR } from "../config/index.js";
import { desktopEnabled } from "./guard.js";
import { isRelayEnabled } from "../relay/state.js";
import { getExternalSources } from "./external-sources.js";
import { modelReadiness } from "./model-picker.js";
import { CODEX_EXPIRED, isLiteralKey } from "./literal-key.js";
export { isLiteralKey } from "./literal-key.js";

type AuthMode = "oauth" | "api_key";
export type ExternalCredential = { type: AuthMode; key: string; source: string };
type ReadExternal = (provider: string, model: AnyModel | undefined, mode?: AuthMode) => Promise<ExternalCredential | undefined>;
const EXTERNAL_FAILURE = "The external login failed. Check the login in its app.";

function safeExternalError(provider: string, message?: string): string {
  if (message === CODEX_EXPIRED || (provider === "openai-codex" && /\b401\b/.test(message ?? ""))) return CODEX_EXPIRED;
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
  const runtime = await ModelRuntime.create(options.submitted ? {
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => { throw new Error("This store cannot save keys."); },
      delete: async () => { throw new Error("This store cannot delete keys."); },
    },
  } : { authPath, modelsPath: path.join(home, "models.json") });
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
      return options.submitted.provider === provider && isLiteralKey(options.submitted.key) && runtime.getProvider(provider)?.auth.apiKey
        ? native({ ...overrides, apiKey: options.submitted.key }) : undefined;
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
      async onResponse(response, target) {
        status = response.status;
        await requestOptions?.onResponse?.(response, target);
      },
    }));
    const push = result.push.bind(result);
    const end = result.end.bind(result);
    const safe = (message: AssistantMessage): AssistantMessage => scope.external && message.stopReason === "error"
      ? { ...message, errorMessage: safeExternalError(model.provider, status === 401 ? "401" : message.errorMessage) }
      : message;
    function remember(message: AssistantMessage) {
      if (!desktopEnabled() || !scope.source || message.stopReason === "aborted") return;
      const ok = message.stopReason !== "error" && message.content.some((part) => part.type === "text" && part.text.trim());
      modelReadiness.record(scope.source, message.provider, message.model, ok);
    }
    result.push = (event) => {
      if (event.type === "done") remember(event.message);
      if (event.type === "error") remember(event.error);
      push(event.type === "error" ? { ...event, error: safe(event.error) } : event);
    };
    result.end = (message) => end(message ? safe(message) : undefined);
    return result;
  };

  return { runtime, resolveModelAuth, requireModelAuth };
}

export async function completeModelOnce(runtime: Awaited<ReturnType<typeof createModelAuth>>["runtime"], model: Model<Api>, text: string, signal = AbortSignal.timeout(20_000), maxTokens = 256) {
  const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: text, timestamp: Date.now() }] }, { maxTokens, signal, ...(model.provider === "openai-codex" && { transport: "sse" }) });
  if (result.stopReason === "aborted" || result.stopReason === "error") throw new Error(result.errorMessage === CODEX_EXPIRED ? CODEX_EXPIRED : "The model call failed.");
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

export async function checkLiteralModelKey(provider: string, key: string, modelId: string) {
  if (!isLiteralKey(key)) return false;
  const { runtime } = await createModelAuth({ submitted: { provider, key } });
  const model = runtime.getModel(provider, modelId);
  if (!model || !runtime.getProvider(provider)?.auth.apiKey) return false;
  try {
    return Boolean((await completeModelOnce(runtime, model, "Reply with OK.", undefined, 16)).trim());
  } catch {
    return false;
  }
}
