import path from "node:path";
import {
  sanitizeSensitiveText,
  type AgentConfig,
  type RequiredModelConfig,
} from "@yoplai/shared";
import { CONFIG_DIR } from "../../config/index.js";
import { logError, logWarn } from "../../logging.js";

// SDK's own OAuth refresh runs inside a 5-min validity window; require more
// than that here so the container never races the SDK's self-refresh (which
// would throw, since the token we hand it has no refresh token attached).
const MIN_OAUTH_VALIDITY_MS = 10 * 60 * 1000;

export type OAuthTokenEntry = { accessToken: string; expiresAt: number };

type StoredOAuthCredential = { type: "oauth"; access: string; expires: number };
type StoredCredential = StoredOAuthCredential | { type: "api_key" };

export type OAuthModelRuntime = {
  getAuth(
    providerId: string,
    overrides?: { minOAuthValidityMs?: number }
  ): Promise<unknown>;
};

export type OAuthTokensDeps = {
  authPath: string;
  createRuntime: (authPath: string) => Promise<OAuthModelRuntime>;
  readCredential: (
    providerId: string,
    authPath: string
  ) => Promise<StoredCredential | undefined>;
};

// One ModelRuntime per authPath, shared across calls, so the SDK's own
// per-provider refresh lock actually spans concurrent renewals instead of
// each caller racing a fresh instance against a single-use refresh token.
const runtimeCache = new Map<string, Promise<OAuthModelRuntime>>();

function getSharedRuntime(authPath: string): Promise<OAuthModelRuntime> {
  const cached = runtimeCache.get(authPath);
  if (cached) return cached;
  const created = (async () => {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    return ModelRuntime.create({
      authPath,
      modelsPath: path.join(CONFIG_DIR, "models.json"),
    });
  })();
  // Don't poison the cache with a failed creation; the next call retries.
  created.catch(() => runtimeCache.delete(authPath));
  runtimeCache.set(authPath, created);
  return created;
}

const defaultDeps: OAuthTokensDeps = {
  authPath: path.join(CONFIG_DIR, "auth.json"),
  createRuntime: getSharedRuntime,
  readCredential: async (providerId, authPath) => {
    const { readStoredCredential } = await import(
      "@earendil-works/pi-coding-agent"
    );
    return readStoredCredential(providerId, authPath) as
      | StoredCredential
      | undefined;
  },
};

function modelProviders(
  agent: AgentConfig,
  modelOverride?: RequiredModelConfig
): string[] {
  const providers = new Set<string>();
  if (modelOverride?.provider) {
    providers.add(modelOverride.provider);
  } else if (agent.model?.provider) {
    providers.add(agent.model.provider);
  }
  if (agent.auth?.mode === "oauth" && agent.fallback_model?.provider) {
    providers.add(agent.fallback_model.provider);
  }
  return [...providers];
}

/** Pre-refresh and return an OAuth access token for `provider`, if the stored credential is OAuth. */
async function refreshOAuthToken(
  provider: string,
  deps: OAuthTokensDeps,
  runtime: OAuthModelRuntime
): Promise<OAuthTokenEntry | undefined> {
  const cred = await deps.readCredential(provider, deps.authPath);
  if (cred?.type !== "oauth") return undefined;
  const auth = await runtime.getAuth(provider, {
    minOAuthValidityMs: MIN_OAUTH_VALIDITY_MS,
  });
  if (!auth) return undefined;
  // Re-read after getAuth (which refreshes in place if needed) and take
  // BOTH fields from that single read — access and expires are the matched
  // pair for whatever credential is now stored. Mixing getAuth's return
  // value with a separate re-read risks pairing a stale access token with a
  // later expiry if another refresh (e.g. a concurrent host run) lands
  // between the two reads.
  const refreshed = await deps.readCredential(provider, deps.authPath);
  if (refreshed?.type !== "oauth") return undefined;
  return { accessToken: refreshed.access, expiresAt: refreshed.expires };
}

// Coalesce concurrent refreshes of the same (authPath, provider) — e.g. two
// containers renewing near the 10-min boundary at once — into one call, so a
// single-use rotated refresh token can't be raced.
const inFlightRefreshes = new Map<string, Promise<OAuthTokenEntry | undefined>>();

// A refresh rejected with `invalid_grant` means the stored login is dead and
// only a human re-auth fixes it. Say so loudly, once per (authPath, provider)
// until a refresh succeeds again or an hour passes, so a burst of container
// launches does not spam the log.
const DEAD_LOGIN_LOG_COOLDOWN_MS = 60 * 60 * 1000;
const deadLoginLoggedAt = new Map<string, number>();

