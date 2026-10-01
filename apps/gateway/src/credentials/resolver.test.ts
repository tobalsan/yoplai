import { describe, expect, it } from "vitest";
import { resolveCredential } from "./resolver.js";
import type { CredentialKey } from "./store.js";

describe("credential resolution matrix", () => {
  it.each([
    { requester: "alice", personal: true, team: true, expected: "alice" },
    { requester: "alice", personal: true, team: false, expected: "alice" },
    { requester: "alice", personal: false, team: true, expected: "team" },
    { requester: "alice", personal: false, team: false, expected: undefined },
    { requester: "bob", personal: true, team: true, expected: "team" },
    { requester: "bob", personal: true, team: false, expected: undefined },
    { requester: "bob", personal: false, team: true, expected: "team" },
    { requester: "bob", personal: false, team: false, expected: undefined },
  ])("requester=$requester personal=$personal team=$team → $expected", (scenario) => {
    const reads: CredentialKey[] = [];
    const resolved = resolveCredential({
      store: {
        get(key: CredentialKey) {
          reads.push(key);
          if (key.agentId !== "agent" || key.integration !== "api-key") return undefined;
          if (key.scope.type === "team") return scenario.team ? "team" : undefined;
          if (key.scope.userId === "third-user") return "other-user-secret";
          return key.scope.userId === "alice" && scenario.personal ? "alice" : undefined;
        },
      },
      agentId: "agent",
      integration: "api-key",
      requesterUserId: scenario.requester,
      connectUrl: "https://gateway/connect",
    });
    if (scenario.expected) {
      expect(resolved).toEqual({
        connected: true,
        payload: scenario.expected,
        scope: scenario.expected === "alice" ? { type: "personal", userId: "alice" } : { type: "team" },
      });
    } else {
      expect(resolved).toEqual({ connected: false, reason: "not_connected", connectUrl: "https://gateway/connect" });
    }
    expect(reads.some((key) => key.scope.type === "personal" && key.scope.userId === "third-user")).toBe(false);
    if (scenario.requester === "bob") {
      expect(reads.some((key) => key.scope.type === "personal" && key.scope.userId === "alice")).toBe(false);
    }
  });

  it("never reads personal credentials without a requester identity", () => {
    const reads: CredentialKey[] = [];
    const resolved = resolveCredential({
      store: {
        get(key: CredentialKey) {
          reads.push(key);
          return key.scope.type === "personal" ? "personal-secret" : undefined;
        },
      },
      agentId: "agent",
      integration: "api-key",
      connectUrl: "https://gateway/connect",
    });
    expect(resolved).toEqual({ connected: false, reason: "not_connected", connectUrl: "https://gateway/connect" });
    expect(reads).toEqual([{ agentId: "agent", integration: "api-key", scope: { type: "team" } }]);
  });
});
