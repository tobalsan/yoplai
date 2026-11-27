import { createSignal, For, Show } from "solid-js";
import type { AgentMemory } from "@yoplai/shared/types";
import { formatTimestamp } from "../../lib/format";

const groups = [
  { kind: "open", title: "Open loops", icon: "fa-regular fa-circle" },
  { kind: "decision", title: "Decisions", icon: "fa-solid fa-check" },
  { kind: "digest", title: "Summaries", icon: "fa-solid fa-align-left" },
] as const;
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const shortTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function memoryFraction(gauge?: AgentMemory["gauge"]) {
  return gauge?.ceilingTokens ? Math.max(0, Math.min(1, gauge.inputTokens / gauge.ceilingTokens)) : 0;
}

export function MemoryPanel(props: {
  agentName: string;
  data?: AgentMemory;
  fetchedAt?: number;
  loading: boolean;
  error?: boolean;
  retry(): void;
  jump(id: string): void;
  openThread(id: string): void;
}) {
  const [expanded, setExpanded] = createSignal<string>();
  const fraction = () => memoryFraction(props.data?.gauge);
  const full = () => fraction() >= 0.7;
  return (
    <section class="memory-panel" aria-label={`What ${props.agentName} remembers`} aria-busy={props.loading}>
      <h2>What {props.agentName} remembers</h2>
      <Show when={props.error}>
        <div class="memory-error" role="status">Memory could not be loaded. <button type="button" onClick={props.retry}>Try again</button></div>
      </Show>
      <Show when={props.data} fallback={<Show when={props.loading}><p role="status">Loading memory…</p></Show>}>
        {(memory) => <>
          <div class="memory-gauge" classList={{ "memory-full": full() }}>
            <div class="memory-gauge-top">
              <strong>{full() ? "Getting full" : "Plenty of room"}</strong>
              <Show when={props.fetchedAt}>{(time) => <time dateTime={new Date(time()).toISOString()}>Updated {shortTime.format(time())}</time>}</Show>
            </div>
            <p>When working memory fills up, {props.agentName} tidies it and keeps the conversation available.</p>
            <div class="memory-gauge-track" aria-hidden="true"><span style={{ width: `${fraction() * 100}%` }} /></div>
          </div>
          <For each={groups}>{(group) => {
            const rows = () => memory().topics.filter((topic) => topic.kind === group.kind);
            return <details class="memory-group" open={group.kind === "open"}>
              <summary>{group.title}</summary>
              <Show when={rows().length} fallback={<p class="memory-empty">No {group.title.toLowerCase()} yet.</p>}>
                <For each={rows().map(({ id }) => id)}>{(id) => {
                  const topic = () => rows().find((row) => row.id === id)!;
                  return <div class="memory-topic">
                    <button type="button" class="memory-topic-toggle" aria-expanded={expanded() === id}
                      onClick={() => setExpanded(expanded() === id ? undefined : id)}>
                      <i class={group.icon} aria-hidden="true" />
                      <span title={topic().title}>{topic().title}</span>
                      <Show when={topic().updatedAt !== null}><time>{shortDate.format(topic().updatedAt!)}</time></Show>
                    </button>
                    <Show when={expanded() === id}>
                      <div class="memory-topic-content">
                        <p>{topic().note}</p>
                        <Show when={topic().refs[0]}>{(ref) =>
                          <blockquote>
                            <cite>{ref().sender ?? (ref().role === "assistant" ? props.agentName : "You")} · {formatTimestamp(ref().timestamp)}</cite>
                            <p>{ref().text}</p>
                          </blockquote>
                        }</Show>
                        <div class="memory-refs">
                          <For each={topic().refs}>{(ref) =>
                            <button type="button" aria-label={`Jump to message ${ref.id}`} onClick={() => props.jump(ref.id)}>#{ref.id}</button>
                          }</For>
                          <Show when={topic().threadId}>{(threadId) =>
                            <button type="button" aria-label={`Open thread for ${topic().title}`} onClick={() => props.openThread(threadId())}>
                              <i class="fa-solid fa-code-branch" aria-hidden="true" /> Open thread
                            </button>
                          }</Show>
                        </div>
                      </div>
                    </Show>
                  </div>;
                }}</For>
              </Show>
            </details>;
          }}</For>
          <section class="memory-plan" aria-label="Plan">
            <h3>Plan</h3>
            <Show when={memory().plan.goals.length || memory().plan.nextSteps.length} fallback={<p class="memory-empty">No plan yet.</p>}>
              <Show when={memory().plan.goals.length}>
                <h4>Goals</h4>
                <ul><For each={memory().plan.goals}>{(goal) => <li>{goal}</li>}</For></ul>
              </Show>
              <Show when={memory().plan.nextSteps.length}>
                <h4>Next steps</h4>
                <ol><For each={memory().plan.nextSteps}>{(step) => <li>{step}</li>}</For></ol>
              </Show>
            </Show>
          </section>
        </>}
      </Show>
    </section>
  );
}
