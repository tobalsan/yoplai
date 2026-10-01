import { createEffect, createSignal, For, Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { LeftNavShell } from "../../components/LeftNavShell";
import { OAuthConnectCard } from "../../components/OAuthConnectCard";
import { fetchAgents } from "../../api/agents";
import type { Agent } from "../../api/types";

function OAuthConnectPage() {
  const [query] = useSearchParams();
  const [agents, setAgents] = createSignal<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = createSignal(typeof query.agent === "string" ? query.agent : "");
  const [agentsError, setAgentsError] = createSignal<string>();

  createEffect(() => {
    void fetchAgents()
      .then((list) => {
        setAgents(list);
        if (!selectedAgent() && list.length > 0) setSelectedAgent(list[0].id);
      })
      .catch((cause) =>
        setAgentsError(cause instanceof Error ? cause.message : String(cause))
      );
  });

  return (
    <LeftNavShell>
      <div class="oauth-root">
        <style>{`
          .oauth-root { max-width: 720px; margin: 0 auto; padding: 32px 24px; }
          .oauth-header h1 { margin: 0 0 6px; font-size: 22px; color: var(--text-primary); }
          .oauth-header p { margin: 0 0 24px; color: var(--text-secondary); font-size: 14px; }
          .oauth-agent-row { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
          .oauth-agent-row label { font-size: 13px; color: var(--text-secondary); font-weight: 600; }
          .oauth-agent-row select { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border-default); background: var(--bg-surface); color: var(--text-primary); font-size: 14px; min-width: 200px; }
        `}</style>
        <header class="oauth-header">
          <h1>Connections</h1>
          <p>
            Connect external accounts for just yourself or the whole team on an agent.
          </p>
        </header>
        <Show when={agentsError()}>
          {(message) => <div class="oauth-error">{message()}</div>}
        </Show>
        <div class="oauth-agent-row">
          <label for="oauth-agent">Agent</label>
          <select
            id="oauth-agent"
            value={selectedAgent()}
            onChange={(event) => setSelectedAgent(event.currentTarget.value)}
          >
            <For each={agents()}>
              {(agent) => (
                <option value={agent.id}>{agent.name ?? agent.id}</option>
              )}
            </For>
          </select>
        </div>
        <OAuthConnectCard
          agentId={selectedAgent()}
          provider="google"
          label="Google Drive"
        />
      </div>
    </LeftNavShell>
  );
}

export const webRouteExtension = {
  extensionId: "googleDrive",
  routes: [{ path: "/connections", component: OAuthConnectPage }],
};
