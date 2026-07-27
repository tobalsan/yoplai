export type ClaimState = {
  projectId: string;
  issueId: string;
  runId: string;
  claimedAt: string;
  lastEventAt: string;
};

export class ClaimsRegistry {
  private claims = new Map<string, ClaimState>();
  private lock: Promise<void> = Promise.resolve();

  private key(projectId: string, issueId: string): string {
    return `${projectId}:${issueId}`;
  }

  async tryClaim(
    issueId: string,
    runId: string,
    projectId = "default"
  ): Promise<ClaimState | undefined> {
    let release!: () => void;
    const previous = this.lock;
    this.lock = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      const key = this.key(projectId, issueId);
      if (this.claims.has(key)) return undefined;
      const now = new Date().toISOString();
      const claim = {
        projectId,
        issueId,
        runId,
        claimedAt: now,
        lastEventAt: now,
      };
      this.claims.set(key, claim);
      return claim;
    } finally {
      release();
    }
  }

  release(issueId: string, projectId = "default"): boolean {
    return this.claims.delete(this.key(projectId, issueId));
  }

  get(issueId: string, projectId = "default"): ClaimState | undefined {
    return this.claims.get(this.key(projectId, issueId));
  }

  list(input: { projectId?: string } = {}): ClaimState[] {
    const values = [...this.claims.values()];
    return input.projectId
      ? values.filter((claim) => claim.projectId === input.projectId)
      : values;
  }

  touch(
    issueId: string,
    at = new Date().toISOString(),
    projectId = "default"
  ): void {
    const claim = this.get(issueId, projectId);
    if (claim) claim.lastEventAt = at;
  }
}
