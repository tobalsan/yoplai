import { createContext, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";

/**
 * Chat-level dashboard annotation state. Framed dashboard pages (opaque-origin
 * sandboxes) announce themselves and post notes by postMessage; this module
 * trusts only messages from the registered frame's own window, keeps one frame
 * in annotation mode at a time, stamps each note with the page it came from and
 * builds the single chat message that carries every note to the page's agent.
 */
const CHANNEL = "yoplai-annotate";
/** Product limits that keep one annotation message readable. */
const MAX_NOTES = 20;
const MAX_NOTE = 500;

type PageContext = { id: string; slug: string; agentId: string; title: string; params: Record<string, string> };

type Frame = {
  window: () => Window | null | undefined;
  page: Accessor<PageContext | undefined>;
};

/** A staged note, stamped with the page the frame showed when it arrived. */
export type DashboardNote = {
  id: string;
  page: PageContext;
  selector: string;
  tag: string;
  text: string;
  heading: string;
  ancestor: string;
  note: string;
};

type StagedNote = DashboardNote & { frame: Frame };

export type DashboardFrameAnnotation = {
  /** The frame announced a page of this chat's agent. */
  available: Accessor<boolean>;
  active: Accessor<boolean>;
  toggle(): void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : undefined;

function readPage(data: Record<string, unknown>): PageContext | undefined {
  const id = text(data.id, 200);
  const slug = text(data.slug, 200);
  const agentId = text(data.agentId, 200);
  if (!id || !slug || !agentId || !isRecord(data.params)) return undefined;
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(data.params).slice(0, 20)) {
    if (typeof value === "string") params[key.slice(0, 100)] = value.slice(0, 200);
  }
  return { id, slug, agentId, title: text(data.title, 120) || slug, params };
}

const squash = (value: string) => value.replace(/\s+/g, " ").trim();
const groupKey = (page: PageContext) =>
  `${page.id}\n${JSON.stringify(Object.entries(page.params).sort(([a], [b]) => a.localeCompare(b)))}`;

function readNote(data: Record<string, unknown>, page: PageContext, frame: Frame): StagedNote | undefined {
  const id = text(data.id, 100);
  const note = squash(text(data.note, MAX_NOTE) ?? "");
  const selector = text(data.selector, 200);
  if (!id || !note || !selector) return undefined;
  return {
    id, page, frame, note, selector,
    tag: text(data.tag, 40) ?? "",
    text: squash(text(data.text, 120) ?? ""),
    heading: squash(text(data.heading, 120) ?? ""),
    ancestor: text(data.ancestor, 200) ?? "",
  };
}

function noteLine(n: number, note: DashboardNote): string {
  const context = [
    note.heading && `under "${note.heading}"`,
    note.ancestor && !note.selector.includes(note.ancestor) && `in <${note.ancestor}>`,
  ].filter(Boolean);
  return `${n}. <${note.selector}>${note.text ? ` "${note.text}"` : ""}${context.length ? ` (${context.join("; ")})` : ""} - ${note.note}`;
}

function groupHeader(page: PageContext): string {
  const params = Object.keys(page.params).length ? `, params: ${JSON.stringify(page.params)}` : "";
  return [
    `Dashboard annotations for "${page.title}" (page: ${page.slug}, id: ${page.id}${params}).`,
    "Edit this dashboard as the notes below ask, then publish with dashboard_update.",
  ].join("\n");
}

export function createDashboardAnnotations(agentId: Accessor<string>) {
  const [active, setActive] = createSignal<Frame | null>(null);
  const [staged, setStaged] = createSignal<StagedNote[]>([]);
  const frames = new Set<Frame>();
  // Grouped by page and parameters in first-seen order, so chip numbers match the message.
  const notes = createMemo<StagedNote[]>(() => {
    const groups = new Map<string, StagedNote[]>();
    for (const note of staged()) {
      const key = groupKey(note.page);
      groups.set(key, [...(groups.get(key) ?? []), note]);
    }
    return [...groups.values()].flat();
  });

  const post = (frame: Frame, type: string, body: Record<string, unknown> = {}) =>
    frame.window()?.postMessage({ channel: CHANNEL, type, ...body }, "*");

  const activate = (next: Frame | null) => {
    const previous = active();
    if (previous === next) return;
    if (previous) post(previous, "set", { on: false });
    setActive(next);
    if (next) post(next, "set", { on: true });
  };

  /** Connect one rendered dashboard iframe; call inside its component. */
  const frame = (element: () => HTMLIFrameElement | undefined): DashboardFrameAnnotation => {
    const [page, setPage] = createSignal<PageContext>();
    const entry: Frame = { window: () => element()?.contentWindow, page };
    const available = () => page()?.agentId === agentId();
    const listener = (event: MessageEvent) => {
      const source = entry.window();
      const data: unknown = event.data;
      if (!source || event.source !== source || !isRecord(data) || data.channel !== CHANNEL) return;
      if (data.type === "ready") {
        setPage(readPage(data));
        if (active() !== entry) return;
        // A reloaded or navigated page starts dormant: re-send the mode.
        if (available()) post(entry, "set", { on: true });
        else activate(null);
      } else if (data.type === "exit" && active() === entry) {
        activate(null);
      } else if (data.type === "note" && active() === entry && available()) {
        const note = readNote(data, page()!, entry);
        if (!note || staged().some((existing) => existing.id === note.id)) return;
        // Over the limit, drop the marker the page already drew.
        if (staged().length >= MAX_NOTES) post(entry, "remove", { id: note.id });
        else setStaged((current) => [...current, note]);
      }
    };
    frames.add(entry);
    window.addEventListener("message", listener);
    onCleanup(() => {
      frames.delete(entry);
      window.removeEventListener("message", listener);
      if (active() === entry) setActive(null);
    });
    return {
      available,
      active: () => active() === entry,
      toggle: () => activate(active() === entry || !available() ? null : entry),
    };
  };

  const remove = (id: string) => {
    const note = staged().find((candidate) => candidate.id === id);
    if (!note) return;
    setStaged((current) => current.filter((candidate) => candidate !== note));
    if (frames.has(note.frame)) post(note.frame, "remove", { id });
  };

  /**
   * The chat message for the notes staged now, followed by the user's own text.
   * Call `sent()` once it is sent: it drops exactly those notes and their
   * markers, keeping any added while the send was in flight.
   */
  const compose = (userText: string): { text: string; sent(): void } => {
    const included = notes();
    const blocks: string[] = [];
    let page: PageContext | undefined;
    let lines: string[] = [];
    included.forEach((note, index) => {
      if (!page || groupKey(page) !== groupKey(note.page)) {
        if (page) blocks.push(`${groupHeader(page)}\n\n${lines.join("\n")}`);
        page = note.page;
        lines = [];
      }
      lines.push(noteLine(index + 1, note));
    });
    if (page) blocks.push(`${groupHeader(page)}\n\n${lines.join("\n")}`);
    if (userText) blocks.push(userText);
    return {
      text: blocks.join("\n\n"),
      sent: () => included.forEach((note) => remove(note.id)),
    };
  };

  return {
    frame,
    notes: notes as Accessor<DashboardNote[]>,
    remove,
    compose,
    /** Leave annotation mode and drop staged notes, e.g. on chat switch. */
    reset: () => {
      activate(null);
      setStaged([]);
      for (const entry of frames) post(entry, "clear");
    },
  };
}

export type DashboardAnnotations = ReturnType<typeof createDashboardAnnotations>;

export const DashboardAnnotationsContext = createContext<DashboardAnnotations>();
