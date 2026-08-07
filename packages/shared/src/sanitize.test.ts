import { describe, expect, it } from "vitest";
import { AgentEventBus } from "./events.js";
import { sanitizeForStorage, sanitizeSensitiveText } from "./sanitize.js";

describe("sanitizeForStorage", () => {
  it("redacts nested credentials and signed URL authorization while preserving URL path", () => {
    const canary = "canary-private-value";
    const sanitized = sanitizeForStorage({
      nested: {
        authorization: `Bearer ${canary}`,
        providerToken: canary,
        provider_token: canary,
        AWS_SESSION_TOKEN: canary,
      },
      output: `download https://files.example.test/report.csv?X-Amz-Credential=${canary}&X-Amz-Signature=${canary}&page=2`,
      harmless: "visible",
    });

    expect(JSON.stringify(sanitized)).not.toContain(canary);
    expect(sanitized).toMatchObject({ harmless: "visible" });
    expect(sanitized.output).toContain(
      "https://files.example.test/report.csv?"
    );
    expect(sanitized.output).toContain("page=2");
  });

  it("redacts credential-bearing environment and header text", () => {
    const canary = "canary-private-value";
    const sanitized = sanitizeSensitiveText(
      `HTTP_PROXY=http://agent:${canary}@proxy.example.test Authorization: Token ${canary}`
    );

    expect(sanitized).not.toContain(canary);
    expect(sanitized).toContain("HTTP_PROXY=[REDACTED]");
    expect(sanitized).toContain("Authorization: [REDACTED]");
  });

  it("sanitizes event-bus exports", () => {
    const canary = "canary-private-value";
    const bus = new AgentEventBus();
    let exported: unknown;
    bus.onHistoryEvent((event) => {
      exported = event;
    });

    bus.emitHistoryEvent({
      type: "tool_result",
      agentId: "agent",
      sessionId: "session",
      id: "tool",
      name: "download",
      content: `Authorization: Bearer ${canary}`,
      isError: true,
      timestamp: 1,
    });

    expect(JSON.stringify(exported)).not.toContain(canary);
  });
});
