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

  it("redacts generic and Azure signed URL authorization parameters", () => {
    const canary = "canary-private-value";
    const sanitized = sanitizeSensitiveText(
      `https://files.example.test/report.csv?token=${canary}&sp=${canary}&st=${canary}&se=${canary}&sv=${canary}&page=2`
    );

    expect(sanitized).not.toContain(canary);
    expect(sanitized).toContain("https://files.example.test/report.csv?");
    expect(sanitized).toContain("page=2");
  });

  it("redacts provider credentials from shell environment output", () => {
    const canary = "canary-private-value";
    const sanitized = sanitizeSensitiveText(
      `OPENAI_API_KEY=${canary}\nAWS_SECRET_ACCESS_KEY=${canary}`
    );

    expect(sanitized).not.toContain(canary);
    expect(sanitized).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(sanitized).toContain("AWS_SECRET_ACCESS_KEY=[REDACTED]");
  });

  it("preserves error diagnostics without retaining credentials", () => {
    const canary = "canary-private-value";
    const error = Object.assign(
      new Error(`request failed: Authorization: Bearer ${canary}`, {
        cause: { authorization: `Bearer ${canary}` },
      }),
      { status: 401, details: `token=${canary}` }
    );
    const sanitized = sanitizeForStorage(error);

    expect(sanitized).toBeInstanceOf(Error);
    expect(sanitized.message).not.toContain(canary);
    expect(sanitized.stack).not.toContain(canary);
    expect(sanitized.cause).toEqual({ authorization: "[REDACTED]" });
    expect(sanitized).toMatchObject({ status: 401, details: "token=[REDACTED]" });
  });

  it("sanitizes enumerable aggregate errors", () => {
    const canary = "canary-private-value";
    const error = Object.assign(new Error("multiple failures"), {
      errors: [new Error(`Authorization: Bearer ${canary}`)],
    });

    expect(() => sanitizeForStorage(error)).not.toThrow();
    const sanitized = sanitizeForStorage(error) as Error & { errors: Error[] };
    expect(sanitized.errors[0]?.message).not.toContain(canary);
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
