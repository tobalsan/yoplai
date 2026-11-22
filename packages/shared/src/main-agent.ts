export type MainAgentPreference = {
  mainAgentId: string | null;
  pickerDismissedAt: string | null;
  updatedAt: string;
};

export type MainAgentState = {
  mainAgentId: string | null;
  accessible: boolean;
  pickerDismissedAt: string | null;
};

export function eligibleMainAgents<T extends { id: string }>(agents: T[]): T[] {
  return agents;
}
