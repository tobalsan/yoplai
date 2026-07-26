// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import type { ProjectDetail, SubagentListItem } from "../../api/types";
import { AgentPanel } from "./AgentPanel";
import {
  fetchSimpleHistory,
  renameSubagent,
  fetchSubagentLogs,
  fetchSubagents,
} from "../../api";

vi.mock("../../api", () => ({
  fetchSubagents: vi.fn(async () => ({ ok: true, data: { items: [] } })),
  fetchSubagentLogs: vi.fn(async () => ({
    ok: true,
    data: { cursor: 0, events: [] },
  })),
  fetchSimpleHistory: vi.fn(async () => ({ messages: [] })),
  fetchSpawnOptions: vi.fn(async () => ({
    agents: [
      { id: "agent-claude", name: "Claude Lead" },
      { id: "agent-codex", name: "Codex Lead" },
    ],
    subagentTemplates: [],
  })),
  subscribeToFileChanges: vi.fn(() => () => {}),
  archiveSubagent: vi.fn(async () => ({
    ok: true,
    data: { slug: "codex-abc", archived: true },
  })),
  killSubagent: vi.fn(async () => ({ ok: true, data: { slug: "codex-abc" } })),
  renameSubagent: vi.fn(async () => ({
    ok: true,
    data: {
      slug: "alpha",
      cli: "codex",
      name: "Worker Renamed",
      status: "idle",
    },
  })),
  fetchAgentStatuses: vi.fn(async () => ({ statuses: {} })),
  subscribeToStatus: vi.fn(() => () => {}),
}));

const project: ProjectDetail = {
  id: "PRO-1",
  title: "Alpha Project",
  path: "PRO-1_alpha-project",
  absolutePath: "/tmp/PRO-1_alpha-project",
  repoValid: true,
  frontmatter: {
    status: "todo",
    created: "2026-02-28T20:00:00.000Z",
    sessionKeys: { "lead-agent": "main" },
    repo: "~/code/yoplai",
  },
  docs: {},
  thread: [],
};

