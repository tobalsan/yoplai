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

const explicitProviders = new Map<string, OAuthProviderDescriptor>();
type OAuthProviderState = {
  descriptors: Map<string, OAuthProviderDescriptor>;
  owners: Map<string, Set<string>>;
};
let providerState: OAuthProviderState = { descriptors: new Map(), owners: new Map() };

export function buildOAuthProviderState(extensions: { id: string; oauthProviders?: OAuthProviderDescriptor[] }[]): OAuthProviderState {
  const descriptors = new Map(explicitProviders);
  const owners = new Map<string, Set<string>>();
  for (const extension of extensions) {
    for (const provider of extension.oauthProviders ?? []) {
      const existing = descriptors.get(provider.id);
      if (existing && describeProviderIdentity(existing) !== describeProviderIdentity(provider)) {
        const owner = owners.get(provider.id)?.values().next().value;
        throw new Error(owner
          ? `OAuth provider ${provider.id} conflicts between ${owner} and ${extension.id}`
          : `OAuth provider ${provider.id} has a conflicting descriptor`);
      }
      if (!existing) descriptors.set(provider.id, provider);
      const set = owners.get(provider.id) ?? new Set<string>();
      set.add(extension.id);
      owners.set(provider.id, set);
    }
  }
  return { descriptors, owners };
}

export function replaceOAuthProviderState(next: OAuthProviderState): OAuthProviderState {
  const previous = providerState;
  providerState = next;
  return previous;
}

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
  const existing = providerState.descriptors.get(provider.id);
  if (!existing) {
    explicitProviders.set(provider.id, provider);
    providerState.descriptors.set(provider.id, provider);
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
    const existing = providerState.descriptors.get(provider.id) ?? pending.get(provider.id);
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
  explicitProviders.clear();
  replaceOAuthProviderState({ descriptors: new Map(), owners: new Map() });
}

export function getOAuthProvider(
  id: string
): OAuthProviderDescriptor | undefined {
  return providerState.descriptors.get(id);
}

export function listOAuthProviders(): OAuthProviderDescriptor[] {
  return [...providerState.descriptors.values()];
}
