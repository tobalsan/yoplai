import {
  ByoCredentialSource,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  fetchAccountLabel,
  generatePkce,
  generateState,
  getOAuthProvider,
  materializeOAuthProvider,
  OAuthRefreshError,
  refreshAccessToken,
  revokeToken,
  type ConnectionState,
  type CredentialScope,
  type GatewayConfig,
  type OAuthClientCredentials,
  type OAuthConnection,
  type OAuthCredentialSource,
  type OAuthFetch,
  type OAuthProviderDescriptor,
  type OAuthRequirement,
  type ResolvedOAuth,
} from "@yoplai/shared";
import { loadConfig } from "../config/index.js";
import { resolveCredential } from "../credentials/resolver.js";
import { OAuthConnectionStore, connectionScope, getOAuthConnectionStore } from "./store.js";

/** A short-lived pending authorization awaiting the provider callback. */
interface PendingAuth {
  agentId: string;
  provider: string;
  codeVerifier: string;
  redirectUri: string;
  scopes: string[];
  scope: CredentialScope;
  createdAt: number;
  onComplete?: () => Promise<void>;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Resolve `$env:` refs in BYO provider credentials. The runtime `loadConfig()`
 * does not resolve env refs (that only happens on the async validate path, which
 * does not feed the runtime cache), so OAuth resolves them here — the same
 * `$env:` contract every other extension secret uses.
 */
function resolveProviderEnvRefs(
  providers: NonNullable<GatewayConfig["oauth"]>["providers"]
): Record<string, { clientId: string; clientSecret: string; subdomain?: string }> {
  const resolveRef = (value: string): string => {
    if (!value.startsWith("$env:")) return value;
    const envName = value.slice("$env:".length);
    const envValue = process.env[envName];
    if (envValue === undefined) {
      throw new Error(
        `Env var "${envName}" not set (referenced in oauth.providers config)`
      );
    }
    return envValue;
  };
  const resolved: Record<string, { clientId: string; clientSecret: string; subdomain?: string }> = {};
  for (const [id, creds] of Object.entries(providers ?? {})) {
    if (!creds) continue;
    resolved[id] = {
      clientId: resolveRef(creds.clientId),
      clientSecret: resolveRef(creds.clientSecret),
      ...(creds.subdomain ? { subdomain: resolveRef(creds.subdomain) } : {}),
    };
  }
  return resolved;
}

export interface OAuthServiceDeps {
  store?: OAuthConnectionStore;
  fetchImpl?: OAuthFetch;
  loadConfig?: () => GatewayConfig;
}

export interface StartAuthResult {
  authorizeUrl: string;
  state: string;
}

/**
 * Orchestrates the provider-agnostic OAuth flow: builds authorize URLs with
 * state + PKCE, exchanges callback codes for tokens, persists a single
 * agent/provider/scope connection, and resolves fresh tokens for extensions.
 */
export class OAuthService {
  #store: OAuthConnectionStore;
  #fetch: OAuthFetch;
  #loadConfig: () => GatewayConfig;
  #pending = new Map<string, PendingAuth>();
  /** In-flight refreshes by refresh token: rotating providers (Zendesk) reject a reused one. */
  #refreshing = new Map<string, Promise<OAuthConnection | undefined>>();

  constructor(deps: OAuthServiceDeps = {}) {
    this.#store = deps.store ?? getOAuthConnectionStore();
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#loadConfig = deps.loadConfig ?? loadConfig;
  }

  #credentialSource(config: GatewayConfig): OAuthCredentialSource {
    return new ByoCredentialSource(
      resolveProviderEnvRefs(config.oauth?.providers ?? {})
    );
  }

