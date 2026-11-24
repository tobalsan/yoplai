export class OpsMetrics {
  private readonly counters = new Map<string, Map<string, number>>();

  increment(id: string, agentId: string): void {
    let agents = this.counters.get(id);
    if (!agents) {
      agents = new Map();
      this.counters.set(id, agents);
    }
    agents.set(agentId, (agents.get(agentId) ?? 0) + 1);
  }

  snapshot() {
    return Array.from(this.counters, ([id, agents]) =>
      Array.from(agents, ([agentId, value]) => ({ id, agentId, value }))
    ).flat();
  }
}
