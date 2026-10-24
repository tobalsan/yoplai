/**
 * Mattermost shows "is typing" for about five seconds after each
 * `POST /users/{id}/typing`, so the indicator is refreshed on a shorter cadence
 * for the whole turn. Best effort: a failed refresh is ignored.
 */
export const TYPING_INTERVAL_MS = 4_000;

export class TypingKeepAlive {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly send: () => Promise<void>,
    private readonly intervalMs = TYPING_INTERVAL_MS
  ) {}

  async start(): Promise<void> {
    this.stop();
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    try {
      await this.send();
    } catch {
      // Presentation only.
    }
  }
}
