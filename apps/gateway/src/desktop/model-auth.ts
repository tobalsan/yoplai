import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { AnyModel, Api, AssistantMessage, AuthResult, Model } from "@earendil-works/pi-ai";
import type { ModelRuntimeAuthOverrides } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR } from "../config/index.js";
import { desktopEnabled } from "./guard.js";
import { isRelayEnabled } from "../relay/state.js";
import { getExternalSources } from "./external-sources.js";
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
} = {}) {
  const { ModelRuntime, readStoredCredential } = await import("@earendil-works/pi-coding-agent");
  const { getEnvApiKey } = await import("@earendil-works/pi-ai/compat");
  const home = options.home ?? CONFIG_DIR;
  const readExternal = options.readExternal ?? (isRelayEnabled() ? getExternalSources(home).resolve : undefined);
  const authPath = path.join(home, "auth.json");
  const runtime = await ModelRuntime.create({ authPath, modelsPath: path.join(home, "models.json") });
  const nativeAuth = runtime.getAuth.bind(runtime);
  const request = new AsyncLocalStorage<{ external: boolean }>();

  async function resolveModelAuth(target: string | AnyModel, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined> {
    const model = typeof target === "string" ? undefined : target;
    const provider = typeof target === "string" ? target : target.provider;
    const mode = provider === options.primaryProvider ? options.mode : undefined;
    const credential = readStoredCredential(provider, authPath);
    const native = (override?: ModelRuntimeAuthOverrides) => typeof target === "string" ? nativeAuth(target, override) : nativeAuth(target, override);
    const explicit = overrides?.apiKey;
    const ownedKey = mode === "api_key" && credential?.type === "api_key" ? credential.key : undefined;
    if (explicit !== undefined || ownedKey) return native({ ...overrides, apiKey: explicit ?? ownedKey });
    if (credential && (!mode || mode === credential.type)) return native(overrides);

    const scope = request.getStore();
    let external: ExternalCredential | undefined;
    if (desktopEnabled() && readExternal) {
      if (scope) scope.external = true;
      external = await readExternal(provider, model, mode);
      if (scope) scope.external = external !== undefined;
    }
    if (external) {
      if (external.type === "api_key") return native({ ...overrides, apiKey: external.key });
      const headers = model && "reasoning" in model ? runtime.getCompatibilityRequestConfig(model).headers : undefined;
      return { auth: { apiKey: external.key, headers }, source: external.source };
    }
    if (mode === "oauth") return undefined;
    if (mode === "api_key") {
      const key = getEnvApiKey(provider);
      return key ? native({ ...overrides, apiKey: key }) : undefined;
    }
    return native(overrides);
  }

  runtime.getAuth = resolveModelAuth;
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, requestOptions) => {
    const scope = { external: false };
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
    result.push = (event) => push(event.type === "error" ? { ...event, error: safe(event.error) } : event);
    result.end = (message) => end(message ? safe(message) : undefined);
    return result;
  };

  return { runtime, resolveModelAuth };
}

export async function completeModelOnce(runtime: Awaited<ReturnType<typeof createModelAuth>>["runtime"], model: Model<Api>, text: string, signal = AbortSignal.timeout(20_000)) {
  const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: text, timestamp: Date.now() }] }, { maxTokens: 256, signal });
  if (result.stopReason === "aborted" || result.stopReason === "error") throw new Error(result.errorMessage === CODEX_EXPIRED ? CODEX_EXPIRED : "The model call failed.");
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

export async function checkLiteralModelKey(provider: string, key: string, modelId: string) {
  if (!isLiteralKey(key)) return false;
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async () => { throw new Error("This store cannot save keys."); },
    delete: async () => { throw new Error("This store cannot delete keys."); },
  } });
  const model = runtime.getModel(provider, modelId);
  if (!model || !runtime.getProvider(provider)?.auth.apiKey) return false;
  try {
    const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] }, {
      apiKey: key, maxTokens: 16, signal: AbortSignal.timeout(20_000),
    });
    return result.stopReason !== "error" && result.stopReason !== "aborted";
  } catch {
    return false;
  }
}
