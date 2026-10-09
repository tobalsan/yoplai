import { z } from "zod";

/**
 * A provider descriptor is pure data: adding a new OAuth provider (Gmail,
 * Dropbox, ...) is a matter of adding one of these, not writing new flow code.
 * The authorize + callback routes and the token store are provider-agnostic and
 * read everything they need from the descriptor.
 */
export interface OAuthProviderDescriptor {
  /** Stable id used in routes and storage, e.g. "google". */
  id: string;
  /** Human-facing name, e.g. "Google". */
  displayName: string;
  /**
   * URLs below may contain a `{subdomain}` placeholder, filled from
   * `oauth.providers.<id>.subdomain` (see `materializeOAuthProvider`).
   */
  /** OAuth 2.0 authorization endpoint. */
  authorizeUrl: string;
  /** OAuth 2.0 token endpoint. */
  tokenUrl: string;
  /**
   * OAuth 2.0 token revocation endpoint (RFC 7009). When present, disconnect
   * best-effort revokes the grant at the provider before clearing the local
   * record, so the agent's access is actually withdrawn and not just forgotten.
   */
  revokeUrl?: string;
  /**
   * Endpoint used to fetch the connected account identity after token
   * exchange (so the UI can show "Connected as alice@example.com").
   */
  userInfoUrl?: string;
  /** Default scopes requested when a consumer does not override them. */
  defaultScopes: string[];
  /** Base URL of the provider's API, handed to extensions that need it. */
  apiBaseUrl?: string;
  /**
   * Extra query params appended to the authorize URL. For Google we need
   * access_type=offline + prompt=consent to be handed a refresh token, even
   * though this slice does not yet use refresh.
   */
  authorizeParams?: Record<string, string>;
  /**
   * Given a parsed userinfo response, extract a stable, human-readable account
   * label (usually the email). Returns undefined when it cannot be determined.
   */
  extractAccount?(userInfo: unknown): string | undefined;
}

/**
 * The lifecycle state of a stored connection.
 *
 * - `connected`: a usable grant. While the refresh token works, access tokens
 *   are refreshed silently and the connection stays here — agents never see an
 *   expired token.
 * - `needs_reconnect`: the grant is unrecoverable (refresh token revoked or
 *   expired-beyond-refresh). The connection is retained so the UI can surface a
 *   first-class "reconnect" prompt, but it yields a clean not-connected signal
 *   to agents instead of a cryptic error.
 *
 * A fully removed connection has no stored record; callers treat the absence as
 * `disconnected`.
 */
export const ConnectionStateSchema = z.enum([
  "connected",
  "needs_reconnect",
  "disconnected",
]);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

/**
 * Team credentials are shared by an agent; personal credentials belong only
 * to the named requester. Missing scope on legacy connections means team.
 */
export type CredentialScope =
  | { type: "team" }
  | { type: "personal"; userId: string };

export const OAuthConnectionSchema = z.object({
  agentId: z.string(),
  provider: z.string(),
  scope: z.enum(["team", "personal"]).optional(),
  userId: z.string().min(1).optional(),
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  /** Epoch millis when the access token expires, if known. */
  expiresAt: z.number().optional(),
  scopes: z.array(z.string()).default([]),
  /** Human-readable connected account, e.g. the Google email. */
  account: z.string().optional(),
  tokenType: z.string().optional(),
  /**
   * Lifecycle state. A stored record is either `connected` (usable, refreshing
   * silently) or `needs_reconnect` (grant lost, awaiting a one-click reconnect).
   * Absent for legacy records written before the state machine — treated as
   * `connected` by all readers.
   */
  status: z.enum(["connected", "needs_reconnect"]).optional(),
  connectedAt: z.number(),
  updatedAt: z.number(),
}).superRefine((connection, ctx) => {
  if (connection.scope === "personal" && !connection.userId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["userId"],
      message: "Personal credentials require a userId",
    });
  }
  if (connection.scope !== "personal" && connection.userId !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["userId"],
      message: "Team credentials cannot have a userId",
    });
  }
});
export type OAuthConnection = z.infer<typeof OAuthConnectionSchema>;

/**
 * The result of resolving an OAuth requirement at tool-build time. It carries a
 * fresh access token when connected, or a clear, structured not-connected
 * signal otherwise — never a raw secret and never a thrown 401.
 */
export type ResolvedOAuth =
  | {
      connected: true;
      provider: string;
      accessToken: string;
      account?: string;
      scopes: string[];
      expiresAt?: number;
      apiBaseUrl?: string;
    }
  | {
      connected: false;
      provider: string;
      reason: OAuthNotConnectedReason;
      /** URL the UI/agent can point the operator/user at to connect. */
      authorizeUrl?: string;
      message: string;
    };

export type OAuthNotConnectedReason =
  | "not_connected"
  | "provider_not_configured"
  | "needs_reconnect"
  | "insufficient_scope";

/**
 * Declared by a tool extension: "I need a token for this provider/scopes".
 */
export interface OAuthRequirement {
  provider: string;
  scopes?: string[];
}
