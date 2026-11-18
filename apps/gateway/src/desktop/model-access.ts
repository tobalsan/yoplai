import type { Api, Model } from "@earendil-works/pi-ai";
import { Hono } from "hono";
import { z } from "zod";
import { getExternalSources, isExternalSource } from "./external-sources.js";
import { checkLiteralModelKey, createModelAuth, isLiteralKey } from "./model-auth.js";
import { createOAuthAttempts, isOAuthProvider, type openDesktopBrowser } from "./oauth-attempts.js";

export const CLAUDE_WARNING = "Anthropic terms do not allow a Claude subscription in third-party apps. Anthropic can limit or close your account. Use an API key to stay inside the terms.";
const confirm = { replace: z.boolean().optional() };
const startSchema = z.object({ ...confirm, warningAccepted: z.boolean().optional() }).strict();
const keySchema = z.object({ ...confirm, provider: z.string(), key: z.string().max(8192), checkOnly: z.boolean().optional() }).strict();
const consentSchema = z.object({ enabled: z.boolean(), warningAccepted: z.boolean().optional() }).strict();
const codeSchema = z.object({ code: z.string().min(1).max(8192) }).strict();
export const defaultModel = (models: readonly Model<Api>[]) => models.find((model) => !model.id.endsWith("-free") && Object.values(model.cost).some((cost) => typeof cost === "number" && cost > 0));

export function createModelAccessRoutes(home: string, deps: {
  createAuth?: typeof createModelAuth;
  checkKey?: typeof checkLiteralModelKey;
  open?: typeof openDesktopBrowser;
  external?: ReturnType<typeof getExternalSources>;
} = {}) {
  const routes = new Hono();
  const makeAuth = deps.createAuth ?? createModelAuth;
  const external = deps.external ?? getExternalSources(home);
  const checkKey = deps.checkKey ?? checkLiteralModelKey;
  let auth: ReturnType<typeof createModelAuth> | undefined;
  const getAuth = () => {
    auth ??= makeAuth({ home }).catch((error: unknown) => { auth = undefined; throw error; });
    return auth;
  };
  const attempts = createOAuthAttempts(async (provider, interaction) => {
    await (await getAuth()).runtime.login(provider, "oauth", interaction);
  }, deps.open);
  const locks = new Set<string>();
  routes.onError((_error, c) => c.json({ error: "model_access_failed", message: "The model access request failed." }, 500));
  routes.get("/", async (c) => {
    const { runtime } = await getAuth();
    return c.json({ external: await external.status(), owned: (await runtime.listCredentials()).filter((entry) => runtime.getProvider(entry.providerId)), oauthProviders: Object.keys({ "openai-codex": true, anthropic: true }), apiKeyProviders: runtime.getProviders().filter((provider) => provider.auth.apiKey && defaultModel(runtime.getModels(provider.id))).map(({ id, name }) => ({ id, name })) });
  });
  routes.post("/oauth/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!isOAuthProvider(provider)) return c.json({ error: "unknown_provider" }, 404);
    const body = startSchema.safeParse(c.req.raw.body ? await c.req.json().catch(() => undefined) : {});
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
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
    if (locks.has(provider) || attempts.busy(provider)) return c.json({ error: "provider_busy" }, 409);
    locks.add(provider);
    try {
      const { runtime } = await getAuth();
      const model = defaultModel(runtime.getModels(provider));
      if (!model || !runtime.getProvider(provider)?.auth.apiKey) return c.json({ error: "unknown_provider" }, 404);
      if (!checkOnly && !replace && (await runtime.listCredentials()).some((entry) => entry.providerId === provider)) return c.json({ error: "replacement_required", provider }, 409);
      if (!await checkKey(provider, key, model.id)) return c.json({ error: "key_check_failed", message: "The API key check failed." }, 422);
      if (!checkOnly) await runtime.login(provider, "api_key", {
        prompt: async (prompt) => {
          if (prompt.type !== "secret") throw new Error("The model access request failed.");
          return key;
        }, notify() {},
      });
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
    if (source === "claude-code" && body.data.enabled && body.data.warningAccepted !== true) return c.json({ error: "warning_required", message: CLAUDE_WARNING }, 409);
    return c.json(await external.enable(source, body.data.enabled));
  });
  routes.delete("/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (locks.has(provider) || attempts.busy(provider)) return c.json({ error: "provider_busy" }, 409);
    locks.add(provider);
    try {
      const { runtime } = await getAuth();
      if (!runtime.getProvider(provider)) return c.json({ error: "unknown_provider" }, 404);
      await runtime.logout(provider);
      return c.body(null, 204);
    } finally {
      locks.delete(provider);
    }
  });
  return routes;
}
