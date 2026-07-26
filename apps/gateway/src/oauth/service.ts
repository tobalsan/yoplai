import {
  ByoCredentialSource,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  fetchAccountLabel,
  generatePkce,
  generateState,
  getOAuthProvider,
  OAuthRefreshError,
  refreshAccessToken,
  revokeToken,
  type ConnectionState,
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
import { OAuthConnectionStore, getOAuthConnectionStore } from "./store.js";

/** A short-lived pending authorization awaiting the provider callback. */
interface PendingAuth {
  agentId: string;
  provider: string;
  codeVerifier: string;
  redirectUri: string;
  scopes: string[];
  createdAt: number;
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
): Record<string, { clientId: string; clientSecret: string }> {
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
  const resolved: Record<string, { clientId: string; clientSecret: string }> = {};
  for (const [id, creds] of Object.entries(providers ?? {})) {
    if (!creds) continue;
    resolved[id] = {
      clientId: resolveRef(creds.clientId),
      clientSecret: resolveRef(creds.clientSecret),
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
 * agent/provider-scoped connection, and resolves fresh tokens for extensions.
 */
export class OAuthService {
  #store: OAuthConnectionStore;
  #fetch: OAuthFetch;
  #loadConfig: () => GatewayConfig;
  #pending = new Map<string, PendingAuth>();

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
  }): Promise<StartAuthResult> {
    const config = this.#loadConfig();
    const provider = this.#resolveProvider(input.provider);
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
    const scopes =
      input.scopes && input.scopes.length > 0
        ? input.scopes
        : provider.defaultScopes;

    this.#cleanupPending();
    this.#pending.set(state, {
      agentId: input.agentId,
      provider: provider.id,
      codeVerifier: pkce.verifier,
      redirectUri,
      scopes,
      createdAt: Date.now(),
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
    const pending = this.#pending.get(input.state);
    if (!pending) {
      throw new Error("Invalid or expired OAuth state");
    }
    if (pending.provider !== input.provider) {
      throw new Error("OAuth provider mismatch for state");
    }
    this.#pending.delete(input.state);

    const config = this.#loadConfig();
    const provider = this.#resolveProvider(input.provider);
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

    const account = await fetchAccountLabel(
      provider,
      tokens.accessToken,
      this.#fetch
    );

    const now = Date.now();
    const connection: OAuthConnection = {
      agentId: pending.agentId,
      provider: provider.id,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes.length > 0 ? tokens.scopes : pending.scopes,
      account,
      tokenType: tokens.tokenType,
      connectedAt: now,
      updatedAt: now,
    };
    return this.#store.save(connection);
  }

  /** Current connection status for a (agent, provider) pair. */
  getConnection(agentId: string, provider: string): OAuthConnection | undefined {
    return this.#store.get(agentId, provider);
  }

  /**
   * Disconnect a (agent, provider) pair: best-effort revoke the grant at the
   * provider so the agent's access is actually withdrawn upstream, then clear
   * the local record. The resulting state is `disconnected` (no stored record).
   */
  async disconnect(agentId: string, provider: string): Promise<void> {
    const connection = this.#store.get(agentId, provider);
    if (connection) {
      const descriptor = getOAuthProvider(provider);
      if (descriptor) {
        // Revoke the refresh token when present (revoking it invalidates the
        // whole grant on Google), else the access token. Best-effort.
        const token = connection.refreshToken ?? connection.accessToken;
        await revokeToken(descriptor, token, this.#fetch);
      }
    }
    this.#store.delete(agentId, provider);
  }

  /**
   * The lifecycle state of a (agent, provider) connection for the state machine
   * / UI: `disconnected` when nothing is stored, `needs_reconnect` when the
   * stored grant is unrecoverable, else `connected`.
   */
  getConnectionState(agentId: string, provider: string): ConnectionState {
    const connection = this.#store.get(agentId, provider);
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
    if (!connection.refreshToken) {
      return this.#markNeedsReconnect(connection);
    }

    try {
      const tokens = await refreshAccessToken(
        { provider, credentials, refreshToken: connection.refreshToken },
        this.#fetch
      );
      return this.#store.update(connection.agentId, provider.id, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? connection.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes.length > 0 ? tokens.scopes : connection.scopes,
        tokenType: tokens.tokenType ?? connection.tokenType,
        status: "connected",
      });
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
      });
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
    requirement: OAuthRequirement
  ): Promise<ResolvedOAuth> {
    const config = this.#loadConfig();
    const provider = getOAuthProvider(requirement.provider);
    if (!provider) {
      return {
        connected: false,
        provider: requirement.provider,
        reason: "provider_not_configured",
        message: `Unknown OAuth provider "${requirement.provider}".`,
      };
    }

    const credentials = await this.#credentialSource(config).getClientCredentials(
      provider.id
    );
    const authorizeUrl = `${this.#redirectUri(config, provider.id).replace(
      /\/callback$/,
      "/authorize"
    )}?agent=${encodeURIComponent(agentId)}`;

    if (!credentials) {
      return {
        connected: false,
        provider: provider.id,
        reason: "provider_not_configured",
        message: `No OAuth client configured for provider "${provider.id}".`,
        authorizeUrl,
      };
    }

    const stored = this.#store.get(agentId, provider.id);
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
      authorizeUrl,
    };

    // Already flagged unrecoverable: don't retry, surface the clean signal.
    if (stored.status === "needs_reconnect") {
      return needsReconnect;
    }

    const connection = await this.#ensureFreshToken(stored, provider, credentials);
    if (!connection) {
      return needsReconnect;
    }

    return {
      connected: true,
      provider: provider.id,
      accessToken: connection.accessToken,
      account: connection.account,
      scopes: connection.scopes,
      expiresAt: connection.expiresAt,
    };
  }
}

let defaultService: OAuthService | undefined;

export function getOAuthService(): OAuthService {
  defaultService ??= new OAuthService();
  return defaultService;
}
