import type { HistoryEvent } from "../types.js";

export type ToolDeadline = {
  name: string;
  startedAt: number;
  deadline: number;
};

/** One instance per run: completed IDs remain remembered until settlement. */
export class ToolDeadlines {
  private seen = new Set<string>();
  private calls = new Map<string | symbol, ToolDeadline>();

  observe(event: HistoryEvent): void {
    if (event.type === "tool_call") {
      const id = event.id || Symbol("empty tool call ID");
      if (typeof id === "string") {
        if (this.seen.has(id)) return;
        this.seen.add(id);
      }
      const timeout =
        typeof event.args === "object" &&
        event.args !== null &&
        "timeout" in event.args
          ? event.args.timeout
          : undefined;
      const budget =
        event.name === "bash" &&
        typeof timeout === "number" &&
        Number.isFinite(timeout) &&
        timeout > 0
          ? timeout
          : 300;
      const startedAt = Date.now();
      this.calls.set(id, {
        name: event.name,
        startedAt,
        deadline: startedAt + budget * 1000 + 15_000,
      });
    } else if (event.type === "tool_result" && event.id) {
      this.calls.delete(event.id);
    }
  }

  earliest(): ToolDeadline | undefined {
    let earliest: ToolDeadline | undefined;
    for (const call of this.calls.values()) {
      if (!earliest || call.deadline < earliest.deadline) earliest = call;
    }
    return earliest;
  }
}
