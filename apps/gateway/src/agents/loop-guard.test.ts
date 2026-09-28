import { beforeEach, describe, expect, it } from "vitest";
import { checkAgentLoop, resetAgentLoopGuardForTests } from "./loop-guard.js";

const sender = { kind: "agent" as const, agentId: "sender" };

describe("agent loop guard", () => {
  beforeEach(resetAgentLoopGuardForTests);

  it("blocks turns beyond the configured consecutive maximum", () => {
    expect(checkAgentLoop({ key: "a", sender, maxAgentTurns: 2, maxHops: 5 })).toBeUndefined();
    expect(checkAgentLoop({ key: "a", sender, maxAgentTurns: 2, maxHops: 5 })).toBeUndefined();
    expect(checkAgentLoop({ key: "a", sender, maxAgentTurns: 2, maxHops: 5 })).toBe("max_agent_turns");
  });

  it("resets the counter on a human turn", () => {
    checkAgentLoop({ key: "a", sender, maxAgentTurns: 1, maxHops: 5 });
    checkAgentLoop({ key: "a", maxAgentTurns: 1, maxHops: 5 });
    expect(checkAgentLoop({ key: "a", sender, maxAgentTurns: 1, maxHops: 5 })).toBeUndefined();
  });

  it("blocks hops above the configured maximum", () => {
    expect(checkAgentLoop({
      key: "a",
      sender: { ...sender, hops: 3 },
      maxAgentTurns: 8,
      maxHops: 2,
    })).toBe("max_hops");
  });

  it("honors the supplied per-agent limits", () => {
    expect(checkAgentLoop({ key: "a", sender, maxAgentTurns: 1, maxHops: 5 })).toBeUndefined();
    expect(checkAgentLoop({ key: "a", sender, maxAgentTurns: 1, maxHops: 5 })).toBe("max_agent_turns");
    expect(checkAgentLoop({ key: "b", sender, maxAgentTurns: 2, maxHops: 5 })).toBeUndefined();
  });
});
