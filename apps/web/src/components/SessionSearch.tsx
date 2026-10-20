import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { stripBase } from "../lib/path";
import { Modal } from "./ui/Modal";
import { searchSessions } from "../api/chat";
import type { SessionSearchResult } from "../api/types";

const [searchOpen, setSearchOpen] = createSignal(false);

export function openSessionSearch() {
  setSearchOpen(true);
}

export function SessionSearch() {
  const location = useLocation();
  createEffect(() => {
    if (stripBase(location.pathname).startsWith("/login")) {
      setSearchOpen(false);
      return;
    }
    const handleKey = (event: KeyboardEvent) => {
      if (searchOpen() && event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setSearchOpen(false);
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        openSessionSearch();
      }
    };
    window.addEventListener("keydown", handleKey, true);
    onCleanup(() => window.removeEventListener("keydown", handleKey, true));
  });
  onCleanup(() => setSearchOpen(false));

  return (
    <Show when={searchOpen()}>
      <SearchPalette onClose={() => setSearchOpen(false)} />
    </Show>
  );
}

function SearchPalette(props: { onClose: () => void }) {
  const navigate = useNavigate();
  const listId = createUniqueId();
  const [query, setQuery] = createSignal("");
  const [items, setItems] = createSignal<SessionSearchResult[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  onMount(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    onCleanup(() => {
      document.body.style.overflow = previous;
    });
  });
  const open = (item: SessionSearchResult) => {
    props.onClose();
    navigate(
      `/chat/${encodeURIComponent(item.agentId)}?session=${encodeURIComponent(item.sessionId)}`
    );
  };
  createEffect(() => {
    const value = query().trim();
    setItems([]);
    setSelected(0);
    setError("");
    setLoading(Boolean(value));
    if (!value) return;
    let current = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void searchSessions(value, controller.signal)
        .then((result) => {
          if (current) setItems(result.items);
        })
        .catch(() => {
          if (current) setError("Unable to search chats. Try again.");
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }, 200);
    onCleanup(() => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    });
  });
  return (
    <div class="session-search">
      <Modal title="Search chats" titleHidden onClose={props.onClose} size="lg">
        <div class="session-search-field">
          <i class="fa-solid fa-magnifying-glass" aria-hidden="true" />
          <input
            role="combobox"
            aria-label="Search chats"
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded={items().length > 0}
            aria-activedescendant={
              items().length ? `${listId}-${selected()}` : undefined
            }
            placeholder="Search titles and messages in your chats"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (!items().length) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setSelected(
                  (index) =>
                    (index +
                      (event.key === "ArrowDown" ? 1 : items().length - 1)) %
                    items().length
                );
                document
                  .getElementById(`${listId}-${selected()}`)
                  ?.scrollIntoView?.({ block: "nearest" });
              } else if (event.key === "Enter") {
                event.preventDefault();
                open(items()[selected()]);
              }
            }}
          />
        </div>
        <Show when={error()}>
          <div class="session-search-state" role="alert">
            {error()}
          </div>
        </Show>
        <Show
          when={query().trim() && !error() && (loading() || !items().length)}
        >
          <div class="session-search-state" role="status">
            {loading() ? "Searching…" : "No matches. Try different words."}
          </div>
        </Show>
        <Show when={items().length}>
          <div
            class="session-search-results"
            id={listId}
            role="listbox"
            aria-label="Matching chats"
          >
            <For each={items()}>
              {(item, index) => (
                <button
                  class="session-search-result"
                  id={`${listId}-${index()}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected() === index()}
                  onClick={() => open(item)}
                >
                  <span class="session-search-avatar" aria-hidden="true">
                    <Show
                      when={item.avatar}
                      fallback={item.agentId[0]?.toUpperCase()}
                    >
                      {(avatar) => (
                        <Show
                          when={
                            avatar().startsWith("/") ||
                            /^https?:\/\//i.test(avatar())
                          }
                          fallback={avatar()}
                        >
                          <img src={avatar()} alt="" />
                        </Show>
                      )}
                    </Show>
                  </span>
                  <span class="session-search-copy">
                    <span class="session-search-title">
                      <Highlight
                        text={
                          item.title || item.firstUserMessage || item.sessionId
                        }
                        query={query()}
                      />
                    </span>
                    <span class="session-search-meta">
                      {item.agentId} ·{" "}
                      <time
                        title={new Date(item.lastActivity).toLocaleString()}
                      >
                        {relativeTime(item.lastActivity)}
                      </time>
                    </span>
                    <Show when={item.snippet}>
                      {(snippet) => (
                        <span class="session-search-snippet">
                          <Highlight text={snippet()} query={query()} />
                        </span>
                      )}
                    </Show>
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </Modal>
      <style>{`
      .session-search .ui-modal-overlay {
        align-items: flex-start;
        padding: min(12vh, 96px) 16px 16px;
      }
      .session-search .ui-modal { width: min(640px, 100%); max-height: 80dvh; }
      .session-search .ui-modal__body { padding: 0; gap: 0; }
      .session-search-field { display: flex; align-items: center; gap: 12px; padding: 0 16px; color: var(--text-secondary); }
      .session-search-field input {
        width: 100%; min-width: 0; min-height: 56px; padding: 16px 0;
        border: none; outline: none; background: transparent; color: var(--text-primary);
        font: inherit; font-size: 16px; caret-color: var(--text-primary);
      }
      .session-search-field input::placeholder { color: var(--text-secondary); opacity: 1; }
      .session-search-state { padding: 24px 16px; color: var(--text-secondary); font-size: 14px; }
      .session-search-state[role="alert"] { color: var(--tone-error); }
      .session-search-results {
        max-height: min(56vh, 480px); overflow-y: auto; padding: 8px;
        border-top: 1px solid var(--border-subtle); scrollbar-width: thin;
        scrollbar-color: var(--scrollbar-thumb) transparent;
      }
      .session-search-result {
        display: flex; gap: 12px; width: 100%; min-height: 64px; padding: 12px;
        border: none; border-radius: 6px; background: transparent; color: var(--text-primary);
        font: inherit; text-align: left; cursor: pointer;
      }
      .session-search-result:hover, .session-search-result[aria-selected="true"] { background: var(--bg-raised); }
      .session-search-result:active { background: var(--border-default); }
      .session-search-result:focus-visible { outline: 2px solid var(--text-secondary); outline-offset: -2px; }
      .session-search-avatar {
        display: grid; place-items: center; flex: 0 0 32px; width: 32px; height: 32px;
        border-radius: 8px; background: var(--bg-base); color: var(--text-secondary); font-size: 16px;
      }
      .session-search-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
      .session-search-copy { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; }
      .session-search-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
      .session-search-meta { color: var(--text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
      .session-search-snippet { color: var(--text-secondary); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
      .session-search mark, .session-search ::selection {
        background: color-mix(in srgb, var(--tone-user) 25%, transparent); color: var(--text-primary);
      }
      .session-search mark { font-weight: 650; }
      @media (max-width: 480px) {
        .session-search .ui-modal-overlay { padding: 16px 8px; }
        .session-search .ui-modal { max-height: calc(100dvh - 32px); }
        .session-search-results { max-height: 60dvh; }
        .session-search-field { padding: 0 12px; gap: 8px; }
      }
    `}</style>
    </div>
  );
}

function Highlight(props: { text: string; query: string }) {
  const parts = () => {
    const words = props.query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (!words.length) return [props.text];
    const pattern = words
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    return props.text.split(new RegExp(`(${pattern})`, "gi"));
  };
  return (
    <For each={parts()}>
      {(part, index) => (index() % 2 ? <mark>{part}</mark> : part)}
    </For>
  );
}

function relativeTime(timestamp: number) {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}
