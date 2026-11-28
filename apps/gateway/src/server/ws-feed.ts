import { WebSocket } from "ws";
import type { FeedWindow, WsFeedMessage } from "@yoplai/shared";
import { feedDelta } from "../durable/feed-delta.js";

type FeedScope = { agentId: string } | { roomId: string };
type FeedDataFrame = Exclude<WsFeedMessage<FeedScope>, { type: "feed_end" }>;
type FeedEndReason = "forbidden" | "unavailable";

export type FeedWatch = {
  mayRead: () => boolean | Promise<boolean>;
  watch: (
    signal: AbortSignal, publish: (window: FeedWindow, snapshot: boolean) => void, forbid: () => void,
  ) => Promise<FeedEndReason>;
};

export class WsFeed {
  private readonly controller = new AbortController();
  private source?: FeedWatch;
  private previous?: FeedWindow;
  private pending?: { window: FeedWindow; snapshot: boolean };
  private busy = false;
  private sending = false;
  private seq = 0;

  constructor(
    private readonly ws: WebSocket,
    private readonly scope: FeedScope,
    private readonly credentialActive: () => boolean,
    private readonly checkSession: () => Promise<"active" | "invalid" | "forbidden">,
    private readonly closeInvalidCredential: () => void,
    private readonly onStop: () => void,
    private readonly feedSendComplete?: () => Promise<void>,
  ) {}

  async start(open: () => Promise<FeedWatch | undefined>, missingMessage: string) {
    try {
      this.source = await open();
      if (!this.active()) return;
      if (!this.source) {
        this.ws.send(JSON.stringify({ type: "error", message: missingMessage }));
        this.stop();
        return;
      }
      if (!await this.recheck()) return;
      const reason = await this.source.watch(this.controller.signal, (window, snapshot) => {
        this.pending = { window, snapshot: snapshot || this.sending || this.pending?.snapshot === true };
        this.flush();
      }, () => this.end("forbidden"));
      if (reason === "forbidden" || await this.recheck()) this.end(reason);
    } catch {
      if (await this.recheck()) this.end("unavailable");
    }
  }

  stop() {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    this.pending = undefined;
    this.onStop();
  }

  async recheck(): Promise<boolean> {
    if (!this.active()) return false;
    const session = await this.checkSession().catch(() => "invalid" as const);
    if (!this.active()) return false;
    if (session === "invalid") {
      this.closeInvalidCredential();
      return false;
    }
    const allowed = session === "active" && (!this.source || await this.source.mayRead());
    if (!this.active()) return false;
    if (!allowed) this.end("forbidden");
    return allowed;
  }

  private active() {
    return !this.controller.signal.aborted && this.ws.readyState === WebSocket.OPEN && this.credentialActive();
  }

  private end(reason: FeedEndReason) {
    const active = this.active();
    this.stop();
    if (active) {
      this.ws.send(JSON.stringify({ type: "feed_end", ...this.scope, reason } satisfies WsFeedMessage<FeedScope>));
    }
  }

  private flush() {
    if (!this.pending || this.busy || this.controller.signal.aborted) return;
    this.busy = true;
    void this.send().catch(() => this.stop());
  }

  private async send() {
    if (!await this.recheck() || !this.active() || !this.pending) {
      this.stop();
      return;
    }
    const { window, snapshot } = this.pending;
    this.pending = undefined;
    const delta = !snapshot && this.previous && feedDelta(this.previous.items, window.items);
    if (delta && !delta.upsert.length && delta.dropBefore === undefined &&
        this.previous?.hasBefore === window.hasBefore && JSON.stringify(this.previous.live) === JSON.stringify(window.live) &&
        JSON.stringify(this.previous.roomRuns) === JSON.stringify(window.roomRuns)) {
      this.busy = false;
      this.flush();
      return;
    }

    const base = { ...this.scope, seq: ++this.seq, hasBefore: window.hasBefore, live: window.live, roomRuns: window.roomRuns };
    const frame: FeedDataFrame = delta ? { ...base, type: "feed_delta", ...delta }
      : { ...base, type: "feed_snapshot", items: window.items };
    this.previous = window;
    this.sending = true;
    const complete = () => {
      this.sending = false;
      this.busy = false;
      this.flush();
    };
    this.ws.send(JSON.stringify(frame), (error) => {
      if (error) this.stop();
      else if (this.feedSendComplete) void this.feedSendComplete().then(complete, () => this.stop());
      else complete();
    });
  }
}
