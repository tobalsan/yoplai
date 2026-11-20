import { defaultModel, freeModel, modelReadiness, pickerModel } from "./model-picker.js";
import { Hono } from "hono";
import { z } from "zod";
import { getExternalSources, isAnthropicOAuthToken, isExternalSource, selectExternalCredential } from "./external-sources.js";
import { checkLiteralModelKey, completeModelOnce, createModelAuth, CUSTOM_KEY_CHECK_HEADERS, isLiteralKey, isSafeModelAccessError, readModelConfig } from "./model-auth.js";
import { createOAuthAttempts, isOAuthProvider, OAUTH_HOSTS, type openDesktopBrowser } from "./oauth-attempts.js";

export const CLAUDE_WARNING = "Anthropic terms do not allow a Claude subscription in third-party apps. Anthropic can limit or close your account. Use an API key to stay inside the terms.";
const confirm = { replace: z.boolean().optional() };
const startSchema = z.object({ ...confirm, warningAccepted: z.boolean().optional() }).strict();
const keySchema = z.object({ ...confirm, provider: z.string(), key: z.string().max(8192), checkOnly: z.boolean().optional() }).strict();
const consentSchema = z.object({ enabled: z.boolean(), warningAccepted: z.boolean().optional() }).strict();
const codeSchema = z.object({ code: z.string().min(1).max(8192) }).strict();
// Pi does not expose the prompts that each API key login needs.
const API_KEY_LOGIN_REQUIRES_MORE_INPUT = new Set([
  "amazon-bedrock", "cloudflare-ai-gateway", "cloudflare-workers-ai", "google-vertex",
]);
const modelSchema = z.object({ provider: z.string(), model: z.string() }).strict();

type ModelAccessDeps = {
  createAuth?: typeof createModelAuth;
  checkKey?: typeof checkLiteralModelKey;
  open?: typeof openDesktopBrowser;
  external?: ReturnType<typeof getExternalSources>;
};

