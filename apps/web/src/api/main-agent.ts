import { eligibleMainAgents, type MainAgentState } from "@yoplai/shared/main-agent";
import { API_BASE, apiFetch } from "./core";
import type { Agent } from "./types";

async function withDeadline<T>(action: "load" | "save", operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await operation(controller.signal);
  } catch {
    throw new Error(controller.signal.aborted
      ? `${action === "load" ? "Loading" : "Saving"} your main agent took too long. Try again.`
      : `Could not ${action} your main agent. Try again.`);
  } finally {
    clearTimeout(timeout);
  }
}

async function request<T>(path: string, signal: AbortSignal, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`${API_BASE}${path}`, { ...init, signal });
  if (!response.ok) throw new Error("Main agent request failed");
  return response.json();
}

export function fetchMainAgentPreference(): Promise<MainAgentState> {
  return withDeadline("load", (signal) => request<MainAgentState>("/me/main-agent", signal));
}

export function saveMainAgentPreference(value: { mainAgentId: string } | { pickerDismissedAt: string }): Promise<MainAgentState> {
  return withDeadline("save", (signal) => request<MainAgentState>("/me/main-agent", signal, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  }));
}

export function fetchMainAgentOptions() {
  return withDeadline("load", async (signal) => {
    const [preference, agents] = await Promise.all([
      request<MainAgentState>("/me/main-agent", signal),
      request<Agent[]>("/agents", signal),
    ]);
    return { preference, agents: eligibleMainAgents(agents) };
  });
}
