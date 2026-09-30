import type { CredentialScope } from "@yoplai/shared";
import type { CredentialKey } from "./store.js";

export type ResolvedCredential<T> =
  | { connected: true; payload: T; scope: CredentialScope }
  | { connected: false; reason: "not_connected"; connectUrl: string };

/** Personal requester credentials take precedence; other users are never read. */
export function resolveCredential<T>(input: {
  store: { get(key: CredentialKey): T | undefined };
  agentId: string;
  integration: string;
  requesterUserId?: string;
  connectUrl: string;
}): ResolvedCredential<T> {
  const scopes: CredentialScope[] = input.requesterUserId
    ? [{ type: "personal", userId: input.requesterUserId }, { type: "team" }]
    : [{ type: "team" }];
  for (const scope of scopes) {
    const payload = input.store.get({
      agentId: input.agentId,
      integration: input.integration,
      scope,
    });
    if (payload !== undefined) return { connected: true, payload, scope };
  }
  return { connected: false, reason: "not_connected", connectUrl: input.connectUrl };
}
