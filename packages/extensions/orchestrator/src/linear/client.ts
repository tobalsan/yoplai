import type { LinearIssue } from "../types.js";

type LinearClientOptions = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export class LinearClient {
  rateLimitRemaining: number | undefined;
  rateLimitResetAt: number | undefined;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly apiKey: string, endpointOrOptions: string | LinearClientOptions = "https://api.linear.app/graphql") {
    const options = typeof endpointOrOptions === "string" ? { endpoint: endpointOrOptions } : endpointOrOptions;
    this.endpoint = options.endpoint ?? "https://api.linear.app/graphql";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  private mapIssue(node: any): LinearIssue {
    const blockingRelations = node.inverseRelations?.nodes?.filter((relation: any) => relation.type === "blocks") ?? [];
    return {
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      description: node.description,
      url: node.url,
      state: node.state?.name ?? "",
      labels: node.labels?.nodes?.map((label: { name: string }) => label.name) ?? [],
      blocked_by: blockingRelations.map((relation: any) => ({
        id: relation.issue?.id,
        identifier: relation.issue?.identifier,
        state: relation.issue?.state?.name ?? null,
      })),
      projectName: node.project?.name,
      projectSlug: node.project?.slugId,
      parentId: node.parent?.id,
    };
  }

  async graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    await this.waitForBucket();
    return this.graphqlOnce<T>(query, variables, true);
  }

  private async graphqlOnce<T>(query: string, variables: Record<string, unknown> | undefined, retry429: boolean): Promise<T> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    this.updateRateLimit(response.headers);
    if (response.status === 429 && retry429) {
      await this.sleep(this.retryDelayMs());
      return this.graphqlOnce<T>(query, variables, false);
    }
    const json = (await response.json()) as { data?: T; errors?: unknown };
    if (!response.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
    return json.data as T;
  }

  private updateRateLimit(headers: Headers): void {
    const remaining = headers.get("x-ratelimit-requests-remaining") ?? headers.get("x-ratelimit-complexity-remaining") ?? headers.get("x-ratelimit-remaining");
    if (remaining !== null) this.rateLimitRemaining = Number(remaining);
    const reset = headers.get("x-ratelimit-requests-reset") ?? headers.get("x-ratelimit-complexity-reset") ?? headers.get("x-ratelimit-reset");
    if (reset !== null) {
      const value = Number(reset);
      this.rateLimitResetAt = value > 10_000_000_000 ? value : value * 1000;
    }
  }

  private retryDelayMs(): number {
    if (!this.rateLimitResetAt) return 1_000;
    return Math.max(1_000, this.rateLimitResetAt - this.now() + 1_000);
  }

  private async waitForBucket(): Promise<void> {
    if (this.rateLimitRemaining !== undefined && this.rateLimitRemaining <= 0) await this.sleep(this.retryDelayMs());
  }

  async pollIssues(input: { projectSlug: string; activeStates: string[] }): Promise<LinearIssue[]> {
    const data = await this.graphql<{ issues: { nodes: Array<any> } }>(
      `query YoplaiPoll($projectSlug: String!, $states: [String!]) { issues(filter: { project: { slugId: { eq: $projectSlug } }, state: { name: { in: $states } } }) { nodes { id identifier title description url state { name } labels { nodes { name } } inverseRelations { nodes { type issue { id identifier state { name } } } } project { name slugId } parent { id } } } }`,
      { projectSlug: input.projectSlug, states: input.activeStates }
    );
    return data.issues.nodes.map((node) => this.mapIssue(node));
  }

  async fetchTerminalIssues(input: { projectSlug: string; terminalStates: string[] }): Promise<LinearIssue[]> {
    return this.pollIssues({ projectSlug: input.projectSlug, activeStates: input.terminalStates });
  }

  async findProjectByName(name: string): Promise<{ id: string; name: string; slugId: string } | undefined> {
    const data = await this.graphql<{ projects: { nodes: Array<{ id: string; name: string; slugId: string }> } }>(
      `query YoplaiProjectByName($name: String!) { projects(filter: { name: { eq: $name } }, first: 1) { nodes { id name slugId } } }`,
      { name }
    );
    return data.projects.nodes[0];
  }

  async createProject(input: { name: string; teamIds: string[] }): Promise<{ id: string; name: string; slugId: string }> {
    const data = await this.graphql<{ projectCreate: { success: boolean; project: { id: string; name: string; slugId: string } } }>(
      `mutation YoplaiProjectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name slugId } } }`,
      { input }
    );
    if (!data.projectCreate.success) throw new Error(`Linear project creation failed: ${input.name}`);
    return data.projectCreate.project;
  }

  async deleteProject(id: string): Promise<void> {
    const data = await this.graphql<{ projectDelete: { success: boolean } }>(
      `mutation YoplaiProjectDelete($id: String!) { projectDelete(id: $id) { success } }`,
      { id }
    );
    if (!data.projectDelete.success) throw new Error(`Linear project deletion failed: ${id}`);
  }

  async inferProjectTeamIds(): Promise<string[]> {
    const data = await this.graphql<{ teams: { nodes: Array<{ id: string; name: string; key: string; archivedAt?: string | null }> } }>(
      `query YoplaiProjectTeams { teams(first: 100) { nodes { id name key archivedAt } } }`
    );
    const teams = data.teams.nodes.filter((team) => !team.archivedAt);
    const envTeamId = process.env.LINEAR_TEAM_ID?.trim();
    if (envTeamId) {
      if (!teams.some((team) => team.id === envTeamId)) throw new Error(`LINEAR_TEAM_ID does not match an active Linear team: ${envTeamId}`);
      return [envTeamId];
    }
    const envTeamKey = process.env.LINEAR_TEAM_KEY?.trim();
    if (envTeamKey) {
      const team = teams.find((item) => item.key.toLowerCase() === envTeamKey.toLowerCase());
      if (!team) throw new Error(`LINEAR_TEAM_KEY does not match an active Linear team: ${envTeamKey}`);
      return [team.id];
    }
    if (teams.length === 1) return [teams[0]!.id];
    const nonPersonal = teams.filter((team) => team.key.toLowerCase() !== "per" && team.name.toLowerCase() !== "personal");
    if (nonPersonal.length === 1) return [nonPersonal[0]!.id];
    throw new Error("Could not infer a Linear team for project creation. Set LINEAR_TEAM_ID or LINEAR_TEAM_KEY.");
  }

  async getIssue(idOrIdentifier: string): Promise<LinearIssue | undefined> {
    const issueFields = `id identifier title description url state { name } labels { nodes { name } } inverseRelations { nodes { type issue { id identifier state { name } } } } project { name slugId } parent { id }`;
    if (/^[A-Z][A-Z0-9]*-\d+$/.test(idOrIdentifier)) {
      const data = await this.graphql<{ issues: { nodes: Array<any> } }>(
        `query YoplaiIssueByIdentifier($identifier: String!) { issues(filter: { identifier: { eq: $identifier } }, first: 1) { nodes { ${issueFields} } } }`,
        { identifier: idOrIdentifier }
      );
      const [node] = data.issues.nodes;
      return node ? this.mapIssue(node) : undefined;
    }
    const data = await this.graphql<{ issue: any | null }>(`query YoplaiIssueById($id: String!) { issue(id: $id) { ${issueFields} } }`, { id: idOrIdentifier });
    return data.issue ? this.mapIssue(data.issue) : undefined;
  }

  commentCreate(issueId: string, body: string) {
    return this.graphql(`mutation YoplaiComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`, { issueId, body });
  }

  issueUpdate(issueId: string, input: Record<string, unknown>) {
    return this.graphql(`mutation YoplaiIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, { id: issueId, input });
  }

  async issueUpdateStateByName(issueId: string, stateName: string) {
    const data = await this.graphql<{ issue: { team: { states: { nodes: Array<{ id: string; name: string }> } } } }>(
      `query YoplaiIssueStates($id: String!) { issue(id: $id) { team { states { nodes { id name } } } } }`,
      { id: issueId }
    );
    const state = data.issue.team.states.nodes.find((node) => node.name === stateName);
    if (!state) throw new Error(`Linear state not found: ${stateName}`);
    return this.issueUpdate(issueId, { stateId: state.id });
  }
}
