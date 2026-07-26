// Surface the agent's tool calls/actions as concise one-line notes during a
// turn, for opt-in auditability (ALG-288). This is OFF by default; the handler
// only drives it when the operator has enabled tool-call visibility for the
// chat (mirroring Hermes's Telegram default of a clean chat).
//
// The agent can fire tool calls rapidly, so naively posting a message per event
// would flood the chat. This module coalesces notes into a small number of
// flushes: it buffers one-line notes and only releases a batch at a throttled
// cadence (or once a soft batch ceiling is reached), so the chat sees a steady
// trickle of "what the agent is doing" rather than a storm.
//
// Transport-agnostic: it decides *what* note text to show and *when* a batch is
// due. The handler owns actually sending the batched message.

import type { StreamEvent } from "@yoplai/shared";

// Minimum wall-clock gap between two surfaced note batches. Keeps the chat from
// being flooded while still feeling live. A long burst of tool calls coalesces
// into one batched message per interval.
const DEFAULT_MIN_FLUSH_INTERVAL_MS = 1500;

// Flush immediately once this many un-surfaced notes have piled up, even before
// the interval elapses, so a rapid burst still surfaces promptly instead of
// growing unbounded.
const DEFAULT_MAX_PENDING_NOTES = 8;

// Hard cap on a single note's length so an action note never itself floods a
// line. The argument summary is truncated to fit.
const MAX_NOTE_LENGTH = 120;

export type ToolNotesOptions = {
  /** Minimum wall-clock gap between two surfaced note batches. */
  minFlushIntervalMs?: number;
  /** Flush immediately once this many notes are pending. */
  maxPendingNotes?: number;
  /** Clock source, injectable for tests. Defaults to Date.now. */
  now?: () => number;
};

/** Collapse whitespace and clamp a string to `max` characters with an ellipsis. */
function clamp(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + "…";
}

/**
 * Summarize a tool call's arguments into a short inline hint. Strings are shown
 * directly; objects show their first scalar field (e.g. a path/query) so the
 * note conveys *what* the call is about without dumping the full payload.
 */
function summarizeArguments(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args === "string") return args ? clamp(args, 60) : undefined;
  if (typeof args === "number" || typeof args === "boolean") {
    return String(args);
  }
  if (typeof args === "object") {
    for (const value of Object.values(args as Record<string, unknown>)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        const text = String(value).trim();
        if (text) return clamp(text, 60);
      }
    }
  }
  return undefined;
}

/**
 * Build a single one-line note for a stream event, or `null` when the event is
 * not a tool call/result worth surfacing. Notes are intentionally terse:
 *
 *   🔧 search_files (src/index.ts)
 *   ✓ search_files
 *   ⚠ search_files failed
 *
 * Only `tool_call`/`tool_result` are surfaced; the coarser `tool_start`/
 * `tool_end` lifecycle events are intentionally skipped so each tool action is
 * noted exactly once (the call and its result), never doubled.
 */
export function formatToolNote(event: StreamEvent): string | null {
  if (event.type === "tool_call") {
    const hint = summarizeArguments(event.arguments);
    const note = hint ? `🔧 ${event.name} (${hint})` : `🔧 ${event.name}`;
    return clamp(note, MAX_NOTE_LENGTH);
  }
  if (event.type === "tool_result") {
    const note = event.isError ? `⚠ ${event.name} failed` : `✓ ${event.name}`;
    return clamp(note, MAX_NOTE_LENGTH);
  }
  return null;
}

export type ToolNotesFlush = { text: string; count: number };

/**
 * Coalesces one-line tool-call notes into throttled batches.
 *
 * Usage: call {@link push} for each stream event (non-tool events are ignored),
 * then {@link takeFlush} to get a batched note message when one is due (or
 * `null` when it isn't). At turn end, call {@link takeFinal} to drain whatever
 * remains regardless of timing.
 */
export class ToolNotes {
  private readonly minFlushIntervalMs: number;
  private readonly maxPendingNotes: number;
  private readonly now: () => number;

  /** Notes accumulated but not yet surfaced. */
  private pending: string[] = [];
  /** Timestamp of the last surfaced batch, or null before the first. */
  private lastFlushAt: number | null = null;

  constructor(options: ToolNotesOptions = {}) {
    this.minFlushIntervalMs =
      options.minFlushIntervalMs ?? DEFAULT_MIN_FLUSH_INTERVAL_MS;
    this.maxPendingNotes = options.maxPendingNotes ?? DEFAULT_MAX_PENDING_NOTES;
    this.now = options.now ?? Date.now;
  }

  /** Number of notes buffered but not yet surfaced. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Record a stream event. Tool-call/result events become a one-line note;
   * every other event type is ignored.
   */
  push(event: StreamEvent): void {
    const note = formatToolNote(event);
    if (note) this.pending.push(note);
  }

  /**
   * Return a batched note message if a flush is due, else `null`.
   *
   * A flush is due when there are pending notes AND either the batch ceiling has
   * been reached or the minimum interval has elapsed since the last flush.
   */
  takeFlush(): ToolNotesFlush | null {
    if (this.pending.length === 0) return null;
    const overflow = this.pending.length >= this.maxPendingNotes;
    if (!overflow && !this.intervalElapsed()) return null;
    return this.surface();
  }

  /**
   * Drain any remaining notes regardless of interval. Returns `null` when
   * nothing is pending.
   */
  takeFinal(): ToolNotesFlush | null {
    if (this.pending.length === 0) return null;
    return this.surface();
  }

  private intervalElapsed(): boolean {
    if (this.lastFlushAt === null) return true;
    return this.now() - this.lastFlushAt >= this.minFlushIntervalMs;
  }

  private surface(): ToolNotesFlush {
    const count = this.pending.length;
    const text = this.pending.join("\n");
    this.pending = [];
    this.lastFlushAt = this.now();
    return { text, count };
  }
}

export {
  DEFAULT_MIN_FLUSH_INTERVAL_MS,
  DEFAULT_MAX_PENDING_NOTES,
  MAX_NOTE_LENGTH,
};
