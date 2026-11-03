import { createHash } from "node:crypto";
import type { LoginIdentity } from "@yoplai/shared";

export type QuotaCredential = { type: string; access?: string };

/** Same namespaced access-token claim used by pi-ai 1.3.0. */
export function extractCodexAccountId(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    );
    const account =
      payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof account === "string" && account.trim() ? account : undefined;
  } catch {
    return undefined;
  }
}

export function resolveLoginIdentity(
  provider: string,
  credential: QuotaCredential | undefined
): LoginIdentity | undefined {
  if (credential?.type !== "oauth") return undefined;
  if (provider === "anthropic") return { provider, accountRef: "host" };
  if (provider !== "openai-codex" || !credential.access) return undefined;
  const account = extractCodexAccountId(credential.access);
  return account
    ? {
        provider,
        accountRef: createHash("sha256")
          .update(account)
          .digest("hex")
          .slice(0, 16),
      }
    : undefined;
}
