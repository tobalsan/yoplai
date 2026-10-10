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

/** Notion-style descriptor: Basic token auth and account taken from the token response. */
export const notionProvider: OAuthProviderDescriptor = {
  id: "notion",
  displayName: "Notion",
  authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
  authorizeParams: { owner: "user" },
  tokenUrl: "https://api.notion.com/v1/oauth/token",
  revokeUrl: "https://api.notion.com/v1/oauth/revoke",
  tokenAuth: "basic",
  defaultScopes: [],
  apiBaseUrl: "https://api.notion.com",
  accountFromTokenResponse(token) {
    const t = token as { owner?: { user?: { person?: { email?: unknown } } }; workspace_name?: unknown } | null;
    const email = t?.owner?.user?.person?.email;
    if (typeof email === "string") return email;
    return typeof t?.workspace_name === "string" ? t.workspace_name : undefined;
  },
};
