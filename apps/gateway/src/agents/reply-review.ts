import { isNoReply, type ExtensionReplyReviewVerdict, type StreamEvent } from "@yoplai/shared";
import type { HistoryEvent } from "../sdk/types.js";
import type { LoadedReplyReviewer } from "../extensions/runtime.js";
import { logWarn } from "../logging.js";

const heldSessions = new Set<string>();
const key = (agentId: string, sessionId: string) => `${agentId}\0${sessionId}`;

export function hasHeldReply(agentId: string, sessionId: string): boolean {
  return heldSessions.has(key(agentId, sessionId));
}

/** Holds delivery and history for the runner's per-turn reply reviewers. */
export class HeldReply {
  readonly nudge: string | undefined;
  private segments = [""];
  private held: HistoryEvent[] = [];
  private rewriting = false;
  private verdicts: ExtensionReplyReviewVerdict[] = [];
  private begun: LoadedReplyReviewer[] = [];

  constructor(
    private readonly agentId: string,
    private readonly sessionId: string,
    private readonly reviewers: LoadedReplyReviewer[]
  ) {
    this.nudge = reviewers.map(({ reviewer }) => reviewer.nudge).filter(Boolean).join("\n\n") || undefined;
  }

  begin(): void {
    heldSessions.add(key(this.agentId, this.sessionId));
    for (const entry of this.reviewers) {
      this.begun.push(entry);
      entry.reviewer.begin();
    }
  }

  holdEvent(event: StreamEvent): boolean {
    if (event.type === "text") {
      this.segments[this.segments.length - 1] += event.data;
      return true;
    }
    if (event.type.startsWith("tool_") && this.segments[this.segments.length - 1]) this.segments.push("");
    return false;
  }

  holdHistory(event: HistoryEvent): void {
    if (this.rewriting && ["user", "system_prompt", "system_context"].includes(event.type)) return;
    this.held.push(event);
  }

  startRewrite(): void {
    this.rewriting = true;
    this.segments = [""];
    this.held = this.held.filter((event) => event.type !== "assistant_text");
  }

  release(): HistoryEvent[] {
    const events = this.held;
    this.held = [];
    return events;
  }

  private draft(): string {
    return this.segments.filter((segment) => segment && !isNoReply(segment)).join("\n\n");
  }

  async review(): Promise<ExtensionReplyReviewVerdict> {
    const draft = this.draft();
    this.verdicts = await Promise.all(this.reviewers.map(({ reviewer }) => reviewer.review(draft)));
    const hints = this.verdicts.flatMap((verdict, i) => verdict.ok ? [] : [`[${this.reviewers[i].extensionId}] ${verdict.rewriteHint}`]);
    return hints.length ? { ok: false, rewriteHint: hints.join("\n\n") } : { ok: true };
  }

  async done(rewritten: boolean): Promise<void> {
    for (const [i, { reviewer }] of this.reviewers.entries()) {
      await reviewer.done?.(this.verdicts[i], { rewritten });
    }
  }

  flushText(emit: (event: StreamEvent) => void): void {
    const text = this.draft();
    this.segments = [""];
    if (text) emit({ type: "text", data: text });
  }

  end(): void {
    for (const { extensionId, reviewer } of this.begun) {
      try {
        reviewer.end();
      } catch (error) {
        logWarn("[extensions] reply reviewer cleanup failed", { extensionId, agentId: this.agentId, error: String(error) });
      }
    }
    this.begun = [];
    heldSessions.delete(key(this.agentId, this.sessionId));
  }
}
