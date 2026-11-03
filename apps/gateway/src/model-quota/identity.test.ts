import { describe, expect, it } from "vitest";
import { extractCodexAccountId, resolveLoginIdentity } from "./identity.js";

const token = (account: string) =>
  `e30.${Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: account },
    })
  ).toString("base64url")}.fixture`;

describe("quota login identity", () => {
  it("binds Codex identity and request account to the token, never stored accountId", () => {
    const credential = {
      type: "oauth",
      access: token("account-a"),
      accountId: "account-b",
    };
    expect(extractCodexAccountId(credential.access)).toBe("account-a");
    const identity = resolveLoginIdentity("openai-codex", credential);
    expect(identity?.provider).toBe("openai-codex");
    expect(identity?.accountRef).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(identity)).not.toContain("account-a");
    expect(
      resolveLoginIdentity("openai-codex", {
        type: "oauth",
        access: token("account-b"),
      })
    ).not.toEqual(identity);
    const missingClaim = {
      type: "oauth",
      access: "bad",
      accountId: "account-b",
    };
    expect(resolveLoginIdentity("openai-codex", missingClaim)).toBeUndefined();
    expect(
      resolveLoginIdentity("anthropic", { type: "oauth", access: "fixture" })
    ).toEqual({ provider: "anthropic", accountRef: "host" });
    expect(
      resolveLoginIdentity("anthropic", { type: "api_key" })
    ).toBeUndefined();
    expect(resolveLoginIdentity("openai-codex", undefined)).toBeUndefined();
    expect(resolveLoginIdentity("openai-chatgpt", credential)).toBeUndefined();
  });
});
