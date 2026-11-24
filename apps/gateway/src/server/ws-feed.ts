import { WebSocket } from "ws";
import type { FeedWindow, WsFeedMessage } from "@yoplai/shared";
import type { DurableHost } from "../durable/host.js";
import { feedDelta } from "../durable/feed-delta.js";

type FeedDataFrame = Exclude<WsFeedMessage, { type: "feed_end" }>;

export class WsFeed {
  private readonly controller = new AbortController();
  private host?: DurableHost;
  private previous?: FeedWindow;
  private pending?: { window: FeedWindow; snapshot: boolean };
  private busy = false;
  private sending = false;
  private seq = 0;

  constructor(
    private readonly ws: WebSocket,
    private readonly agentId: string,
    private readonly principal: string,
    private readonly credentialActive: () => boolean,
    private readonly checkSession: () => Promise<"active" | "invalid" | "forbidden">,
    private readonly closeInvalidCredential: () => void,
    private readonly onStop: () => void,
    private readonly feedSendComplete?: () => Promise<void>,
  ) {}

  async start(open: Promise<DurableHost>, limit: number) {
    try {
      this.host = await open;
      if (!await this.recheck()) return;
      const reason = await this.host.watchFeed(this.principal, this.principal, limit, this.controller.signal, (window, snapshot) => {
        this.pending = { window, snapshot: snapshot || this.sending || this.pending?.snapshot === true };
        this.flush();
      });
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
    const allowed = session === "active" && (!this.host || await this.host.mayReadFeed(this.principal, this.principal));
    if (!this.active()) return false;
    if (!allowed) this.end("forbidden");
    return allowed;
  }

  private active() {
    return !this.controller.signal.aborted && this.ws.readyState === WebSocket.OPEN && this.credentialActive();
  }

  private end(reason: "forbidden" | "unavailable") {
    if (this.active()) {
      this.ws.send(JSON.stringify({ type: "feed_end", agentId: this.agentId, reason } satisfies WsFeedMessage));
    }
    this.stop();
  }

  private flush() {
    if (!this.pending || this.busy || this.controller.signal.aborted) return;
    this.busy = true;
    void this.send().catch(() => this.stop());
  }

  private async send() {
    if (!await this.recheck() || !this.pending) {
      this.stop();
      return;
    }
    const { window, snapshot } = this.pending;
    this.pending = undefined;
    const delta = !snapshot && this.previous && feedDelta(this.previous.items, window.items);
    if (delta && !delta.upsert.length && delta.dropBefore === undefined &&
        this.previous?.hasBefore === window.hasBefore && JSON.stringify(this.previous.live) === JSON.stringify(window.live)) {
      this.busy = false;
      this.flush();
      return;
    }

    const base = { agentId: this.agentId, seq: ++this.seq, hasBefore: window.hasBefore, live: window.live };
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
