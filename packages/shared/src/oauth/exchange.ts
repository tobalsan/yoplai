import type { OAuthClientCredentials } from "./credentials.js";
import type { OAuthProviderDescriptor } from "./types.js";

/** Injectable fetch so tests can fake Google's token/userinfo endpoints. */
export type OAuthFetch = typeof fetch;

export interface TokenExchangeInput {
  provider: OAuthProviderDescriptor;
  credentials: OAuthClientCredentials;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes: string[];
  tokenType?: string;
  /** Account label from the provider's `accountFromTokenResponse` hook, if any. */
  account?: string;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** Token-endpoint client auth: Basic header or credentials in the form body. */
function applyClientAuth(
  provider: OAuthProviderDescriptor,
  credentials: OAuthClientCredentials,
  body: URLSearchParams,
  headers: Record<string, string>
): void {
  if (provider.tokenAuth === "basic") {
    const encoded = Buffer.from(
      `${credentials.clientId}:${credentials.clientSecret}`
    ).toString("base64");
    headers.Authorization = `Basic ${encoded}`;
    return;
  }
  body.set("client_id", credentials.clientId);
  body.set("client_secret", credentials.clientSecret);
}

/**
 * Exchange an authorization code for tokens at the provider's token endpoint.
 * Provider-agnostic: everything provider-specific comes from the descriptor.
 */
export async function exchangeCodeForTokens(
  input: TokenExchangeInput,
  fetchImpl: OAuthFetch = fetch
): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  applyClientAuth(input.provider, input.credentials, body, headers);

  const response = await fetchImpl(input.provider.tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  const raw = (await response.json().catch(() => ({}))) as RawTokenResponse;
  if (!response.ok || raw.error || !raw.access_token) {
    const detail = raw.error_description || raw.error || `HTTP ${response.status}`;
    throw new Error(`OAuth token exchange failed: ${detail}`);
  }

  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt:
      typeof raw.expires_in === "number"
        ? Date.now() + raw.expires_in * 1000
        : undefined,
    scopes: raw.scope ? raw.scope.split(/\s+/).filter(Boolean) : [],
    tokenType: raw.token_type,
    account: input.provider.accountFromTokenResponse?.(raw),
  };
}

export interface TokenRefreshInput {
  provider: OAuthProviderDescriptor;
  credentials: OAuthClientCredentials;
  refreshToken: string;
}

/**
 * Thrown when the provider explicitly rejects a refresh (revoked / expired
 * grant). This is the unrecoverable case that flips a connection to
 * `needs_reconnect` — distinct from a transient network/5xx error, which should
 * not discard a still-valid grant.
 */
export class OAuthRefreshError extends Error {
  /** True when the grant is unrecoverable and the user must reconnect. */
  readonly unrecoverable: boolean;
  constructor(message: string, unrecoverable: boolean) {
    super(message);
    this.name = "OAuthRefreshError";
    this.unrecoverable = unrecoverable;
  }
}

/**
 * Exchange a refresh token for a fresh access token at the provider's token
 * endpoint. Provider-agnostic.
 *
 * Only an explicit OAuth grant error (e.g. `invalid_grant`, `invalid_client`)
 * means the grant is dead and the caller must transition to `needs_reconnect`;
 * that surfaces as an `OAuthRefreshError` with `unrecoverable: true`. Everything
 * else — network errors, `5xx`, and transient `4xx` like `408`/`429` — surfaces
 * as `unrecoverable: false` so the caller keeps the (possibly still-valid) grant.
 */
/** OAuth error codes that mean the refresh grant itself is permanently dead. */
const UNRECOVERABLE_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "access_denied",
]);
export async function refreshAccessToken(
  input: TokenRefreshInput,
  fetchImpl: OAuthFetch = fetch
): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  applyClientAuth(input.provider, input.credentials, body, headers);

  let response: Response;
  try {
    response = await fetchImpl(input.provider.tokenUrl, {
      method: "POST",
      headers,
      body: body.toString(),
    });
  } catch (error) {
    // Network-level failure: transient, keep the grant.
    throw new OAuthRefreshError(
      `OAuth token refresh failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      false
    );
  }

  const raw = (await response.json().catch(() => ({}))) as RawTokenResponse;
  if (!response.ok || raw.error || !raw.access_token) {
    const detail = raw.error_description || raw.error || `HTTP ${response.status}`;
    // Only an explicit OAuth grant-error code means the grant is permanently
    // dead. A transient 4xx (408/429) or a 5xx must NOT discard a valid grant,
    // so anything without a known-fatal error code is treated as recoverable.
    const unrecoverable = raw.error
      ? UNRECOVERABLE_REFRESH_ERRORS.has(raw.error)
      : false;
    throw new OAuthRefreshError(
      `OAuth token refresh failed: ${detail}`,
      unrecoverable
    );
  }

  return {
    accessToken: raw.access_token,
    // Google usually omits refresh_token on refresh; keep the existing one.
    refreshToken: raw.refresh_token,
    expiresAt:
      typeof raw.expires_in === "number"
        ? Date.now() + raw.expires_in * 1000
        : undefined,
    scopes: raw.scope ? raw.scope.split(/\s+/).filter(Boolean) : [],
    tokenType: raw.token_type,
  };
}

/**
 * Fetch the connected account identity so the UI can display "Connected as
 * <email>". Best-effort: failure just yields undefined, it does not break the
 * connect flow.
 */
export async function fetchAccountLabel(
  provider: OAuthProviderDescriptor,
  accessToken: string,
  fetchImpl: OAuthFetch = fetch
): Promise<string | undefined> {
  if (!provider.userInfoUrl || !provider.extractAccount) return undefined;
  try {
    const response = await fetchImpl(provider.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!response.ok) return undefined;
    const userInfo = await response.json().catch(() => undefined);
    return provider.extractAccount(userInfo);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort revoke a token at the provider's revocation endpoint (RFC 7009).
 * Used on disconnect so the agent's access is actually withdrawn upstream, not
 * just forgotten locally. Never throws: a failed revoke must not block clearing
 * the local record. Returns true when the provider acknowledged the revoke.
 */
export async function revokeToken(
  provider: OAuthProviderDescriptor,
  token: string,
  fetchImpl: OAuthFetch = fetch,
  credentials?: OAuthClientCredentials
): Promise<boolean> {
  if (!provider.revokeUrl) return false;
  try {
    const body = new URLSearchParams({ token });
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    if (credentials) applyClientAuth(provider, credentials, body, headers);
    const response = await fetchImpl(provider.revokeUrl, {
      method: "POST",
      headers,
      body: body.toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Build the provider authorize URL with state + PKCE challenge. */
export function buildAuthorizeUrl(input: {
  provider: OAuthProviderDescriptor;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.provider.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(input.provider.authorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
