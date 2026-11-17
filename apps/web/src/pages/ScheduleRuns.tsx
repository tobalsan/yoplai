import { A, useParams } from "@solidjs/router";
import { createMemo, createResource, For, onCleanup, Show } from "solid-js";
import type { ScheduleRun } from "@yoplai/shared/types";
import { fetchScheduleRuns } from "../api/schedules";
import { decodeRouteParam } from "../lib/path";
import { useAgentTarget } from "../lib/agent-target";
import { PageVisit } from "../lib/page-visit";

function duration(run: ScheduleRun): string {
  const seconds = Math.max(0, Math.floor(((run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) - Date.parse(run.startedAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const STATUS_LABELS = { running: "Running", ok: "OK", error: "Error", interrupted: "Interrupted" };

export function ScheduleRuns() {
  const routeParams = useParams<{ agentId: string; jobId: string }>();
  // Router params keep the raw path segment. A job ID is an arbitrary string.
  const params = {
    get agentId() { return decodeRouteParam(routeParams.agentId); },
    get jobId() { return decodeRouteParam(routeParams.jobId); },
  };
  const { target, retry } = useAgentTarget(() => params.agentId);
  const gateway = () => { const current = target(); return current.state === "ready" ? current.gateway : undefined; };
  return (
    <main class="schedule-runs">
      <style>{STYLES}</style>
      <A href={`/agents/${encodeURIComponent(params.agentId)}/edit`}>Back to agent</A>
      <h1>Run history</h1>
      <p class="schedule-runs-job">Job: {params.jobId}</p>
      <Show when={target().state === "missing"}>
        <p role="alert">This agent is unavailable. Check that its gateway is online. <button type="button" onClick={retry}>Retry</button></p>
      </Show>
      <Show when={target().state === "loading"}><p role="status">Loading run history…</p></Show>
      <PageVisit
        gateway={gateway}
        identity={() => [params.agentId, params.jobId]}
        resolved={() => target().state === "ready"}
        pending="Loading run history…"
        failure="Could not read what the gateway of this agent offers."
      >
        {(visit) => (
          <Show when={visit.requester().isExtensionEnabled("scheduler") && visit.requester().enableCronMonitoring} fallback={<p>Run history is unavailable.</p>}>
            <RunHistory agentId={params.agentId} jobId={params.jobId} gateway={visit.gateway} />
          </Show>
        )}
      </PageVisit>
    </main>
  );
}

function RunHistory(props: { agentId: string; jobId: string; gateway?: string }) {
  const [result, { refetch }] = createResource(
    () => ({ agentId: props.agentId, jobId: props.jobId, gateway: props.gateway }),
    async ({ agentId, jobId, gateway }, { value }): Promise<{ runs: ScheduleRun[]; error?: string }> => {
      try {
        return { runs: await fetchScheduleRuns(agentId, jobId, gateway), error: undefined };
      } catch (cause) {
        // This view belongs to one gateway, agent, and job, so an earlier answer is still its own.
        return { runs: value?.runs ?? [], error: cause instanceof Error ? cause.message : "Failed to load run history." };
      }
    }
  );
  const poll = setInterval(() => { if (!result.loading) void refetch(); }, 2_000);
  onCleanup(() => clearInterval(poll));
  // A new visit starts empty. Reading `latest` before the first answer would suspend the page instead.
  const latest = () => (result.state === "ready" || result.state === "refreshing" ? result.latest : undefined);
  const runs = createMemo(() => [...(latest()?.runs ?? [])].sort((a, b) =>
    Number(b.status === "running") - Number(a.status === "running") || Date.parse(b.startedAt) - Date.parse(a.startedAt)
  ));

  return (
    <>
      <button class="schedule-runs-refresh" type="button" disabled={result.loading} onClick={() => void refetch()}>
        {latest()?.error ? "Retry" : "Refresh"}
      </button>
      <Show when={result.loading && !latest()}><p role="status">Loading run history…</p></Show>
      <Show when={latest()?.error}>{(error) => <p class="schedule-runs-error" role="alert">{error()}</p>}</Show>
      <Show when={!result.loading && !latest()?.error && runs().length === 0}><p>No runs yet.</p></Show>
      <ul class="schedule-run-list">
        <For each={runs()}>{(run) => (
          <li class="schedule-run" data-status={run.status}>
            <A class="schedule-run-link" href={`/agents/${encodeURIComponent(props.agentId)}/schedules/${encodeURIComponent(props.jobId)}/runs/${encodeURIComponent(run.id)}`}>
            <header>
              <time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleString()}</time>
              <span class="schedule-run-status">{STATUS_LABELS[run.status]}</span>
            </header>
            <dl>
              <div><dt>Duration</dt><dd>{duration(run)}{run.status === "running" ? " (ongoing)" : ""}</dd></div>
              <div><dt>Run kind</dt><dd>{run.runKind}</dd></div>
              <Show when={run.exitCode !== undefined}><div><dt>Exit code</dt><dd>{run.exitCode}</dd></div></Show>
            </dl>
            <Show when={run.gateOutput !== undefined}><div class="schedule-run-detail"><strong>Gate output</strong><pre>{run.gateOutput}</pre></div></Show>
            <Show when={run.error}><div class="schedule-run-detail schedule-runs-error"><strong>Error</strong><pre>{run.error}</pre></div></Show>
            </A>
          </li>
        )}</For>
      </ul>
    </>
  );
}

const STYLES = `
.schedule-runs { max-width: 860px; width: 100%; margin: 0 auto; padding: 32px 24px; box-sizing: border-box; color: var(--text-primary); }
.schedule-runs > a { color: var(--accent, #1a73e8); font-size: 13px; }
.schedule-runs h1 { margin: 20px 0 6px; font-size: 22px; }
.schedule-runs-job { margin: 0 0 18px; color: var(--text-secondary); font-size: 13px; overflow-wrap: anywhere; }
.schedule-runs-refresh { padding: 7px 12px; border: 1px solid var(--border-default); border-radius: 7px; background: var(--bg-surface); color: var(--text-primary); cursor: pointer; }
.schedule-runs-refresh:disabled { opacity: .55; cursor: progress; }
.schedule-run-list { display: grid; gap: 12px; margin: 18px 0 0; padding: 0; list-style: none; }
.schedule-run { padding: 16px; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-surface); font-size: 13px; }
.schedule-run-link { display: block; color: inherit; text-decoration: none; }
.schedule-run:has(.schedule-run-link:hover), .schedule-run:has(.schedule-run-link:focus-visible) { border-color: var(--accent, #1a73e8); }
.schedule-run header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.schedule-run-status { border-radius: 999px; padding: 3px 9px; font-size: 12px; font-weight: 600; color: var(--text-secondary); background: color-mix(in srgb, var(--text-secondary) 12%, transparent); }
.schedule-run[data-status="running"] .schedule-run-status { color: var(--accent, #1a73e8); background: color-mix(in srgb, var(--accent, #1a73e8) 12%, transparent); }
.schedule-run[data-status="error"] { border-color: var(--tone-error, #dc2626); }
.schedule-run[data-status="error"] .schedule-run-status { color: var(--tone-error, #dc2626); background: color-mix(in srgb, var(--tone-error, #dc2626) 12%, transparent); }
.schedule-run[data-status="interrupted"] { border-color: var(--tone-warning, #b7791f); }
.schedule-run[data-status="interrupted"] .schedule-run-status { color: var(--tone-warning, #b7791f); background: color-mix(in srgb, var(--tone-warning, #b7791f) 12%, transparent); }
.schedule-run dl { display: flex; flex-wrap: wrap; gap: 12px 24px; margin: 14px 0 0; }
.schedule-run dt { margin-bottom: 3px; color: var(--text-secondary); font-size: 12px; }
.schedule-run dd { margin: 0; }
.schedule-run-detail { margin-top: 14px; }
.schedule-run-detail strong { font-size: 12px; }
.schedule-run-detail pre { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.schedule-runs-error { color: var(--tone-error, #dc2626); }
`;
