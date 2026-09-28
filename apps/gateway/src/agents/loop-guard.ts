import type { RunAgentParams } from "@yoplai/shared";

export const DEFAULT_MAX_AGENT_TURNS = 8;
export const DEFAULT_MAX_HOPS = 5;

export type LoopGuardReason = "max_agent_turns" | "max_hops";

const consecutiveAgentTurns = new Map<string, number>();

export function checkAgentLoop(params: {
  key: string;
  sender?: RunAgentParams["sender"];
  maxAgentTurns: number;
  maxHops: number;
}): LoopGuardReason | undefined {
  if (!params.sender) {
    consecutiveAgentTurns.delete(params.key);
    return undefined;
  }

  if ((params.sender.hops ?? 0) > params.maxHops) return "max_hops";

  const next = (consecutiveAgentTurns.get(params.key) ?? 0) + 1;
  if (next > params.maxAgentTurns) return "max_agent_turns";
  consecutiveAgentTurns.set(params.key, next);
  return undefined;
}

export function resetAgentLoopGuardForTests(): void {
  consecutiveAgentTurns.clear();
}
