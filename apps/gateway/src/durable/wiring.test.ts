import { GatewayConfigSchema } from "@yoplai/shared";
import { describe, expect, it } from "vitest";
import { canReplayOnFallback } from "./fallback.js";
import { mainIdentity } from "./principal.js";
import { claimToolDescriptor, defineGatewayTool } from "./tool-definition.js";

describe("Durable wiring seams", () => {
  it("preserves the canonical tool name and schemas when it claims a provider-safe name", () => {
    const parameters = { type: "object", properties: { bed: { type: "string" } }, required: ["bed"] };
    const outputSchema = { type: "object", properties: { count: { type: "integer" } } };
    const used = new Set(["read"]);
    const first = claimToolDescriptor({ name: "bed.inspect", description: "Inspect the bed.", parameters, outputSchema }, used);
    const second = claimToolDescriptor({ name: "bed_inspect", description: "Inspect another bed.", parameters }, used);
    expect(first).toMatchObject({ name: "bed_inspect", canonicalName: "bed.inspect" });
    expect(second.canonicalName).toBe("bed_inspect");
    expect(second.name).not.toBe("bed_inspect");
    const registration = defineGatewayTool({ ...first, deferred: false }, async () => ({ count: 7 }));
    expect(registration.parameters).toBe(parameters);
    expect(registration.structuredOutputSchema).toBe(outputSchema);
    expect(defineGatewayTool({ ...second, deferred: false }, async () => "Seven.").structuredOutputSchema).toBeUndefined();
  });

  it("represents local Main as the local actor and multi-user Main as its owner", () => {
    const local = GatewayConfigSchema.parse({ version: 3, agents: [] });
    const multi = GatewayConfigSchema.parse({ version: 3, agents: [], extensions: { multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: "fixture-session-secret-at-least-32-characters" } } });
    expect(mainIdentity("local", local)).toMatchObject({
      userId: undefined, sessionOwnerId: undefined, requesterId: undefined, actorUserId: "local",
      actorKind: "local", source: "web", sessionId: "durable-main",
    });
    expect(mainIdentity("alice", multi)).toMatchObject({
      userId: "alice", sessionOwnerId: "alice", requesterId: "alice", actorUserId: "alice",
      actorKind: "user", source: "web", sessionId: "durable-main",
    });
  });

  it("only replays fallback-eligible failures without visible output or a tool call", () => {
    const empty = { role: "assistant", content: [] };
    expect(canReplayOnFallback("503 Model temporarily unavailable.", [empty])).toBe(true);
    expect(canReplayOnFallback("503 The model refused to complete the request.", [empty])).toBe(false);
    expect(canReplayOnFallback("401 Unauthorized.", [empty])).toBe(false);
    expect(canReplayOnFallback("503 Model temporarily unavailable.", [
      { role: "assistant", content: [{ type: "text", text: "The first row" }] },
    ])).toBe(false);
    expect(canReplayOnFallback("503 Model temporarily unavailable.", [
      { role: "assistant", content: [{ type: "toolCall" }] },
    ])).toBe(false);
  });
});
