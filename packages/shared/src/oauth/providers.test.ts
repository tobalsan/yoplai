import { describe, expect, it } from "vitest";
import {
  getOAuthProvider,
  materializeOAuthProvider,
  oauthProviderNeedsSubdomain,
  googleProvider,
  zendeskProvider,
} from "./providers.js";

describe("zendesk provider descriptor", () => {
  it("is registered", () => {
    expect(getOAuthProvider("zendesk")).toBe(zendeskProvider);
  });

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