export function createModelAccess(home: string, deps: ModelAccessDeps = {}) {
  const routes = new Hono();
  const makeAuth = deps.createAuth ?? createModelAuth;
  const external = deps.external ?? getExternalSources(home);
  const checkKey = deps.checkKey ?? checkLiteralModelKey;
  const getAuth = () => makeAuth({ home, readExternal: external.resolve });
  const attempts = createOAuthAttempts(async (provider, interaction) => {
    await (await getAuth()).runtime.login(provider, "oauth", interaction);
    modelReadiness.clear("owned", provider);
  }, deps.open);
  const locks = new Set<string>();
  routes.onError((_error, c) => c.json({ error: "model_access_failed", message: "The model access request failed." }, 500));
  routes.get("/", async (c) => {
    const { runtime } = await getAuth();
    const owned = (await runtime.listCredentials()).filter((entry) => runtime.getProvider(entry.providerId));
    const apiKeyProviders = runtime.getProviders()
      .filter((provider) => !API_KEY_LOGIN_REQUIRES_MORE_INPUT.has(provider.id) && provider.auth.apiKey?.login && defaultModel(runtime.getModels(provider.id)))
      .map(({ id, name }) => ({ id, name }));
    return c.json({ external: await external.status(), owned, oauthProviders: Object.keys(OAUTH_HOSTS), apiKeyProviders, attempts: attempts.openAttempts() });
  });
  routes.post("/oauth/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!isOAuthProvider(provider)) return c.json({ error: "unknown_provider" }, 404);
    const body = startSchema.safeParse(c.req.raw.body && !c.req.raw.bodyUsed ? await c.req.json().catch(() => undefined) : {});
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const open = attempts.resume(provider);
    if (open) return c.json({ ...open, resumed: true }, 200);
    if (provider === "anthropic" && body.data.warningAccepted !== true) return c.json({ error: "warning_required", message: CLAUDE_WARNING }, 409);
    if (locks.has(provider) || attempts.busy(provider)) return c.json({ error: "provider_busy" }, 409);
    locks.add(provider);
    try {
      const owned = await (await getAuth()).runtime.listCredentials();
      if (!body.data.replace && owned.some((entry) => entry.providerId === provider)) return c.json({ error: "replacement_required", provider }, 409);
      return c.json(attempts.start(provider), 202);
    } finally {
      locks.delete(provider);
    }
  });
  routes.get("/oauth/attempts/:handle", (c) => {
    const attempt = attempts.status(c.req.param("handle"));
    return attempt ? c.json(attempt) : c.json({ error: "attempt_not_found" }, 404);
  });
  routes.post("/oauth/attempts/:handle/answer", async (c) => {
    const body = codeSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const attempt = attempts.answer(c.req.param("handle"), body.data.code);
    return attempt ? c.json(attempt) : c.json({ error: "prompt_unavailable" }, 409);
  });
  routes.post("/oauth/attempts/:handle/cancel", (c) => {
    const attempt = attempts.cancel(c.req.param("handle"));
    return attempt ? c.json(attempt) : c.json({ error: "attempt_not_found" }, 404);
  });
  routes.post("/api-key", async (c) => {
    const body = keySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success || !isLiteralKey(body.data.key)) return c.json({ error: "invalid_key", message: "Enter a literal API key." }, 400);
    const { provider, key, checkOnly, replace } = body.data;
    if (isAnthropicOAuthToken(key)) {
      return c.json({ error: "subscription_credential", message: "Use Sign in with Claude for a Claude subscription, or enter an API key." }, 422);
    }
    if (API_KEY_LOGIN_REQUIRES_MORE_INPUT.has(provider)) {
      return c.json({ error: "unsupported_provider", message: "This provider needs more than an API key. Use another provider." }, 422);
    }
    if (locks.has(provider) || attempts.busy(provider)) return c.json({ error: "provider_busy" }, 409);
    locks.add(provider);
    try {
      const config = await readModelConfig(home);
      const { runtime } = await getAuth();
      const model = defaultModel(runtime.getModels(provider));
      if (!model || !runtime.getProvider(provider)?.auth.apiKey?.login) return c.json({ error: "unknown_provider" }, 404);
      if (!checkOnly && !replace && (await runtime.listCredentials()).some((entry) => entry.providerId === provider)) return c.json({ error: "replacement_required", provider }, 409);
      const checked = await checkKey(provider, key, model.id, home, { config });
      if (checked !== true) return c.json({ error: "key_check_failed", message: checked === "custom_headers" ? CUSTOM_KEY_CHECK_HEADERS : "The API key check failed." }, 422);
      if (!checkOnly) await runtime.login(provider, "api_key", {
        prompt: async (prompt) => {
          if (prompt.type !== "secret") throw new Error("The model access request failed.");
          return key;
        }, notify() {},
      });
      if (!checkOnly) {
        modelReadiness.clear("owned", provider);
        modelReadiness.record("owned", provider, model.id, true);
      }
      return c.json({ provider, model: model.id, ready: true, saved: !checkOnly });
    } finally {
      locks.delete(provider);
    }
  });
  routes.post("/external/:source", async (c) => {
    const source = c.req.param("source");
    if (!isExternalSource(source)) return c.json({ error: "unknown_source" }, 404);
    const body = consentSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const result = await external.enable(source, body.data.enabled, body.data.warningAccepted);
    if ("warningRequired" in result) return c.json({ error: "warning_required", message: CLAUDE_WARNING }, 409);
    modelReadiness.clear(source);
    return c.json(result);
  });
  const modelsFor = async (runtime: Awaited<ReturnType<typeof getAuth>>["runtime"], onlyProvider?: string) => {
    const owned = await runtime.listCredentials();
    const externalStatus = await external.status();
    const groups = await Promise.all(runtime.getProviders().filter((provider) => !onlyProvider || provider.id === onlyProvider).map(async (provider) => {
      const own = owned.find((credential) => credential.providerId === provider.id);
      const catalog = own ? await runtime.getAvailable(provider.id) : runtime.getModels(provider.id);
      const included = catalog.filter(pickerModel);
      const eligible = await Promise.all(included.map(async (model) => {
        let source: string | undefined;
        if (own) {
          if (own.type === "oauth" ? provider.auth.oauth : provider.auth.apiKey) source = "owned";
        } else {
          const selected = await selectExternalCredential(provider.id, model, provider.auth.apiKey ? undefined : "oauth", (source) => {
            const status = externalStatus.find((row) => row.source === source && row.enabled);
            return status?.providers.find((entry) => entry.provider === provider.id);
          });
          source = selected?.source;
          if (!source && runtime.getProviderAuthStatus(provider.id).configured) source = "environment";
        }
        return source && { provider: provider.id, model: model.id, name: model.name, source, ready: modelReadiness.isReady(source, provider.id, model.id), default: false, free: freeModel(model) };
      }));
      const rows = eligible.filter((row) => !!row);
      for (const source of new Set(rows.map((row) => row.source))) {
        const choice = defaultModel(included.filter((model) => rows.some((row) => row.source === source && row.model === model.id)));
        const row = rows.find((row) => row.source === source && row.model === choice?.id);
        if (row) row.default = true;
      }
      return rows;
    }));
    return groups.flat();
  };
  const listModels = async () => modelsFor((await getAuth()).runtime);
  routes.get("/models", async (c) => c.json({ models: await listModels() }));
  routes.post("/models/check", async (c) => {
    const body = modelSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const { provider, model: id } = body.data;
    const { runtime } = await getAuth();
    const model = runtime.getModel(provider, id);
    if (!model || !pickerModel(model)) return c.json({ error: "unknown_model" }, 404);
    if (!(await modelsFor(runtime, provider)).some((row) => row.model === id)) return c.json({ error: "unknown_model" }, 404);
    try {
      const text = await completeModelOnce(runtime, model, "Reply with OK.", undefined, 16);
      if (text.trim()) return c.json({ provider, model: id, ready: true });
    } catch (error) {
      if (error instanceof Error && isSafeModelAccessError(error.message)) return c.json({ provider, model: id, ready: false, message: error.message }, 422);
    }
    return c.json({ provider, model: id, ready: false, message: "The model check failed." }, 422);
  });
  routes.delete("/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (locks.has(provider) || attempts.busy(provider)) return c.json({ error: "provider_busy" }, 409);
    locks.add(provider);
    try {
      const { runtime } = await getAuth();
      if (!runtime.getProvider(provider)) return c.json({ error: "unknown_provider" }, 404);
      await runtime.logout(provider);
      modelReadiness.clear("owned", provider);
      return c.body(null, 204);
    } finally {
      locks.delete(provider);
    }
  });
  return { routes, getAuth, listModels };
}