/**
 * Log-safe text of a refresh failure. The pi SDK keeps the provider's response
 * body in the error `cause` chain, so the chain is joined; that body can be
 * JSON carrying tokens, which the generic sanitizer does not catch when the
 * key is quoted, so quoted credential fields are redacted here as well.
 */
export function describeRefreshError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && parts.length < 5) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return sanitizeSensitiveText(parts.join(": "))
    .replace(
      /("[A-Za-z_-]*(?:token|secret|password|credential|api[-_]?key)[A-Za-z_-]*"\s*:\s*)"[^"]*"/gi,
      '$1"[REDACTED]"'
    )
    .slice(0, 1000);
}

function reportDeadLogin(key: string, provider: string, error: unknown): void {
  const refreshError = describeRefreshError(error);
  if (!refreshError.includes("invalid_grant")) return;
  const loggedAt = deadLoginLoggedAt.get(key);
  if (loggedAt !== undefined && Date.now() - loggedAt < DEAD_LOGIN_LOG_COOLDOWN_MS) {
    return;
  }
  deadLoginLoggedAt.set(key, Date.now());
  // Log only the redacted text: the raw error's message and stack can carry
  // the provider's response body.
  logError(`[oauth-tokens] ${provider} login expired, re-auth needed`, refreshError, {
    provider,
  });
}

function refreshOAuthTokenDeduped(
  provider: string,
  deps: OAuthTokensDeps,
  runtime: OAuthModelRuntime
): Promise<OAuthTokenEntry | undefined> {
  const key = `${deps.authPath}::${provider}`;
  const existing = inFlightRefreshes.get(key);
  if (existing) return existing;
  const pending = refreshOAuthToken(provider, deps, runtime)
    .then(
      (entry) => {
        deadLoginLoggedAt.delete(key);
        return entry;
      },
      (error: unknown) => {
        reportDeadLogin(key, provider, error);
        throw error;
      }
    )
    .finally(() => {
      inFlightRefreshes.delete(key);
    });
  inFlightRefreshes.set(key, pending);
  return pending;
}

/**
 * Pre-resolve fresh OAuth access tokens for a run's effective model provider
 * and any oauth-mode fallback provider, for the gateway to hand to a sandboxed
 * container. Explicit model overrides infer OAuth from their stored provider
 * credential; ordinary runs retain the agent's configured auth semantics.
 */
export async function resolveOAuthTokens(
  agent: AgentConfig,
  modelOverride?: RequiredModelConfig,
  deps: OAuthTokensDeps = defaultDeps
): Promise<Record<string, OAuthTokenEntry> | undefined> {
  if (!modelOverride && agent.auth?.mode !== "oauth") return undefined;
  const providers = modelProviders(agent, modelOverride);
  if (providers.length === 0) return undefined;

  let runtime: OAuthModelRuntime | undefined;
  const tokens: Record<string, OAuthTokenEntry> = {};
  for (const provider of providers) {
    try {
      const credential = await deps.readCredential(provider, deps.authPath);
      if (credential?.type !== "oauth") continue;
      runtime ??= await deps.createRuntime(deps.authPath);
      const entry = await refreshOAuthTokenDeduped(provider, deps, runtime);
      if (entry) tokens[provider] = entry;
    } catch (error) {
      // A refresh failure for one provider (IdP/network blip) must not block
      // container launch when the other provider (or a non-oauth fallback)
      // is healthy; the runner falls back to placeholder behavior for it.
      logWarn(
        "[oauth-tokens] failed to pre-refresh OAuth token; starting without it",
        {
          agentId: agent.id,
          provider,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

export type OAuthTokenLookup =
  | ({ status: "ok" } & OAuthTokenEntry)
  | { status: "forbidden" }
  | { status: "not_found" };

export type ResolveOAuthTokenDeps = OAuthTokensDeps;

const defaultResolveDeps: ResolveOAuthTokenDeps = defaultDeps;

/**
 * Renewal-endpoint variant: resolves a fresh OAuth access token for a provider
 * that was authorized and seeded for this specific container run.
 */
export async function resolveOAuthToken(
  provider: string,
  allowedProviders: readonly string[],
  deps: ResolveOAuthTokenDeps = defaultResolveDeps
): Promise<OAuthTokenLookup> {
  if (!allowedProviders.includes(provider)) return { status: "forbidden" };

  const runtime = await deps.createRuntime(deps.authPath);
  const entry = await refreshOAuthTokenDeduped(provider, deps, runtime);
  if (!entry) return { status: "not_found" };
  return { status: "ok", ...entry };
}