  /** Descriptor with `{subdomain}` filled from the provider's configured subdomain. */
  #materializeProvider(
    config: GatewayConfig,
    provider: OAuthProviderDescriptor
  ): OAuthProviderDescriptor {
    const subdomain = resolveProviderEnvRefs(config.oauth?.providers ?? {})[provider.id]
      ?.subdomain;
    return materializeOAuthProvider(provider, subdomain);
  }

  #redirectUri(config: GatewayConfig, provider: string): string {
    const base = (config.oauth?.redirectBaseUrl ?? "http://localhost:4000").replace(
      /\/+$/,
      ""
    );
    return `${base}/api/oauth/${provider}/callback`;
  }

  #resolveProvider(providerId: string): OAuthProviderDescriptor {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown OAuth provider "${providerId}"`);
    }
    return provider;
  }

  #cleanupPending(): void {
    const now = Date.now();
    for (const [state, pending] of this.#pending) {
      if (now - pending.createdAt > PENDING_TTL_MS) this.#pending.delete(state);
    }
  }

  /** Begin an authorization: returns the provider authorize URL to redirect to. */
  async startAuthorization(input: {
    agentId: string;
    provider: string;
    scopes?: string[];
    scope?: "team" | "personal";
    userId?: string;
    onComplete?: () => Promise<void>;
  }): Promise<StartAuthResult> {
    let scope: CredentialScope = { type: "team" };
    if (input.scope === "personal") {
      if (!input.userId) throw new Error("Personal credentials require a userId");
      scope = { type: "personal", userId: input.userId };
    }
    const config = this.#loadConfig();
    const provider = this.#materializeProvider(
      config,
      this.#resolveProvider(input.provider)
    );
    const credentials = await this.#credentialSource(config).getClientCredentials(
      provider.id
    );
    if (!credentials) {
      throw new Error(
        `No OAuth client configured for provider "${provider.id}". Set oauth.providers.${provider.id} in config.`
      );
    }

    const pkce = generatePkce();
    const state = generateState();
    const redirectUri = this.#redirectUri(config, provider.id);
    // Widen, never narrow: other agents may depend on scopes already granted.
    const existing = this.#store.get(input.agentId, provider.id, scope);
    const requested =
      input.scopes && input.scopes.length > 0
        ? input.scopes
        : provider.defaultScopes;
    const scopes = [...new Set([...(existing?.scopes ?? []), ...requested])];

    this.#cleanupPending();
    this.#pending.set(state, {
      agentId: input.agentId,
      provider: provider.id,
      codeVerifier: pkce.verifier,
      redirectUri,
      scopes,
      scope,
      createdAt: Date.now(),
      onComplete: input.onComplete,
    });

    const authorizeUrl = buildAuthorizeUrl({
      provider,
      clientId: credentials.clientId,
      redirectUri,
      scopes,
      state,
      codeChallenge: pkce.challenge,
    });
    return { authorizeUrl, state };
  }

  /** Handle the provider callback: exchange the code and persist the connection. */
  async handleCallback(input: {
    provider: string;
    code: string;
    state: string;
  }): Promise<OAuthConnection> {
    this.#cleanupPending();
    const pending = this.#pending.get(input.state);
    if (!pending) {
      throw new Error("Invalid or expired OAuth state");
    }
    if (pending.provider !== input.provider) {
      throw new Error("OAuth provider mismatch for state");
    }
    this.#pending.delete(input.state);

    const config = this.#loadConfig();
    const provider = this.#materializeProvider(
      config,
      this.#resolveProvider(input.provider)
    );
    const credentials = await this.#credentialSource(config).getClientCredentials(
      provider.id
    );
    if (!credentials) {
      throw new Error(`No OAuth client configured for provider "${provider.id}"`);
    }

    const tokens = await exchangeCodeForTokens(
      {
        provider,
        credentials,
        code: input.code,
        redirectUri: pending.redirectUri,
        codeVerifier: pending.codeVerifier,
      },
      this.#fetch
    );

    const account =
      tokens.account ??
      (await fetchAccountLabel(provider, tokens.accessToken, this.#fetch));

    const now = Date.now();
    const connection: OAuthConnection = {
      agentId: pending.agentId,
      provider: provider.id,
      scope: pending.scope.type,
      userId: pending.scope.type === "personal" ? pending.scope.userId : undefined,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes.length > 0 ? tokens.scopes : pending.scopes,
      account,
      tokenType: tokens.tokenType,
      connectedAt: now,
      updatedAt: now,
    };
    const saved = this.#store.save(connection);
    if (pending.onComplete) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          pending.onComplete(),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); }),
        ]);
      } catch {
        // A failed notification must not undo a successfully saved connection.
        console.warn("OAuth connected, but completion notification failed");
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return saved;
  }

  /** Current connection status for a (agent, provider) pair. */
  getConnection(agentId: string, provider: string, requesterUserId?: string): OAuthConnection | undefined {
    const resolved = resolveCredential<OAuthConnection>({
      store: { get: (key) => this.#store.get(key.agentId, key.integration, key.scope) },
      agentId,
      integration: provider,
      requesterUserId,
      connectUrl: "",
    });
    return resolved.connected ? resolved.payload : undefined;
  }

  getScopedConnection(agentId: string, provider: string, scope: CredentialScope): OAuthConnection | undefined {
    return this.#store.get(agentId, provider, scope);
  }

  async #revokeUpstream(descriptor: OAuthProviderDescriptor, token: string): Promise<void> {
    try {
      const credentials = await this.#credentialSource(this.#loadConfig()).getClientCredentials(
        descriptor.id
      );
      await revokeToken(descriptor, token, this.#fetch, credentials);
    } catch {
      // Best-effort: a failed revoke must not surface after local removal.
    }
  }

  /**
   * Disconnect a (agent, provider) pair: best-effort revoke the grant at the
   * provider after clearing the local record immediately. Upstream outages
   * cannot delay removal or the next request's fallback to team credentials.
   */
  async disconnect(agentId: string, provider: string, scope: CredentialScope = { type: "team" }): Promise<void> {
    const connection = this.#store.get(agentId, provider, scope);
    // Stop resolving this grant before any potentially slow upstream revocation.
    this.#store.delete(agentId, provider, scope);
    if (connection) {
      const descriptor = getOAuthProvider(provider);
      if (descriptor) {
        // Revoke the refresh token when present (revoking it invalidates the
        // whole grant on Google), else the access token. Best-effort.
        const token = connection.refreshToken ?? connection.accessToken;
        void this.#revokeUpstream(descriptor, token);
      }
    }
  }

  /**
   * The lifecycle state of a (agent, provider) connection for the state machine
   * / UI: `disconnected` when nothing is stored, `needs_reconnect` when the
   * stored grant is unrecoverable, else `connected`.
   */
  getConnectionState(agentId: string, provider: string, requesterUserId?: string): ConnectionState {
    const connection = this.getConnection(agentId, provider, requesterUserId);
    if (!connection) return "disconnected";
    return connection.status === "needs_reconnect"
      ? "needs_reconnect"
      : "connected";
  }

  /** Skew before expiry at which we proactively refresh the access token. */
  static readonly REFRESH_SKEW_MS = 60_000;

  /**
   * Ensure the stored connection carries a fresh, usable access token,
   * refreshing silently while the refresh token is valid. On an unrecoverable
   * refresh failure it flips the connection to `needs_reconnect` and returns
   * undefined; on a transient failure it keeps the (still-usable) grant.
   */
  async #ensureFreshToken(
    connection: OAuthConnection,
    provider: OAuthProviderDescriptor,
    credentials: OAuthClientCredentials
  ): Promise<OAuthConnection | undefined> {
    const expiringSoon =
      typeof connection.expiresAt === "number" &&
      connection.expiresAt - OAuthService.REFRESH_SKEW_MS <= Date.now();
    if (!expiringSoon) return connection;

    // Expiring/expired but no refresh token: the grant is unrecoverable.
    const refreshToken = connection.refreshToken;
    if (!refreshToken) {
      return this.#markNeedsReconnect(connection);
    }

    const inFlight = this.#refreshing.get(refreshToken);
    if (inFlight) return inFlight;
    const refresh = this.#refresh(connection, provider, credentials, refreshToken)
      .finally(() => this.#refreshing.delete(refreshToken));
    this.#refreshing.set(refreshToken, refresh);
    return refresh;
  }

  async #refresh(
    connection: OAuthConnection,
    provider: OAuthProviderDescriptor,
    credentials: OAuthClientCredentials,
    refreshToken: string
  ): Promise<OAuthConnection | undefined> {
    try {
      const tokens = await refreshAccessToken(
        { provider, credentials, refreshToken },
        this.#fetch
      );
      return this.#store.update(connection.agentId, provider.id, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes.length > 0 ? tokens.scopes : connection.scopes,
        tokenType: tokens.tokenType ?? connection.tokenType,
        status: "connected",
      }, connectionScope(connection));
    } catch (error) {
      if (error instanceof OAuthRefreshError && !error.unrecoverable) {
        // Transient failure (network / 5xx): keep the grant untouched. If the
        // token is still within its lifetime, hand it back; otherwise report
        // needs_reconnect for this call without discarding the connection.
        if (
          typeof connection.expiresAt === "number" &&
          connection.expiresAt <= Date.now()
        ) {
          return undefined;
        }
        return connection;
      }
      // Unrecoverable (revoked / expired-beyond-refresh): flip state.
      return this.#markNeedsReconnect(connection);
    }
  }

  #markNeedsReconnect(connection: OAuthConnection): undefined {
    if (connection.status !== "needs_reconnect") {
      this.#store.update(connection.agentId, connection.provider, {
        status: "needs_reconnect",
      }, connectionScope(connection));
    }
    return undefined;
  }

  /**
   * Resolve a fresh token for an extension's declared requirement. Returns a
   * structured not-connected signal instead of throwing when there is no
   * connection or the provider is not configured.
   *
   * Tokens refresh silently while the refresh token is valid; the moment a grant
   * is unrecoverable the connection flips to `needs_reconnect` and the agent
   * gets the clean not-connected signal instead of a cryptic error.
   */
  async resolveToken(
    agentId: string,
    requirement: OAuthRequirement,
    requesterUserId?: string
  ): Promise<ResolvedOAuth> {
    const config = this.#loadConfig();
    const baseProvider = getOAuthProvider(requirement.provider);
    if (!baseProvider) {
      return {
        connected: false,
        provider: requirement.provider,
        reason: "provider_not_configured",
        message: `Unknown OAuth provider "${requirement.provider}".`,
      };
    }
    let provider: OAuthProviderDescriptor;
    try {
      provider = this.#materializeProvider(config, baseProvider);
    } catch (error) {
      return {
        connected: false,
        provider: baseProvider.id,
        reason: "provider_not_configured",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const credentials = await this.#credentialSource(config).getClientCredentials(
      provider.id
    );
    const authorizeBaseUrl = `${this.#redirectUri(config, provider.id).replace(
      /\/callback$/,
      "/authorize"
    )}?agent=${encodeURIComponent(agentId)}`;

    const authorizeUrl = requirement.scopes?.length
      ? `${authorizeBaseUrl}&scopes=${encodeURIComponent(requirement.scopes.join(" "))}`
      : authorizeBaseUrl;

    if (!credentials) {
      return {
        connected: false,
        provider: provider.id,
        reason: "provider_not_configured",
        message: `No OAuth client configured for provider "${provider.id}".`,
        authorizeUrl,
      };
    }

    const stored = this.getConnection(agentId, provider.id, requesterUserId);
    if (!stored) {
      return {
        connected: false,
        provider: provider.id,
        reason: "not_connected",
        message: `${provider.displayName} is not connected for agent "${agentId}".`,
        authorizeUrl,
      };
    }

    const needsReconnect = {
      connected: false as const,
      provider: provider.id,
      reason: "needs_reconnect" as const,
      message: `${provider.displayName} needs to be reconnected for agent "${agentId}".`,
      authorizeUrl: `${authorizeUrl}&scope=${stored.scope ?? "team"}`,
    };

    // Already flagged unrecoverable: don't retry, surface the clean signal.
    if (stored.status === "needs_reconnect") {
      return needsReconnect;
    }

    const connection = await this.#ensureFreshToken(stored, provider, credentials);
    if (!connection) {
      return needsReconnect;
    }

    if (requirement.scopes?.some((scope) => !connection.scopes.includes(scope))) {
      return {
        connected: false,
        provider: provider.id,
        reason: "insufficient_scope",
        message: `${provider.displayName} needs additional permissions for agent "${agentId}". Reconnect to grant the requested scopes.`,
        authorizeUrl: `${authorizeUrl}&scope=${stored.scope ?? "team"}`,
      };
    }

    return {
      connected: true,
      provider: provider.id,
      accessToken: connection.accessToken,
      account: connection.account,
      scopes: connection.scopes,
      expiresAt: connection.expiresAt,
      ...(provider.apiBaseUrl ? { apiBaseUrl: provider.apiBaseUrl } : {}),
    };
  }
}

let defaultService: OAuthService | undefined;

export function getOAuthService(): OAuthService {
  defaultService ??= new OAuthService();
  return defaultService;
}
