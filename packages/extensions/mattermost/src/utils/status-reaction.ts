import type { MattermostRestClient } from "../client.js";

/** Emoji names (Mattermost uses names, not characters). */
export const STATUS_EMOJI = {
  working: "eyes",
  done: "white_check_mark",
  failed: "x",
} as const;

/**
 * 👀 on an accepted post while the agent works, swapped for ✅ or ❌ when the
 * turn ends. Reactions are presentation only: every failure is swallowed.
 */
export class StatusReaction {
  private working = false;
  private settled = false;
  private cleared = false;

  constructor(
    private readonly rest: Pick<
      MattermostRestClient,
      "addReaction" | "removeReaction"
    >,
    private readonly botUserId: string,
    private readonly postId: string
  ) {}

  async start(): Promise<void> {
    this.working = true;
    try {
      await this.rest.addReaction(
        this.botUserId,
        this.postId,
        STATUS_EMOJI.working
      );
    } catch {
      // Presentation only.
    } finally {
      if (this.cleared) {
        this.working = true;
        await this.clear();
      }
    }
  }

  /** Drop 👀 without a verdict (the turn was queued behind another one). */
  async clear(): Promise<void> {
    this.cleared = true;
    if (!this.working) return;
    this.working = false;
    try {
      await this.rest.removeReaction(
        this.botUserId,
        this.postId,
        STATUS_EMOJI.working
      );
    } catch {
      // Presentation only.
    }
  }

  async finish(outcome: "done" | "failed"): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    await this.clear();
    try {
      await this.rest.addReaction(
        this.botUserId,
        this.postId,
        STATUS_EMOJI[outcome]
      );
    } catch {
      // Presentation only.
    }
  }
}
