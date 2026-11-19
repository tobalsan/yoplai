import { For, Show, createMemo, createSignal, createUniqueId, onCleanup, onMount, type JSX } from "solid-js";
import "./SearchPicker.css";

export type PickerRow = {
  id: string;
  content: JSX.Element;
  value?: string;
  expand?: string;
};

type PickerGroup = { id: string; label?: string; rows: PickerRow[] };

export function SearchPicker(props: {
  label: string;
  placeholder: string;
  searchLabel: string;
  selected?: string;
  summary?: JSX.Element;
  selectionLabel?: string;
  disabled?: boolean;
  groups: (query: string, expanded: string | undefined) => PickerGroup[];
  focusOnMount?: boolean;
  onQuery?: (query: string) => void;
  onSelect: (value: string) => void;
}) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [started, setStarted] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal<string>();
  const [expanded, setExpanded] = createSignal<string>();
  const groups = createMemo(() => started() ? props.groups(query(), expanded()) : []);
  const rows = createMemo(() => groups().flatMap((group) => group.rows));
  const rowId = (row: string) => `${id}-${encodeURIComponent(row)}`;
  let trigger!: HTMLButtonElement;
  let panel!: HTMLDivElement;
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;

  onMount(() => { if (props.focusOnMount) trigger.focus(); });

  const position = (event?: Event) => {
    if (event?.target === list) return;
    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 64;
    const above = rect.top - 48;
    const up = below < 284 && above > below;
    panel.dataset.side = up ? "above" : "below";
    panel.style.setProperty("--picker-width", `${rect.width}px`);
    panel.style.setProperty("--picker-left", `${rect.left}px`);
    panel.style.setProperty("--picker-edge", `${up ? window.innerHeight - rect.top + 6 : rect.bottom + 6}px`);
    panel.style.setProperty("--picker-space", `${Math.max(80, (up ? above : below) - 6)}px`);
  };
  const contains = (target: EventTarget | null) => target instanceof Node && (trigger.contains(target) || panel.contains(target));
  const dismiss = (event: Event) => { if (!contains(event.target)) close(); };
  const stopListening = () => {
    document.removeEventListener("pointerdown", dismiss);
    document.removeEventListener("focusin", dismiss);
    window.removeEventListener("resize", position);
    window.removeEventListener("scroll", position, true);
  };
  onCleanup(stopListening);

  function close(restoreFocus = false) {
    stopListening();
    panel.hidePopover?.();
    panel.style.removeProperty("display");
    setOpen(false);
    if (restoreFocus) trigger.focus();
  }

  const moveTo = (row?: PickerRow) => {
    setActive(row?.id);
    const option = row && document.getElementById(rowId(row.id));
    if (!option) return;
    const item = option.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    if (item.top < viewport.top) list.scrollTop -= viewport.top - item.top;
    else if (item.bottom > viewport.bottom) list.scrollTop += item.bottom - viewport.bottom;
  };
  const start = (last = false) => {
    setQuery("");
    setExpanded(undefined);
    setStarted(true);
    setOpen(true);
    position();
    panel.style.display = "flex";
    panel.showPopover?.();
    input.focus({ preventScroll: true });
    list.scrollTop = 0;
    moveTo(last ? rows().at(-1) : rows().find((row) => row.value === props.selected && row.value !== undefined) ?? rows()[0]);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
  };
  const choose = (row?: PickerRow) => {
    if (row?.expand !== undefined) {
      setExpanded(expanded() === row.expand ? undefined : row.expand);
      moveTo(row);
    } else if (row?.value !== undefined) {
      props.onSelect(row.value);
      close(true);
    }
  };

  return <div class="search-picker">
    <label id={`${id}-label`} for={`${id}-trigger`}>{props.label}</label>
    <button id={`${id}-trigger`} ref={trigger} type="button" class="search-picker-trigger"
      aria-label={`${props.label}: ${props.selectionLabel ?? props.placeholder}`} aria-haspopup="listbox" aria-expanded={open()}
      disabled={props.disabled} onClick={() => open() ? close(true) : start()}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        if (!open()) start(event.key === "ArrowUp");
      }}>
      <span class="search-picker-summary"><Show when={props.summary} fallback={<span class="search-picker-muted">{props.placeholder}</span>}>{props.summary}</Show></span>
      <i class="fa-solid fa-chevron-down search-picker-chevron" aria-hidden="true" />
    </button>
    <div ref={panel} class="search-picker-panel" popover="manual" data-open={open()} aria-hidden={open() ? undefined : true} inert={!open()}>
      <div class="search-picker-search">
        <i class="fa-solid fa-magnifying-glass" aria-hidden="true" />
        <input ref={input} type="text" name="search" role="combobox" aria-label={props.searchLabel} aria-expanded={open()} aria-autocomplete="list"
          aria-controls={`${id}-list`} aria-activedescendant={active() ? rowId(active()!) : undefined}
          placeholder={`${props.searchLabel}…`} autocomplete="off" spellcheck={false} value={query()}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setQuery(value);
            props.onQuery?.(value);
            list.scrollTop = 0;
            moveTo(rows()[0]);
          }}
          onKeyDown={(event) => {
            if (event.isComposing) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close(true);
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(rows().find((row) => row.id === active()));
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const items = rows();
              const index = items.findIndex((row) => row.id === active());
              const next = index < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1)
                : Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
              moveTo(items[next]);
            }
          }} />
      </div>
      <div ref={list} class="search-picker-list" id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`}>
        <For each={groups()}>{(group) => <div role={group.label ? "group" : "presentation"} aria-label={group.label}>
          <Show when={group.label}><div class="search-picker-group" aria-hidden="true">{group.label}</div></Show>
          <For each={group.rows}>{(row) => <div id={rowId(row.id)} role="option" class="search-picker-row"
            classList={{ "search-picker-active": active() === row.id, "search-picker-child": expanded() !== undefined && group.id === expanded() && row.value !== undefined && !query().trim() }}
            aria-selected={row.value === undefined ? undefined : row.value === props.selected}
            onMouseDown={(event) => event.preventDefault()} onClick={() => choose(row)}>
            {row.content}
            <Show when={row.value !== undefined && row.value === props.selected}><i class="fa-solid fa-check search-picker-check" aria-hidden="true" /></Show>
          </div>}</For>
        </div>}</For>
      </div>
      <Show when={!rows().length && open()}><div class="search-picker-empty" role="status">No matches. Change the search text.</div></Show>
    </div>
  </div>;
}
