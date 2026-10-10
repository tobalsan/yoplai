import type { OAuthProviderDescriptor } from "./types.js";

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

const PROVIDER_REGISTRY = new Map<string, OAuthProviderDescriptor>();

function describeProviderIdentity(provider: OAuthProviderDescriptor): string {
  return JSON.stringify([
    provider.displayName,
    provider.authorizeUrl,
    provider.tokenUrl,
    provider.revokeUrl,
    provider.userInfoUrl,
    provider.apiBaseUrl,
    provider.tokenAuth ?? "body",
    provider.tokenRequestFormat ?? "form",
    provider.defaultScopes,
    Object.entries(provider.authorizeParams ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

/**
 * Register a descriptor shipped by an extension. Re-registering an equivalent
 * descriptor (same object, or same URLs/scopes) is a no-op; a different
 * descriptor under an already-registered id throws.
 */
export function registerOAuthProvider(provider: OAuthProviderDescriptor): void {
  const existing = PROVIDER_REGISTRY.get(provider.id);
  if (!existing) {
    PROVIDER_REGISTRY.set(provider.id, provider);
    return;
  }
  if (
    existing !== provider &&
    describeProviderIdentity(existing) !== describeProviderIdentity(provider)
  ) {
    throw new Error(
      `OAuth provider "${provider.id}" is already registered with a conflicting descriptor`
    );
  }
}

/**
 * Register several descriptors atomically: every descriptor is checked against
 * the registry (and each other) first, so a conflict registers nothing.
 */
export function registerOAuthProviders(providers: OAuthProviderDescriptor[]): void {
  const pending = new Map<string, OAuthProviderDescriptor>();
  for (const provider of providers) {
    const existing = PROVIDER_REGISTRY.get(provider.id) ?? pending.get(provider.id);
    if (
      existing &&
      existing !== provider &&
      describeProviderIdentity(existing) !== describeProviderIdentity(provider)
    ) {
      throw new Error(
        `OAuth provider "${provider.id}" is already registered with a conflicting descriptor`
      );
    }
    pending.set(provider.id, existing ?? provider);
  }
  for (const provider of pending.values()) registerOAuthProvider(provider);
}

/** Clear all registered descriptors (tests only). */
export function resetOAuthProviders(): void {
  PROVIDER_REGISTRY.clear();
}

export function getOAuthProvider(
  id: string
): OAuthProviderDescriptor | undefined {
  return PROVIDER_REGISTRY.get(id);
}

export function listOAuthProviders(): OAuthProviderDescriptor[] {
  return [...PROVIDER_REGISTRY.values()];
}
