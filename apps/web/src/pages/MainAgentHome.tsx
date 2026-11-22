import { createResource, createEffect, createSignal, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { fetchMainAgentOptions, saveMainAgentPreference } from "../api/main-agent";
import { startNewChat } from "../api/chat";
import { AgentCatalog } from "./AgentCatalog";
import { MainAgentPicker } from "../components/MainAgentPicker";
import { Button } from "../components/ui/Button";

export function MainAgentHome() {
  const navigate = useNavigate();
  const [closed, setClosed] = createSignal(false);
  const [error, setError] = createSignal("");
  const [options, { refetch }] = createResource(async () => {
    setError("");
    try {
      const state = await fetchMainAgentOptions();
      if (state.agents.length === 1) {
        await saveMainAgentPreference({ mainAgentId: state.agents[0].id });
        state.preference = { mainAgentId: state.agents[0].id, accessible: true, pickerDismissedAt: null };
      }
      return state;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load your main agent. Try again.");
      return null;
    }
  });
  createEffect(() => {
    const state = options();
    if (state?.preference.accessible && state.preference.mainAgentId) {
      startNewChat(state.preference.mainAgentId);
      navigate(`/chat/${encodeURIComponent(state.preference.mainAgentId)}`, { replace: true, state: { mainAgentHome: true } });
    }
  });
  return <Show when={!options.loading} fallback={<div class="main-agent-home-loading" role="status">Opening your home…</div>}>
    <Show when={error()}><div class="main-agent-home-error" role="alert"><p>{error()}</p><Button onClick={() => void refetch()}>Retry</Button></div></Show>
    <AgentCatalog />
    <Show when={!closed() && options()?.agents.length && !options()?.preference.accessible}>
      <MainAgentPicker agents={options()!.agents} onPick={(agent) => {
        startNewChat(agent.id);
        navigate(`/chat/${encodeURIComponent(agent.id)}`, { replace: true, state: { mainAgentHome: true } });
      }} onClose={() => setClosed(true)} />
    </Show>
    <style>{`.main-agent-home-loading { padding: 24px; color: var(--text-secondary); font-size: 14px; } .main-agent-home-error { margin: 24px 24px 0; padding: 16px; border-radius: 8px; background: var(--bg-raised); color: var(--tone-error); font-size: 14px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }`}</style>
  </Show>;
}
