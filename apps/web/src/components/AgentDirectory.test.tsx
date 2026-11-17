// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import type {
  Agent,
  ProjectListItem,
  SubagentGlobalListItem,
} from "../api/types";
import { AgentDirectory } from "./AgentDirectory";

const {
  fetchAgentsMock,
  fetchAllSubagentsMock,
  fetchProjectsMock,
  fetchAgentStatusesMock,
  subscribeToFileChangesMock,
  subscribeToStatusMock,
} = vi.hoisted(() => ({
  fetchAgentsMock: vi.fn<() => Promise<Agent[]>>(async () => []),
  fetchAllSubagentsMock: vi.fn<
    () => Promise<{ items: SubagentGlobalListItem[] }>
  >(async () => ({ items: [] })),
  fetchProjectsMock: vi.fn<() => Promise<ProjectListItem[]>>(async () => []),
  fetchAgentStatusesMock: vi.fn<
    () => Promise<{ statuses: Record<string, "streaming" | "idle"> }>
  >(async () => ({ statuses: {} })),
  subscribeToFileChangesMock: vi.fn(() => () => {}),
  subscribeToStatusMock: vi.fn(() => () => {}),
}));

vi.mock("../api", () => ({
  fetchAgents: fetchAgentsMock,
  fetchAllSubagents: fetchAllSubagentsMock,
  fetchProjects: fetchProjectsMock,
  fetchAgentStatuses: fetchAgentStatusesMock,
  subscribeToFileChanges: subscribeToFileChangesMock,
  subscribeToStatus: subscribeToStatusMock,
}));

