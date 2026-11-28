import { A } from "@solidjs/router";
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { fetchAgents } from "../api";
import { API_BASE, apiFetch } from "../api/core";
import { fetchFeedWindow } from "../api/feed";
import { durableUnread, markDurableSeen } from "../lib/durable-activity";
import { AgentAvatarFill } from "./AgentAvatarFill";
import "./DurableAgentList.css";

const orderUrl = API_BASE + "/me/sidebar-order";
const orderLoadError = "Agent order could not be loaded.";

async function readOrder(ids?: string[]): Promise<string[]> {
  const response = await apiFetch(orderUrl, {
    signal: AbortSignal.timeout(15_000),
    ...(ids && { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentIds: ids }) }),
  });
  if (!response.ok) throw new Error("Unable to save or load agent order");
  const result = await response.json() as { agentIds?: unknown };
  if (!Array.isArray(result?.agentIds) || !result.agentIds.every((id): id is string => typeof id === "string")) {
    throw new Error("Invalid sidebar order");
  }
  return result.agentIds;
}

export function DurableAgentList(props: {
  selectedId?: string;
  readingId?: string;
  now: number;
  relativeTime: (timestamp: number, now: number) => string;
  Menu: (props: { label: string; children: JSX.Element }) => JSX.Element;
}) {
  const [error, setError] = createSignal("");
  const [agents, { refetch }] = createResource(async () => {
    try {
      const items = await fetchAgents();
      if (Array.isArray(items)) return items;
    } catch { /* Show the read failure and retry on focus. */ }
    setError("Agents could not be loaded.");
    return [];
  }, { initialValue: [] });
  const [order, setOrder] = createSignal<string[]>([]);
  let savedOrder: string[] = [];
  const [ready, setReady] = createSignal(false);
  const [activity, setActivity] = createSignal<Record<string, number>>({});
  const [dragged, setDragged] = createSignal<string>();
  const [drop, setDrop] = createSignal<{ id: string; after: boolean }>();
  const controller = new AbortController();
  const [saving, setSaving] = createSignal(false);
  let orderRead = 0;
  async function refreshOrder() {
    if (saving()) return;
    const request = ++orderRead;
    try {
      const ids = await readOrder();
      if (request !== orderRead) return;
      savedOrder = ids;
      setOrder(ids);
      setReady(true);
      setError((previous) => previous === orderLoadError ? "" : previous);
    } catch {
      if (request === orderRead) setError(orderLoadError);
    }
  }
  void refreshOrder();

  const displayed = createMemo(() => {
    const remaining = new Map(agents().map((agent) => [agent.id, agent]));
    const ordered = [];
    for (const id of order()) {
      const agent = remaining.get(id);
      if (!agent) continue;
      ordered.push(agent);
      remaining.delete(id);
    }
    return [...ordered, ...remaining.values()];
  });
  const displayedIds = createMemo(() => displayed().map(({ id }) => id));

  async function refreshActivity(onlyId?: string) {
    if (document.visibilityState !== "visible") return;
    await Promise.all(agents().filter((agent) => !agent.gateway && agent.durable && (!onlyId || agent.id === onlyId))
      .map(async ({ id }) => {
        try {
          const { items } = await fetchFeedWindow(id, {}, 1, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
          const timestamp = items.at(-1)?.timestamp ?? 0;
          setActivity((previous) => ({ ...previous, [id]: Math.max(previous[id] ?? 0, timestamp) }));
        } catch { /* Keep the last known activity on a transient read failure. */ }
      }));
  }
  const refreshAgents = () => { void refetch(); };
  const onFocus = () => { refreshAgents(); void refreshOrder(); };
  const onVisibility = () => { void refreshActivity(); };
  const settled = (event: Event) => { void refreshActivity((event as CustomEvent<string>).detail); };
  createEffect(() => { void refreshActivity(); });
  createEffect(() => {
    const id = props.readingId;
    if (id) markDurableSeen(id, activity()[id] ?? 0);
  });
  const poll = window.setInterval(onVisibility, 60_000);
  window.addEventListener("focus", onFocus);
  window.addEventListener("chat-projects-changed", refreshAgents);
  window.addEventListener("durable-history-updated", settled);
  document.addEventListener("visibilitychange", onVisibility);
  onCleanup(() => {
    orderRead++;
    controller.abort();
    window.clearInterval(poll);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("chat-projects-changed", refreshAgents);
    window.removeEventListener("durable-history-updated", settled);
    document.removeEventListener("visibilitychange", onVisibility);
  });

  async function move(id: string, index: number) {
    const ids = displayedIds();
    const from = ids.indexOf(id);
    if (!ready() || saving() || from === index || from < 0 || index < 0 || index >= ids.length) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(index, 0, id);
    orderRead++;
    setOrder(next);
    setSaving(true);
    setError("");
    try {
      savedOrder = await readOrder(next);
      setOrder(savedOrder);
    } catch {
      setOrder(savedOrder);
      setError("Agent order could not be saved. Try moving the agent again.");
    } finally {
      setSaving(false);
    }
  }

  const targetFor = (event: DragEvent & { currentTarget: HTMLDivElement }, id: string) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { id, after: event.clientY > box.top + box.height / 2 };
  };

  return (
    <section class="sidebar-sessions durable-agent-list" aria-label="Your agents" aria-busy={agents.loading}>
      <div class="sessions-header">Agents</div>
      <Show when={error()}><div role="alert" class="durable-agent-error">{error()}</div></Show>
      <div class="sessions-list">
        <For each={displayed()}>{(agent) => {
          const index = () => displayedIds().indexOf(agent.id);
          const canMove = () => ready() && !saving();
          const timestamp = () => !agent.gateway && agent.durable ? activity()[agent.id] ?? 0 : 0;
          const selected = () => props.selectedId === agent.id;
          return (
            <div class="session-row-wrap durable-agent-row" classList={{
              "drop-before": drop()?.id === agent.id && !drop()?.after,
              "drop-after": drop()?.id === agent.id && !!drop()?.after,
            }}
              onDragOver={(event) => {
                if (!canMove() || !dragged() || dragged() === agent.id) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                setDrop(targetFor(event, agent.id));
              }}
              onDragLeave={(event) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDrop(undefined);
              }}
              onDrop={(event) => {
                event.preventDefault();
                const id = dragged();
                const target = targetFor(event, agent.id);
                setDragged(undefined);
                setDrop(undefined);
                if (!canMove() || !id || id === agent.id) return;
                void move(id, index() + Number(target.after) - Number(displayedIds().indexOf(id) < index()));
              }}
            >
              <span role="button" class="durable-agent-grip" aria-label={`Drag ${agent.name} to reorder`} draggable={canMove()}
                onDragStart={(event) => {
                  event.dataTransfer?.setData("text/plain", agent.id);
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                  setDragged(agent.id);
                }}
                onDragEnd={() => { setDragged(undefined); setDrop(undefined); }}
              ><i class="fa-solid fa-grip-vertical" aria-hidden="true" /></span>
              <A href={`/chat/${encodeURIComponent(agent.id)}`} class="session-row durable-agent-link" classList={{ active: selected() }}
                aria-current={selected() ? "page" : undefined} title={agent.name}
                onKeyDown={(event) => {
                  if (!canMove() || !event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
                  event.preventDefault();
                  const row = event.currentTarget;
                  void move(agent.id, index() + (event.key === "ArrowUp" ? -1 : 1));
                  row.focus({ preventScroll: true });
                }}
              >
                <span class="session-avatar"><AgentAvatarFill avatar={agent.avatar} agentId={agent.id} /></span>
                <Show when={props.readingId !== agent.id && durableUnread(agent.id, timestamp())}>
                  <span class="session-unread-dot" role="img" aria-label="Unread messages" />
                </Show>
                <span class="durable-agent-copy">
                  <span class="durable-agent-name">{agent.name}</span>
                  <Show when={agent.role?.trim() || agent.description}>
                    {(subtitle) => <span class="durable-agent-description">{subtitle()}</span>}
                  </Show>
                </span>
                <Show when={timestamp() > 0}>
                  <time class="durable-agent-time" dateTime={new Date(timestamp()).toISOString()}>{props.relativeTime(timestamp(), props.now)}</time>
                </Show>
              </A>
              <props.Menu label={`${agent.name} menu`}>
                <button class="session-action" type="button" disabled={!canMove() || index() === 0}
                  onClick={() => void move(agent.id, index() - 1)}>Move up</button>
                <button class="session-action" type="button" disabled={!canMove() || index() === displayedIds().length - 1}
                  onClick={() => void move(agent.id, index() + 1)}>Move down</button>
              </props.Menu>
            </div>
          );
        }}</For>
      </div>
    </section>
  );
}
