import { createEffect, createSignal, createUniqueId, onCleanup, onMount, Show, type JSX } from "solid-js";

export function ChatToolbarOverflow(props: { children: JSX.Element }) {
  const [compact, setCompact] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  const id = createUniqueId();
  let root!: HTMLDivElement;
  let trigger: HTMLButtonElement | undefined;

  onMount(() => {
    if (typeof ResizeObserver === "undefined") return;
    const toolbar = root.parentElement!;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const narrow = entry.contentRect.width <= 560;
      setCompact(narrow);
      if (!narrow) setOpen(false);
    });
    observer.observe(toolbar);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    if (!open()) return;
    function dismiss(event: PointerEvent) {
      if (!root.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    onCleanup(() => document.removeEventListener("pointerdown", dismiss));
  });

  return (
    <div class="chat-toolbar-overflow" ref={root} classList={{ compact: compact() }} onKeyDown={(event) => {
      if (event.key !== "Escape" || event.defaultPrevented || !open()) return;
      event.preventDefault();
      setOpen(false);
      trigger?.focus();
    }}>
      <Show when={compact()}>
        <button
          ref={trigger}
          type="button"
          class="chat-overflow-trigger"
          aria-label="More chat controls"
          title="More chat controls"
          aria-expanded={open()}
          aria-controls={id}
          onClick={() => setOpen(!open())}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
      </Show>
      <div id={id} class="chat-overflow-controls" hidden={compact() && !open()}>
        {props.children}
      </div>
    </div>
  );
}
