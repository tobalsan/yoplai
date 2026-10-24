/**
 * Remembers the last `capacity` post IDs so a post seen twice (replayed after a
 * WebSocket resume, or fetched again while catching up) runs the agent once.
 */
export class RecentIds {
  private readonly ids = new Set<string>();

  constructor(private readonly capacity = 5_000) {}

  /** True the first time an id is seen, false afterwards. */
  claim(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return true;
  }
}
