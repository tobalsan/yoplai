import { A, useParams } from "@solidjs/router";
import { createEffect, createMemo, createResource, on, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { ScheduleRunTrace as RunTrace } from "@yoplai/shared/types";
import { fetchScheduleRunTrace } from "../api/schedules";
import { BoardChatLog, buildBoardLogs } from "../components/BoardChatRenderer";
import { decodeRouteParam } from "../lib/path";
import { useAgentTarget } from "../lib/agent-target";
import { useRequester } from "../lib/requester";
import { gatewayKey } from "../api/gateway";

export function ScheduleRunTrace() {
  const routeParams = useParams<{ agentId: string; jobId: string; runId: string }>();
  // Router params keep the raw path segment. Job and run IDs are arbitrary strings.
  const params = {
    get agentId() { return decodeRouteParam(routeParams.agentId); },
    get jobId() { return decodeRouteParam(routeParams.jobId); },
    get runId() { return decodeRouteParam(routeParams.runId); },
  };
  const { target, retry } = useAgentTarget(() => params.agentId);
  const gateway = () => { const current = target(); return current.state === "ready" ? current.gateway : undefined; };
  const requester = useRequester(gateway);
  // A local page reads the local capabilities. A remote page waits for the capabilities of its gateway.
  const contextReady = () => gateway() === undefined || requester().ready;
  let scrollContainer!: HTMLElement;
  let followBottom = true;
  return (
    <main ref={scrollContainer} class="schedule-run-trace" onScroll={() => {
      followBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 64;
    }}>
      <style>{STYLES}</style>
      <A href={`/agents/${encodeURIComponent(params.agentId)}/schedules/${encodeURIComponent(params.jobId)}/runs`}>Back to run history</A>
      <h1>Run trace</h1>
      <p>Job: {params.jobId}</p>
      <Show when={target().state === "missing"}>
        <p role="alert">This agent is unavailable. Check that its gateway is online. <button type="button" onClick={retry}>Retry</button></p>
      </Show>
      <Show when={target().state === "loading" || (target().state === "ready" && !contextReady())}><p role="status">Loading run trace…</p></Show>
      <Show when={target().state === "ready" && contextReady()}>
        <Show when={requester().isExtensionEnabled("scheduler") && requester().enableCronMonitoring} fallback={<p>Run trace is unavailable.</p>}>
          <LoadTrace agentId={params.agentId} jobId={params.jobId} runId={params.runId} gateway={gateway()} scrollContainer={scrollContainer} followBottom={() => followBottom} />
        </Show>
      </Show>
    </main>
  );
}

function LoadTrace(props: { agentId: string; jobId: string; runId: string; gateway?: string; scrollContainer: HTMLElement; followBottom: () => boolean }) {
  const [result, { refetch }] = createResource(
    () => ({ agentId: props.agentId, jobId: props.jobId, runId: props.runId, gateway: props.gateway }),
    async ({ agentId, jobId, runId, gateway }, { value }): Promise<{ key: string; trace?: RunTrace; error?: string }> => {
      const key = gatewayKey(gateway, agentId, jobId, runId);
      try {
        return { key, trace: await fetchScheduleRunTrace(agentId, jobId, runId, gateway), error: undefined };
      } catch (cause) {
        // Keep an earlier trace only for the same gateway, agent, job, and run.
        return { key, trace: value?.key === key ? value.trace : undefined, error: cause instanceof Error ? cause.message : "Failed to load run trace." };
      }
    }
  );
  const poll = setInterval(() => {
    if (!result.loading && result.latest?.trace?.run.status === "running") void refetch();
  }, 2_000);
  onCleanup(() => clearInterval(poll));
  return (
    <>
      <button type="button" disabled={result.loading} onClick={() => void refetch()}>{result.latest?.error ? "Retry" : "Refresh"}</button>
      <Show when={result.loading && !result.latest}><p role="status">Loading run trace…</p></Show>
      <Show when={result.latest?.error}>{(error) => <p role="alert">{error()}</p>}</Show>
      <Show when={result.latest?.trace}>{(trace) => <TraceContent trace={trace()} scrollContainer={props.scrollContainer} followBottom={props.followBottom} />}</Show>
    </>
  );
}

function TraceContent(props: { trace: RunTrace; scrollContainer: HTMLElement; followBottom: () => boolean }) {
  const startedRunning = props.trace.run.status === "running";
  const [logs, setLogs] = createStore(buildBoardLogs(props.trace.messages));
  createEffect(() => setLogs(reconcile(buildBoardLogs(props.trace.messages), { key: null, merge: true })));
  const anchorIndex = createMemo(() => {
    if (props.trace.run.status === "running") return -1;
    const messages = props.trace.messages;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      if (message.role !== "assistant") continue;
      const ownLogs = buildBoardLogs([message]);
      const firstText = ownLogs.findIndex((item) => item.type === "text" && item.role === "assistant");
      if (firstText >= 0) return buildBoardLogs(messages.slice(0, index)).length + firstText;
    }
    return -1;
  });
  let finalOutput: HTMLDivElement | undefined;
  createEffect(on(() => props.trace, () => {
    if (startedRunning) queueMicrotask(() => {
      if (props.followBottom()) props.scrollContainer.scrollTop = props.scrollContainer.scrollHeight;
    });
  }));
  onMount(() => {
    if (anchorIndex() >= 0) finalOutput?.scrollIntoView({ block: "start" });
  });
  return (
    <>
      <p class="schedule-trace-status">{props.trace.run.status} · {props.trace.run.runKind}</p>
      <section class="schedule-trace-prompt"><h2>Prompt</h2><pre>{props.trace.run.prompt || "No agent prompt."}</pre></section>
      <Show when={props.trace.run.gateOutput !== undefined}><section><h2>Gate output</h2><pre>{props.trace.run.gateOutput}</pre></section></Show>
      <Show when={props.trace.run.error}><section role="alert"><h2>Error</h2><pre>{props.trace.run.error}</pre></section></Show>
      <Show when={props.trace.messages.length > 0} fallback={<p>{props.trace.run.runKind === "silent_tick" || props.trace.run.runKind === "script_only" ? "This run did not invoke the agent." : "No conversation history is available for this run."}</p>}>
        <div class="schedule-trace-history">
          <BoardChatLog items={anchorIndex() < 0 ? logs : logs.slice(0, anchorIndex())} agentName={props.trace.run.agentId} showToolDetails />
          <Show when={anchorIndex() >= 0}>
            <div ref={finalOutput} class="schedule-trace-final" classList={{ "schedule-trace-live-finished": startedRunning }} data-final-output>
              <BoardChatLog items={logs.slice(anchorIndex())} agentName={props.trace.run.agentId} showToolDetails />
            </div>
          </Show>
        </div>
      </Show>
    </>
  );
}

