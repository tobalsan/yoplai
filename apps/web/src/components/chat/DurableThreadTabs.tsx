import { createEffect, createResource, createSignal, createUniqueId, For, Show, type Accessor } from "solid-js";
import { closeThread, fetchThreads, reopenThread, startThread, type DurableThread } from "../../api/durable";
import { durableUnread, markDurableSeen } from "../../lib/durable-activity";
import { impersonationStatus } from "../ImpersonationBanner";

export function createDurableThreads(agentId: Accessor<string | undefined>, active: Accessor<string | undefined>, select: (id?: string) => void) {
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [threads, { refetch, mutate }] = createResource<{ agentId: string; items: DurableThread[] }, string>(
    agentId,
    async (id, { value }) => {
      try { return { agentId: id, items: await fetchThreads(id) }; }
      catch {
        if (agentId() === id) setError("Could not load threads.");
        return { agentId: id, items: value?.agentId === id ? value.items : [] };
      }
    },
  );
  const items = () => {
    const result = threads.latest;
    return result?.agentId === agentId() ? result?.items ?? [] : [];
  };
  createEffect(() => {
    agentId();
    setError("");
  });

  createEffect(() => {
    const id = agentId();
    const current = items().find(({ id }) => id === active());
    if (id && current) markDurableSeen(id, current.lastActivityAt, current.id);
  });

  async function change(action: (id: string) => Promise<DurableThread>, next: (thread: DurableThread) => void) {
    const id = agentId();
    if (!id || busy() || impersonationStatus()?.active) return;
    setError("");
    setBusy(true);
    try {
      const thread = await action(id);
      if (agentId() !== id) return;
      mutate({
        agentId: id,
        items: [...items().filter((item) => item.id !== thread.id), thread].sort((a, b) => b.lastActivityAt - a.lastActivityAt),
      });
      next(thread);
    } catch (error) {
      if (agentId() === id) setError(error instanceof Error ? error.message : "The thread could not be updated.");
    } finally {
      if (agentId() === id) void refetch();
      setBusy(false);
    }
  }

  return {
    items, active, select, error, busy,
    refresh: () => { if (agentId()) void refetch(); },
    start: (messageId?: string) => change((id) => startThread(id, messageId), (thread) => select(thread.id)),
    close: (thread: DurableThread) => change((id) => closeThread(id, thread), () => { if (active() === thread.id) select(); }),
    open(id: string) {
      const thread = items().find((item) => item.id === id);
      if (thread && !thread.closed) select(id);
      else return change((agent) => reopenThread(agent, id), () => select(id));
    },
  };
}

export function DurableThreadTabs(props: { agentId: string; threads: ReturnType<typeof createDurableThreads> }) {
  const { threads } = props;
  const mainId = createUniqueId();
  const [menu, setMenu] = createSignal<HTMLDetailsElement>();
  const canChange = () => !threads.busy() && !impersonationStatus()?.active;
  const open = () => threads.items().filter((thread) => !thread.closed);
  const closed = () => threads.items().filter((thread) => thread.closed);

  function navigateTabs(event: KeyboardEvent, current?: string) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const keys = [undefined, ...open().map(({ id }) => id)];
    const index = keys.indexOf(current);
    let next: number;
    switch (event.key) {
      case "Home": next = 0; break;
      case "End": next = keys.length - 1; break;
      case "ArrowLeft": next = (index + keys.length - 1) % keys.length; break;
      case "ArrowRight": next = (index + 1) % keys.length; break;
      default: return;
    }
    event.preventDefault();
    const target = keys[next];
    threads.select(target);
    document.getElementById(mainId + (target ?? ""))?.focus();
  }

  return <>
    <div class="durable-thread-bar">
      <div class="durable-thread-tabs" role="tablist" aria-label="Conversation and threads">
        <button id={mainId} type="button" role="tab" class="durable-thread-tab" aria-selected={!threads.active()}
          tabIndex={threads.active() ? -1 : 0} onClick={() => threads.select()} onKeyDown={navigateTabs}>
          <i class="fa-solid fa-thumbtack" aria-hidden="true" /> Main
        </button>
        <For each={open().map(({ id }) => id)}>{(id) => {
          const thread = () => open().find((item) => item.id === id)!;
          const active = () => threads.active() === id;
          return <div class="durable-thread-item" role="presentation" classList={{ selected: active() }}>
            <button id={mainId + id} type="button" class="durable-thread-tab" role="tab"
              aria-selected={active()} tabIndex={active() ? 0 : -1} title={thread().title}
              onClick={() => threads.select(id)} onKeyDown={(event) => navigateTabs(event, id)}>
              <span>{thread().title}</span>
              <Show when={!active() && durableUnread(props.agentId, thread().lastActivityAt, id)}>
                <span class="durable-thread-dot" role="img" aria-label="Unread messages" />
              </Show>
            </button>
            <button type="button" class="durable-thread-close" disabled={!canChange()} aria-label={`Close ${thread().title}`}
              onClick={() => void threads.close(thread())}><i class="fa-solid fa-xmark" aria-hidden="true" /></button>
          </div>;
        }}</For>
      </div>
      <button type="button" class="durable-thread-action" title="New thread" aria-label="New thread"
        disabled={!canChange()} onClick={() => void threads.start()}><i class="fa-solid fa-plus" aria-hidden="true" /></button>
      <details class="durable-thread-menu" ref={setMenu} onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}>
        <summary class="durable-thread-action">Threads <i class="fa-solid fa-chevron-down" aria-hidden="true" /></summary>
        <div class="durable-thread-menu-items">
          <Show when={closed().length} fallback={<span>No closed threads</span>}>
            <For each={closed()}>{(thread) =>
              <button type="button" class="session-action" disabled={!canChange()} onClick={() => {
                const details = menu();
                if (details) details.open = false;
                void threads.open(thread.id);
              }}>{thread.title}</button>
            }</For>
          </Show>
        </div>
      </details>
    </div>
    <Show when={threads.error()}><div role="alert" class="durable-thread-error">{threads.error()}</div></Show>
  </>;
}
