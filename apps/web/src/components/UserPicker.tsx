import { For, Show, createEffect, createMemo, createSignal, createUniqueId, untrack } from "solid-js";
import { UserAvatar } from "./UserAvatar";

const MAX_RESULTS = 50;

/** Searchable user combobox: type part of a name or email, then pick with the mouse or arrow keys + Enter. Enter also calls `onEnter` after a pick. */
export function UserPicker(props: {
  users: { id: string; label: string; name?: string | null; image?: string | null }[];
  value: string;
  onChange: (id: string) => void;
  /** Called after Enter picks a user, or on Enter when a user is already picked. */
  onEnter?: () => void;
  disabled?: boolean;
  /** Overrides the search hint, e.g. to say why the picker is disabled. */
  placeholder?: string;
  class?: string;
}) {
  const listId = createUniqueId();
  const [query, setQuery] = createSignal("");
  const [wantsOpen, setOpen] = createSignal(false);
  // Show the list only after the user types: focus alone must not cover the dialog or list every user.
  const open = () => wantsOpen() && query().trim() !== "";
  const [active, setActive] = createSignal(0);
  const matches = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return props.users.filter((user) => user.label.toLowerCase().includes(needle)).slice(0, MAX_RESULTS);
  });
  let pickedLabel = "";
  // The parent clears the value after it adds the user: clear the picked label too, but keep typed text.
  createEffect(() => { if (!props.value && untrack(query) === pickedLabel) setQuery(""); });
  const pick = (user: { id: string; label: string }) => {
    pickedLabel = user.label;
    setQuery(user.label);
    setOpen(false);
    props.onChange(user.id);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const count = matches().length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open()) { setOpen(true); setActive(0); return; }
      if (count) setActive((active() + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
    } else if (event.key === "Enter" && open() && matches()[active()]) {
      event.preventDefault();
      pick(matches()[active()]!);
      props.onEnter?.();
    } else if (event.key === "Enter" && !open() && props.value) {
      event.preventDefault();
      props.onEnter?.();
    } else if (event.key === "Escape" && open()) {
      // Close only the list, not the surrounding modal.
      event.stopPropagation();
      setOpen(false);
    }
  };
  return (
    <div class={`user-picker ${props.class ?? ""}`}>
      <i class="fa-solid fa-magnifying-glass user-picker__icon" aria-hidden="true" />
      <input type="text" role="combobox" aria-label="Select a user" aria-autocomplete="list" aria-controls={listId}
        aria-expanded={open()} aria-activedescendant={open() && matches()[active()] ? `${listId}-${active()}` : undefined}
        placeholder={props.placeholder ?? "Search by name or email…"} autocomplete="off" value={query()} disabled={props.disabled}
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          setActive(0);
          setOpen(true);
          if (props.value) props.onChange("");
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        on:keydown={onKeyDown} />
      <Show when={open()}>
        <ul id={listId} role="listbox" class="user-picker__list">
          <For each={matches()} fallback={<li class="user-picker__empty">No matching users</li>}>{(user, index) => (
            <li id={`${listId}-${index()}`} role="option" aria-selected={index() === active()} class="user-picker__option"
              onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index())} onClick={() => pick(user)}>
              <UserAvatar class="user-picker__avatar" name={user.name ?? user.label} image={user.image} />
              <span>{user.label}</span>
            </li>
          )}</For>
        </ul>
      </Show>
      <style>{`
        div.user-picker { position: relative; display: flex; align-items: center; padding: 0; }
        .user-picker__icon { position: absolute; left: 10px; font-size: 12px; color: var(--text-tertiary, var(--text-secondary)); pointer-events: none; }
        .user-picker input { flex: 1; min-width: 0; padding: 7px 8px 7px 30px; border: 0; border-radius: inherit; background: transparent; color: inherit; font: inherit; outline: none; }
        .user-picker:has(input:disabled) { opacity: 0.6; cursor: not-allowed; }
        .user-picker input:disabled { cursor: not-allowed; }
        .user-picker:focus-within { outline: 2px solid var(--accent, #3b82f6); outline-offset: 1px; }
        .user-picker__list { position: absolute; z-index: 10; top: calc(100% + 4px); left: 0; right: 0; max-height: 240px; overflow-y: auto; margin: 0; padding: 4px; list-style: none; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12); }
        .user-picker__option { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 6px; font-size: 13px; color: var(--text-primary); cursor: pointer; overflow-wrap: anywhere; }
        .user-picker__avatar { flex: none; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--bg-raised); color: var(--text-secondary); font-size: 11px; font-weight: 600; }
        .user-picker__option[aria-selected="true"] { background: var(--bg-raised); }
        .user-picker__empty { padding: 7px 8px; font-size: 13px; color: var(--text-secondary); }
      `}</style>
    </div>
  );
}