const STYLES = `
.schedule-run-trace { flex: 1; height: 100%; box-sizing: border-box; min-height: 0; overflow-y: auto; padding: 32px 24px; color: var(--text-primary); }
.schedule-run-trace > * { max-width: 860px; margin-left: auto; margin-right: auto; }
.schedule-run-trace > a { display: block; color: var(--accent, #1a73e8); font-size: 13px; }
.schedule-run-trace h1 { font-size: 22px; margin-top: 20px; }
.schedule-run-trace h2 { font-size: 13px; color: var(--text-secondary); }
.schedule-run-trace pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.schedule-run-trace > button { display: block; padding: 7px 12px; border: 1px solid var(--border-default); border-radius: 7px; background: var(--bg-surface); color: var(--text-primary); cursor: pointer; }
.schedule-run-trace > button:disabled { opacity: .55; cursor: progress; }
.schedule-run-trace [role="alert"] { color: var(--tone-error, #dc2626); }
.schedule-trace-prompt { border: 1px solid var(--border-default); border-radius: 12px; padding: 12px 16px; box-sizing: border-box; }
.schedule-trace-history { margin-top: 24px; }
.schedule-trace-final { margin-top: 24px; min-height: calc(100dvh - 64px); }
.schedule-trace-live-finished { min-height: 0; }
`;
