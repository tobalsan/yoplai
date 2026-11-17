/** Keep the last N log lines. */
export class LogBuffer {
  private lines: string[] = [];

  constructor(private readonly limit = 50) {}

  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
  }

  tail(): string[] {
    return [...this.lines];
  }
}
