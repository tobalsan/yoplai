import { describe, expect, it } from "vitest";
import { gatewayApiPath, gatewayKey, qualifiedAgentId, qualifyAgentRoute, rawAgentId } from "./gateway";

describe("gateway context helpers", () => {
  it("keeps a local path and prefixes a remote path with the encoded gateway name", () => {
    expect(gatewayApiPath(undefined, "/api/agents/a/extensions")).toBe("/api/agents/a/extensions");
    expect(gatewayApiPath("east", "/api/schedule-alerts")).toBe("/api/relay/gateways/east/api/schedule-alerts");
    expect(gatewayApiPath("e/ast b", "/api/x")).toBe("/api/relay/gateways/e%2Fast%20b/api/x");
  });

  it("keeps equal object IDs of two gateways apart in a key", () => {
    expect(gatewayKey("east", "job")).not.toBe(gatewayKey("west", "job"));
    expect(gatewayKey(undefined, "job")).not.toBe(gatewayKey("east", "job"));
  });

  it("qualifies and unqualifies only with the exact gateway suffix", () => {
    expect(qualifiedAgentId("assistant", "east")).toBe("assistant@east");
    expect(qualifiedAgentId("assistant", undefined)).toBe("assistant");
    expect(rawAgentId("assistant@east", "east")).toBe("assistant");
    expect(rawAgentId("assistant@west", "east")).toBe("assistant@west");
    expect(rawAgentId("assistant@east", undefined)).toBe("assistant@east");
  });

  it("moves a remote route to the qualified agent and refuses a route of another agent", () => {
    expect(qualifyAgentRoute("/agents/assistant/extensions/webhooks", "assistant@east", "east")).toBe("/agents/assistant%40east/extensions/webhooks");
    expect(qualifyAgentRoute("/agents/other/extensions/webhooks", "assistant@east", "east")).toBeUndefined();
    expect(qualifyAgentRoute("/agents/assistant/extensions/webhooks", "assistant", undefined)).toBe("/agents/assistant/extensions/webhooks");
  });
});
