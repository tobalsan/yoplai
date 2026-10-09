import type { OAuthProviderDescriptor } from "./types.js";

/**
 * Google descriptor. This is the whole "how to talk to Google" definition —
 * adding Gmail read-only later is just a new descriptor + a client id/secret,
 * with no changes to the authorize/callback/token-store machinery.
 */
export const googleProvider: OAuthProviderDescriptor = {
  id: "google",
  displayName: "Google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
  defaultScopes: [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
  ],
  authorizeParams: {
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  },
  extractAccount(userInfo) {
    if (
      userInfo &&
      typeof userInfo === "object" &&
      "email" in userInfo &&
      typeof (userInfo as { email?: unknown }).email === "string"
    ) {
      return (userInfo as { email: string }).email;
    }
    return undefined;
  },
};

/** Zendesk descriptor. URLs are per-tenant: `{subdomain}` comes from oauth.providers.zendesk.subdomain. */
export const zendeskProvider: OAuthProviderDescriptor = {
  id: "zendesk",
  displayName: "Zendesk",
  authorizeUrl: "https://{subdomain}.zendesk.com/oauth/authorizations/new",
  tokenUrl: "https://{subdomain}.zendesk.com/oauth/tokens",
  userInfoUrl: "https://{subdomain}.zendesk.com/api/v2/users/me.json",
  apiBaseUrl: "https://{subdomain}.zendesk.com",
  defaultScopes: ["read"],
  extractAccount(userInfo) {
    const email = (userInfo as { user?: { email?: unknown } } | null)?.user?.email;
    return typeof email === "string" ? email : undefined;
  },
};

const SUBDOMAIN_PLACEHOLDER = "{subdomain}";

/** True when any descriptor URL needs a subdomain. */
export function oauthProviderNeedsSubdomain(provider: OAuthProviderDescriptor): boolean {
  return [
    provider.authorizeUrl,
    provider.tokenUrl,
    provider.revokeUrl,
    provider.userInfoUrl,
    provider.apiBaseUrl,
  ].some((url) => url?.includes(SUBDOMAIN_PLACEHOLDER));
}

/** Substitute `{subdomain}` in every descriptor URL. */
export function materializeOAuthProvider(
  provider: OAuthProviderDescriptor,
  subdomain: string | undefined
): OAuthProviderDescriptor {
  if (!oauthProviderNeedsSubdomain(provider)) return provider;
  if (!subdomain) {
    throw new Error(
      `OAuth provider "${provider.id}" requires oauth.providers.${provider.id}.subdomain`
    );
  }
  const fill = (url: string | undefined) =>
    url?.replaceAll(SUBDOMAIN_PLACEHOLDER, subdomain);
  return {
    ...provider,
    authorizeUrl: fill(provider.authorizeUrl)!,
    tokenUrl: fill(provider.tokenUrl)!,
    revokeUrl: fill(provider.revokeUrl),
    userInfoUrl: fill(provider.userInfoUrl),
    apiBaseUrl: fill(provider.apiBaseUrl),
  };
}

const PROVIDER_LIST: OAuthProviderDescriptor[] = [googleProvider, zendeskProvider];

const PROVIDER_REGISTRY = new Map<string, OAuthProviderDescriptor>(
  PROVIDER_LIST.map((provider) => [provider.id, provider])
);

export function getOAuthProvider(
  id: string
): OAuthProviderDescriptor | undefined {
  return PROVIDER_REGISTRY.get(id);
}

export function listOAuthProviders(): OAuthProviderDescriptor[] {
  return [...PROVIDER_REGISTRY.values()];
}