vi.mock("@solidjs/router", () => ({
  A: (props: Record<string, unknown>) => <a {...props} />,
}));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AgentDirectory", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    fetchAgentsMock.mockReset();
    fetchAllSubagentsMock.mockReset();
    fetchProjectsMock.mockReset();
    fetchAgentStatusesMock.mockReset();
    subscribeToFileChangesMock.mockReset();
    subscribeToStatusMock.mockReset();
    fetchAgentsMock.mockResolvedValue([]);
    fetchAllSubagentsMock.mockResolvedValue({ items: [] });
    fetchProjectsMock.mockResolvedValue([]);
    fetchAgentStatusesMock.mockResolvedValue({ statuses: {} });
    subscribeToFileChangesMock.mockReturnValue(() => {});
    subscribeToStatusMock.mockReturnValue(() => {});
    vi.clearAllMocks();
  });

  it("keeps lead agents and status pills", async () => {
    fetchAgentsMock.mockResolvedValue([
      {
        id: "lead-1",
        name: "Lead One",
        model: { provider: "anthropic", model: "claude" },
      },
    ] as Agent[]);
    fetchAgentStatusesMock.mockResolvedValue({
      statuses: { "lead-1": "streaming" },
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const [selected] = createSignal<string | null>("lead-1");

    const dispose = render(
      () => (
        <AgentDirectory
          selectedAgent={selected}
          onSelectAgent={() => {}}
          onOpenProject={() => {}}
        />
      ),
      container
    );

    await tick();
    await tick();

    expect(container.textContent).toContain("LEAD AGENTS");
    expect(container.textContent).toContain("Lead One");
    expect(container.textContent).toContain("WORKING");

    dispose();
  });

  it("marks a remote agent with the name of its gateway", async () => {
    fetchAgentsMock.mockResolvedValue([
      { id: "pom", name: "Pom" },
      { id: "iris@ams", name: "Iris", gateway: "ams" },
    ] as Agent[]);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const [selected] = createSignal<string | null>(null);
    const dispose = render(
      () => (
        <AgentDirectory
          selectedAgent={selected}
          onSelectAgent={() => {}}
          onOpenProject={() => {}}
        />
      ),
      container
    );
    await tick();
    await tick();

    expect(container.textContent).toContain("Pom");
    expect(container.textContent).toContain("Iris");
    expect(container.textContent).toContain("@ams");
    expect(container.textContent?.match(/@/g)).toHaveLength(1);

    dispose();
  });

  it("shows all projects with running agents, ordered by latest activity", async () => {
    fetchAllSubagentsMock.mockResolvedValue({
      items: [
        {
          projectId: "PRO-1",
          slug: "alpha",
          cli: "codex",
          status: "running",
          lastActive: "2026-03-09T09:00:00.000Z",
        },
        {
          projectId: "PRO-2",
          slug: "beta",
          cli: "claude",
          status: "running",
          lastActive: "2026-03-09T10:00:00.000Z",
        },
        {
          projectId: "PRO-3",
          slug: "gamma",
          cli: "codex",
          status: "running",
          lastActive: "2026-03-09T11:00:00.000Z",
        },
        {
          projectId: "PRO-4",
          slug: "delta",
          cli: "codex",
          status: "running",
          lastActive: "2026-03-09T12:00:00.000Z",
        },
        {
          projectId: "PRO-5",
          slug: "eps",
          cli: "codex",
          status: "running",
          lastActive: "2026-03-09T13:00:00.000Z",
        },
        {
          projectId: "PRO-6",
          slug: "zeta",
          cli: "codex",
          status: "running",
          lastActive: "2026-03-09T14:00:00.000Z",
        },
      ],
    });
    fetchProjectsMock.mockResolvedValue([
      {
        id: "PRO-1",
        title: "First active project",
        path: "",
        absolutePath: "",
        repoValid: true,
        frontmatter: { status: "in_progress" },
      },
      {
        id: "PRO-2",
        title: "Second active project",
        path: "",
        absolutePath: "",
        repoValid: true,
        frontmatter: { status: "todo" },
      },
      {
        id: "PRO-3",
        title: "Done but running",
        path: "",
        absolutePath: "",
        repoValid: true,
        frontmatter: { status: "done" },
      },
      {
        id: "PRO-4",
        title: "Fourth active project",
        path: "",
        absolutePath: "",
        repoValid: true,
        frontmatter: { status: "shaping" },
      },
      {
        id: "PRO-5",
        title: "Fifth active project",
        path: "",
        absolutePath: "",
        repoValid: true,
        frontmatter: { status: "todo" },
      },
      {
        id: "PRO-6",
        title: "Sixth active project",
        path: "",
        absolutePath: "",
        repoValid: true,
        frontmatter: { status: "maybe" },
      },
    ] as ProjectListItem[]);
    const onOpenProject = vi.fn<(id: string) => void>();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const [selected] = createSignal<string | null>(null);

    const dispose = render(
      () => (
        <AgentDirectory
          selectedAgent={selected}
          onSelectAgent={() => {}}
          onOpenProject={onOpenProject}
        />
      ),
      container
    );

    await tick();
    await tick();

    expect(container.textContent).toContain("ACTIVE PROJECTS");
    expect(container.textContent).not.toContain("View all");
    expect(container.textContent).toContain("PRO-6: Sixth active project");
    expect(container.textContent).toContain("PRO-5: Fifth active project");
    expect(container.textContent).toContain("PRO-4: Fourth active project");
    expect(container.textContent).toContain("PRO-3: Done but running");
    expect(container.textContent).toContain("PRO-2: Second active project");
    expect(container.textContent).toContain("PRO-1: First active project");

    const projectRows = Array.from(
      container.querySelectorAll(".project-item .agent-label")
    ).map((node) => node.textContent?.trim());
    expect(projectRows).toEqual([
      "PRO-6: Sixth active project",
      "PRO-5: Fifth active project",
      "PRO-4: Fourth active project",
      "PRO-3: Done but running",
      "PRO-2: Second active project",
      "PRO-1: First active project",
    ]);

    const firstProjectRow = container.querySelector(
      ".project-item"
    ) as HTMLButtonElement;
    firstProjectRow.click();
    expect(onOpenProject).toHaveBeenCalledWith("PRO-6");

    dispose();
  });
});
