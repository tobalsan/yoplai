import { afterEach, describe, expect, it } from "vitest";
import {
  getOAuthProvider,
  listOAuthProviders,
  materializeOAuthProvider,
  oauthProviderNeedsSubdomain,
  registerOAuthProvider,
  resetOAuthProviders,
} from "./providers.js";
import { googleProvider, zendeskProvider } from "./test-providers.js";

describe("oauth provider registry", () => {
  afterEach(() => {
    resetOAuthProviders();
    registerOAuthProvider(googleProvider);
    registerOAuthProvider(zendeskProvider);
  });

  it("registers, gets, lists and resets descriptors", () => {
    resetOAuthProviders();
    expect(listOAuthProviders()).toEqual([]);
    registerOAuthProvider(zendeskProvider);
    expect(getOAuthProvider("zendesk")).toBe(zendeskProvider);
    expect(listOAuthProviders()).toEqual([zendeskProvider]);
  });

  it("accepts an equivalent descriptor registered twice", () => {
    resetOAuthProviders();
    registerOAuthProvider(googleProvider);
    registerOAuthProvider(googleProvider);
    registerOAuthProvider({ ...googleProvider });
    expect(listOAuthProviders()).toHaveLength(1);
  });

  it("rejects a conflicting descriptor for the same id", () => {
    resetOAuthProviders();
    registerOAuthProvider(googleProvider);
    expect(() =>
      registerOAuthProvider({ ...googleProvider, tokenUrl: "https://evil.example/token" })
    ).toThrow('OAuth provider "google" is already registered with a conflicting descriptor');
    expect(() =>
      registerOAuthProvider({ ...googleProvider, tokenAuth: "basic" })
    ).toThrow("conflicting descriptor");
  });
});

describe("zendesk provider descriptor", () => {
  it("fills {subdomain} in every URL", () => {
    const provider = materializeOAuthProvider(zendeskProvider, "cloudi-fi");
    expect(provider).toMatchObject({
      authorizeUrl: "https://cloudi-fi.zendesk.com/oauth/authorizations/new",
      tokenUrl: "https://cloudi-fi.zendesk.com/oauth/tokens",
      userInfoUrl: "https://cloudi-fi.zendesk.com/api/v2/users/me.json",
      apiBaseUrl: "https://cloudi-fi.zendesk.com",
      defaultScopes: ["read"],
    });
    expect(provider.revokeUrl).toBeUndefined();
  });

  it("names the config key when the subdomain is missing", () => {
    expect(() => materializeOAuthProvider(zendeskProvider, undefined)).toThrow(
      "oauth.providers.zendesk.subdomain"
    );
  });

  it("leaves providers without placeholders untouched", () => {
    expect(oauthProviderNeedsSubdomain(googleProvider)).toBe(false);
    expect(materializeOAuthProvider(googleProvider, undefined)).toBe(googleProvider);
  });

  it("extracts the account email from users/me.json", () => {
    expect(zendeskProvider.extractAccount?.({ user: { email: "a@b.co" } })).toBe("a@b.co");
    expect(zendeskProvider.extractAccount?.({})).toBeUndefined();
  });
});