describe("AgentPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchSimpleHistory).mockResolvedValue({ messages: [] });
    vi.mocked(fetchSubagentLogs).mockResolvedValue({
      ok: true,
      data: { cursor: 0, events: [] },
    });
  });

  const setup = (options?: {
    onSelectAgent?: (input: unknown) => void;
    onOpenSpawn?: (input: unknown) => void;
  }) => {
    const [subagents, setSubagents] = createSignal<SubagentListItem[]>([]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <AgentPanel
          project={project}
          area={undefined}
          areas={[]}
          subagents={subagents()}
          onSubagentsChange={(items) => setSubagents(items)}
          onOpenSpawn={(input) => options?.onOpenSpawn?.(input)}
          onTitleChange={() => {}}
          onStatusChange={() => {}}
          onAreaChange={() => {}}
          onRepoChange={() => {}}
          selectedAgentSlug={null}
          onSelectAgent={(info) => options?.onSelectAgent?.(info)}
        />
      ),
      container
    );
    return { container, dispose };
  };

  it("renders agent rows and selects subagent on click", async () => {
    vi.mocked(fetchSubagents).mockResolvedValueOnce({
      ok: true,
      data: {
        items: [
          {
            slug: "alpha",
            cli: "codex",
            model: "gpt-5.3-codex",
            status: "running",
          },
        ],
      },
    });
    const onSelectAgent = vi.fn();
    const { container, dispose } = setup({ onSelectAgent });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.textContent).toContain("lead-agent");
    const row = Array.from(container.querySelectorAll(".agent-list-item")).find(
      (item) => item.textContent?.includes("codex")
    ) as HTMLButtonElement | undefined;
    expect(row).toBeDefined();
    expect(row?.textContent).toContain("codex · gpt-5.3-codex");

    row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelectAgent).toHaveBeenCalledWith({
      type: "subagent",
      slug: "alpha",
      cli: "codex",
      status: "running",
      projectId: "PRO-1",
    });

    dispose();
  });

  it("opens template menu and emits lead agent prefill", async () => {
    vi.mocked(fetchSubagents).mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            slug: "alpha",
            cli: "codex",
            status: "running",
            name: "Worker Alpha",
          },
        ],
      },
    });
    const onOpenSpawn = vi.fn();

    const { container, dispose } = setup({ onOpenSpawn });

    const openButton = container.querySelector(
      ".add-agent-btn"
    ) as HTMLButtonElement;
    openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // Wait for fetchSpawnOptions to resolve
    await new Promise((resolve) => setTimeout(resolve, 0));

    const leadOption = Array.from(
      container.querySelectorAll(".template-option")
    ).find((item) =>
      item.textContent?.includes("Claude Lead")
    ) as HTMLButtonElement;
    expect(leadOption).toBeTruthy();
    leadOption.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onOpenSpawn).toHaveBeenCalledTimes(1);
    const payload = onOpenSpawn.mock.calls[0]?.[0];
    expect(payload.template).toBe("lead");
    expect(payload.prefill).toMatchObject({
      agentId: "agent-claude",
      agentName: "Claude Lead",
      cli: "claude",
      model: "opus",
      reasoning: "medium",
      runMode: "none",
      includeDefaultPrompt: true,
      includeRoleInstructions: true,
      includePostRun: false,
    });

    expect(container.querySelector(".template-menu")).toBeNull();

    dispose();
  });

  it("shows dynamic agent options and custom", async () => {
    vi.mocked(fetchSubagents).mockResolvedValue({
      ok: true,
      data: { items: [] },
    });

    const { container, dispose } = setup();
    const openButton = container.querySelector(
      ".add-agent-btn"
    ) as HTMLButtonElement;
    openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = container.textContent ?? "";
    expect(text).toContain("Claude Lead");
    expect(text).toContain("Codex Lead");
    expect(text).toContain("Custom");

    dispose();
  });

  it("disables create new agent when repo is invalid", async () => {
    const invalidProject: ProjectDetail = {
      ...project,
      repoValid: false,
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <AgentPanel
          project={invalidProject}
          area={undefined}
          areas={[]}
          subagents={[]}
          onSubagentsChange={() => {}}
          onOpenSpawn={() => {}}
          onTitleChange={() => {}}
          onStatusChange={() => {}}
          onAreaChange={() => {}}
          onRepoChange={() => {}}
          selectedAgentSlug={null}
          onSelectAgent={() => {}}
        />
      ),
      container
    );

    const openButton = container.querySelector(
      ".add-agent-btn"
    ) as HTMLButtonElement;
    expect(openButton.disabled).toBe(true);
    expect(openButton.title).toBe("Repo path not found: ~/code/yoplai");
    expect(container.textContent).toContain(
      "Repo path not found: ~/code/yoplai"
    );

    dispose();
  });

  it("toggles repo block and allows repo editing", async () => {
    const projectWithRepo: ProjectDetail = {
      ...project,
      frontmatter: {
        ...project.frontmatter,
        repo: "~/code/yoplai",
      },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <AgentPanel
          project={projectWithRepo}
          area={undefined}
          areas={[]}
          subagents={[]}
          onSubagentsChange={() => {}}
          onOpenSpawn={() => {}}
          onTitleChange={() => {}}
          onStatusChange={() => {}}
          onAreaChange={() => {}}
          onRepoChange={() => {}}
          selectedAgentSlug={null}
          onSelectAgent={() => {}}
        />
      ),
      container
    );

    expect(container.querySelector(".repo-row")).toBeNull();

    const toggle = container.querySelector(
      ".repo-toggle-btn"
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const repoValue = container.querySelector(
      ".repo-value"
    ) as HTMLParagraphElement;
    expect(repoValue).toBeTruthy();
    expect(repoValue.textContent).toContain("~/code/yoplai");

    repoValue.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector(".repo-input")).not.toBeNull();

    dispose();
  });

  it("polls subagent list as realtime fallback", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchSubagents).mockResolvedValue({
      ok: true,
      data: { items: [] },
    });

    const { dispose } = setup();
    await Promise.resolve();
    await Promise.resolve();
    const firstCalls = vi.mocked(fetchSubagents).mock.calls.length;

    await vi.advanceTimersByTimeAsync(2100);
    const nextCalls = vi.mocked(fetchSubagents).mock.calls.length;

    expect(firstCalls).toBeGreaterThan(0);
    expect(nextCalls).toBeGreaterThan(firstCalls);

    dispose();
    vi.useRealTimers();
  });

  it("preserves subagent row DOM for equivalent poll results", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchSubagents).mockResolvedValue({
        ok: true,
        data: {
          items: [
            {
              slug: "alpha",
              cli: "codex",
              model: "gpt-5.3-codex",
              status: "idle",
              name: "Worker Alpha",
            },
          ],
        },
      });

      const { container, dispose } = setup();
      await Promise.resolve();
      await Promise.resolve();

      const firstRow = container.querySelector(
        ".agent-list-item.subagent"
      ) as HTMLDivElement;
      expect(firstRow).toBeTruthy();

      await vi.advanceTimersByTimeAsync(2100);

      const secondRow = container.querySelector(
        ".agent-list-item.subagent"
      ) as HTMLDivElement;
      expect(secondRow).toBe(firstRow);

      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports inline subagent rename", async () => {
    vi.mocked(fetchSubagents).mockResolvedValueOnce({
      ok: true,
      data: {
        items: [
          {
            slug: "alpha",
            cli: "codex",
            name: "Worker Alpha",
            status: "idle",
          },
        ],
      },
    });
    vi.mocked(renameSubagent).mockResolvedValueOnce({
      ok: true,
      data: {
        slug: "alpha",
        cli: "codex",
        name: "Worker Renamed",
        status: "idle",
      },
    });

    const { container, dispose } = setup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    vi.mocked(renameSubagent).mockClear();
    const renameButton = container.querySelector(
      ".agent-name-btn"
    ) as HTMLButtonElement;
    renameButton.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    const input = container.querySelector(
      ".agent-name-input"
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = "Worker Renamed";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renameSubagent).toHaveBeenCalledWith(
      "PRO-1",
      "alpha",
      "Worker Renamed"
    );
    expect(renameSubagent).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Worker Renamed");

    dispose();
  });

  it("saves inline rename on blur", async () => {
    vi.mocked(fetchSubagents).mockResolvedValueOnce({
      ok: true,
      data: {
        items: [
          {
            slug: "alpha",
            cli: "codex",
            name: "Worker Alpha",
            status: "idle",
          },
        ],
      },
    });
    vi.mocked(renameSubagent).mockResolvedValueOnce({
      ok: true,
      data: {
        slug: "alpha",
        cli: "codex",
        name: "Worker Blur",
        status: "idle",
      },
    });

    const { container, dispose } = setup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const renameButton = container.querySelector(
      ".agent-name-btn"
    ) as HTMLButtonElement;
    renameButton.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    const input = container.querySelector(
      ".agent-name-input"
    ) as HTMLInputElement;
    input.value = "Worker Blur";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(renameSubagent).toHaveBeenCalledWith(
      "PRO-1",
      "alpha",
      "Worker Blur"
    );
    expect(renameSubagent).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Worker Blur");

    dispose();
  });

  it("does not select subagent when pressing Space during rename", async () => {
    vi.mocked(fetchSubagents).mockResolvedValueOnce({
      ok: true,
      data: {
        items: [
          {
            slug: "alpha",
            cli: "codex",
            name: "Worker Alpha",
            status: "idle",
          },
        ],
      },
    });
    const onSelectAgent = vi.fn();

    const { container, dispose } = setup({ onSelectAgent });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const renameButton = container.querySelector(
      ".agent-name-btn"
    ) as HTMLButtonElement;
    renameButton.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    const input = container.querySelector(
      ".agent-name-input"
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true })
    );

    expect(onSelectAgent).not.toHaveBeenCalled();
    expect(container.querySelector(".agent-name-input")).toBeTruthy();

    dispose();
  });
});
