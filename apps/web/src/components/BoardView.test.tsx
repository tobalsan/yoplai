// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense, createSignal } from "solid-js";
import { within, isInaccessible } from "@testing-library/dom";
import { delegateEvents, render } from "solid-js/web";
import { BoardView } from "./BoardView";

const [searchParamsSignal, setSearchParamsSignal] = createSignal<
  Record<string, string | undefined>
>({});
const searchParamsProxy = new Proxy(
  {},
  {
    get(_target, key: string) {
      return searchParamsSignal()[key];
    },
  }
);
const [pathSignal, setPathSignal] = createSignal("/");
const locationProxy = new Proxy(
  {},
  {
    get(_target, key: string) {
      if (key === "pathname") return pathSignal();
      return undefined;
    },
  }
) as { pathname: string };
const paramsProxy = new Proxy(
  {},
  {
    get(_target, key: string) {
      const match = pathSignal().match(
        /^\/board\/projects(?:\/([^/]+)(?:\/slices\/([^/]+))?)?/
      );
      if (key === "projectId") {
        return match?.[1] ? decodeURIComponent(match[1]) : undefined;
      }
      if (key === "sliceId") {
        return match?.[2] ? decodeURIComponent(match[2]) : undefined;
      }
      return undefined;
    },
  }
) as { projectId?: string; sliceId?: string };
const navigateMock = vi.fn((to: string) => {
  const url = new URL(to, "http://localhost");
  window.history.pushState(null, "", `${url.pathname}${url.search}`);
  setPathSignal(url.pathname);
  setSearchParamsSignal(Object.fromEntries(url.searchParams.entries()));
});

const {
  fetchAgentsMock,
  fetchAreaSummariesMock,
  fetchBoardProjectsMock,
  fetchProjectMock,
  fetchSubagentsMock,
  fetchRuntimeSubagentsMock,
  subscribeToFileChangesMock,
  subscribeToSubagentChangesMock,
  subscribeToRealtimeMock,
  uploadFilesMock,
} = vi.hoisted(() => ({
  fetchAgentsMock: vi.fn(),
  fetchAreaSummariesMock: vi.fn(),
  fetchBoardProjectsMock: vi.fn(),
  fetchProjectMock: vi.fn(),
  fetchSubagentsMock: vi.fn(),
  fetchRuntimeSubagentsMock: vi.fn(),
  subscribeToFileChangesMock: vi.fn(),
  subscribeToSubagentChangesMock: vi.fn(),
  subscribeToRealtimeMock: vi.fn(),
  uploadFilesMock: vi.fn(),
}));

vi.mock("@solidjs/router", () => ({
  useParams: () => paramsProxy,
  useLocation: () => locationProxy,
  useNavigate: () => navigateMock,
  useSearchParams: () => [
    searchParamsProxy,
    (next: Record<string, string | undefined>) => {
      setSearchParamsSignal((prev) => ({ ...prev, ...next }));
    },
  ],
}));

// Mock heavy sub-components used by BoardProjectDetailPage
vi.mock("./board/DocEditor", () => ({
  DocEditor: (props: {
    projectId: string;
    docKey: string;
    content: string;
  }) => (
    <div
      data-testid="doc-editor"
      data-dockey={props.docKey}
      data-project-id={props.projectId}
    />
  ),
}));

vi.mock("../SliceKanbanWidget", () => ({
  SliceKanbanWidget: (props: { projectId: string }) => (
    <div data-testid="slice-kanban" data-project-id={props.projectId} />
  ),
}));

vi.mock("../ActivityFeed", () => ({
  ActivityFeed: (props: { projectId: string }) => (
    <div data-testid="activity-feed" data-project-id={props.projectId} />
  ),
}));

vi.mock("./SliceDetailPage", () => ({
  SliceDetailPage: (props: { projectId: string; sliceId: string }) => (
    <div
      data-testid="slice-detail"
      data-project-id={props.projectId}
      data-slice-id={props.sliceId}
    />
  ),
}));

vi.mock("../api", () => ({
  addProjectComment: vi.fn(),
  createProject: vi.fn(),
  createSlice: vi.fn(),
  fetchAgents: fetchAgentsMock,
  fetchAreas: vi.fn(async () => []),
  fetchAreaSummaries: fetchAreaSummariesMock,
  fetchBoardActivity: vi.fn(async () => ({ items: [] })),
  fetchBoardProjects: fetchBoardProjectsMock,
  fetchProject: fetchProjectMock,
  fetchSubagents: fetchSubagentsMock,
  fetchRuntimeSubagents: fetchRuntimeSubagentsMock,
  fetchRuntimeSubagentLogs: vi.fn(async () => ({ events: [], cursor: 0 })),
  fetchSlices: vi.fn(async () => []),
  moveBoardProject: vi.fn(),
  interruptRuntimeSubagent: vi.fn(async () => ({ ok: true, data: {} })),
  archiveRuntimeSubagent: vi.fn(async () => ({ ok: true, data: {} })),
  deleteRuntimeSubagent: vi.fn(async () => ({ ok: true })),
  postAbort: vi.fn(),
  resumeRuntimeSubagent: vi.fn(),
  subscribeToFileChanges: subscribeToFileChangesMock,
  subscribeToSubagentChanges: subscribeToSubagentChangesMock,
  subscribeToRealtime: subscribeToRealtimeMock,
  updateProject: vi.fn(),
  updateSlice: vi.fn(),
  uploadFiles: uploadFilesMock,
}));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function renderView() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dispose = render(() => <BoardView />, container);
  return { container, dispose };
}

function renderViewWithParentSuspense() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dispose = render(
    () => (
      <Suspense
        fallback={<div data-testid="parent-suspense">Parent loading</div>}
      >
        <BoardView />
      </Suspense>
    ),
    container
  );
  return { container, dispose };
}

describe("BoardView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
    setPathSignal("/");
    setSearchParamsSignal({});
    delegateEvents(["change", "click", "input", "keydown"]);
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ panel: "overview" })))
    );

    navigateMock.mockImplementation((to: string) => {
      const url = new URL(to, "http://localhost");
      window.history.pushState(null, "", `${url.pathname}${url.search}`);
      setPathSignal(url.pathname);
      setSearchParamsSignal(Object.fromEntries(url.searchParams.entries()));
    });

    fetchAgentsMock.mockResolvedValue([
      {
        id: "agent-1",
        name: "Agent",
        model: { provider: "openai", model: "gpt-5" },
        queueMode: "queue",
      },
    ]);
    fetchBoardProjectsMock.mockResolvedValue([
      {
        id: "PRO-1",
        title: "Embedded Overview Project",
        area: "platform",
        status: "active",
        lifecycleStatus: "active",
        group: "active",
        created: "2026-04-30T10:00:00.000Z",
        sliceProgress: { done: 1, total: 2 },
        lastActivity: "2026-04-30T10:00:00.000Z",
        activeRunCount: 0,
        worktrees: [],
      },
    ]);
    fetchAreaSummariesMock.mockResolvedValue([
      { id: "platform", title: "Platform", projectCount: 1 },
    ]);
    fetchProjectMock.mockResolvedValue({
      id: "PRO-1",
      title: "Embedded Overview Project",
      path: "PRO-1",
      absolutePath: "/tmp/PRO-1",
      repoValid: true,
      frontmatter: { status: "maybe" },
      docs: { PITCH: "# Embedded Overview Project\n\nBoard tab content." },
      thread: [],
    });
    fetchSubagentsMock.mockResolvedValue({ ok: true, data: { items: [] } });
    fetchRuntimeSubagentsMock.mockResolvedValue({ items: [] });
    subscribeToFileChangesMock.mockReturnValue(() => {});
    subscribeToSubagentChangesMock.mockReturnValue(() => {});
    subscribeToRealtimeMock.mockReturnValue(() => {});
    uploadFilesMock.mockResolvedValue([
      {
        path: "/tmp/uploaded/report.pdf",
        mimeType: "application/pdf",
        filename: "report.pdf",
        size: 12,
      },
    ]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows the canvas tabs without a chat composer", async () => {
    const { container, dispose } = renderView();
    await tick();
    await tick();

    expect(within(container).getByRole("button", { name: "Scratchpad" })).toBeTruthy();
    expect(within(container).getByRole("button", { name: "Project lifecycle" })).toBeTruthy();
    expect(within(container).queryByPlaceholderText("Ask anything...")).toBeNull();

    dispose();
  });

  it("switches between Scratchpad and Project lifecycle", async () => {
    const { container, dispose } = renderView();
    await tick();
    await tick();
    const scratchpad = within(container).getByLabelText("Scratchpad");
    expect(isInaccessible(scratchpad)).toBe(false);

    within(container).getByRole("button", { name: "Project lifecycle" }).click();
    await tick();
    expect(isInaccessible(scratchpad)).toBe(true);
    expect(within(container).getByRole("textbox").getAttribute("placeholder")).toBe("Search by title or ID…");

    within(container).getByRole("button", { name: "Scratchpad" }).click();
    await tick();
    expect(isInaccessible(scratchpad)).toBe(false);
    expect(within(container).getByRole("textbox", { name: "Scratchpad" })).toBe(scratchpad);
    expect(within(container).getAllByRole("textbox")).toHaveLength(1);

    dispose();
  });

  it("renders the lifecycle list in the Project lifecycle tab", async () => {
    const { container, dispose } = renderView();
    await tick();
    await tick();

    const projectsTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".board-canvas-tab")
    ).find((button) => button.textContent === "Project lifecycle");
    projectsTab?.click();
    await tick();
    await tick();

    expect(
      container.querySelector('[data-testid="project-list-grouped"]')
    ).not.toBeNull();
    expect(container.textContent).toContain("Embedded Overview Project");

    dispose();
  });

  it("keeps project row selection out of board canvas state", async () => {
    fetchBoardProjectsMock.mockResolvedValue([
      {
        id: "PRO-1",
        title: "Embedded Overview Project",
        area: "platform",
        status: "active",
        lifecycleStatus: "active",
        group: "active",
        created: "2026-04-30T10:00:00.000Z",
        sliceProgress: { done: 0, total: 1 },
        lastActivity: "2026-04-30T10:00:00.000Z",
        activeRunCount: 0,
        worktrees: [],
      },
      {
        id: "PRO-2",
        title: "Second Embedded Project",
        area: "platform",
        status: "active",
        lifecycleStatus: "active",
        group: "active",
        created: "2026-04-30T10:00:00.000Z",
        sliceProgress: { done: 0, total: 1 },
        lastActivity: "2026-04-30T10:00:00.000Z",
        activeRunCount: 0,
        worktrees: [],
      },
    ]);
    fetchProjectMock.mockResolvedValue({
      id: "PRO-2",
      title: "Second Embedded Project",
      path: "PRO-2",
      absolutePath: "/tmp/PRO-2",
      repoValid: true,
      frontmatter: { status: "active" },
      docs: { PITCH: "# Second Embedded Project" },
      thread: [],
    });
    const { container, dispose } = renderView();
    await tick();
    await tick();

    const projectsTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".board-canvas-tab")
    ).find((button) => button.textContent === "Project lifecycle");
    projectsTab?.click();
    await tick();
    await tick();

    vi.mocked(fetch).mockClear();
    const row = container.querySelector<HTMLElement>(
      '[data-testid="project-card-PRO-2"]'
    );
    row?.click();
    await tick();
    await tick();

    // Canvas state must NOT be updated to projects:detail
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([, init]) =>
          String(init?.body ?? "").includes("projects:detail")
        )
    ).toBe(false);
    expect(navigateMock).not.toHaveBeenCalled();
    // Detail page shown inline — .bpd element present
    expect(container.querySelector(".bpd")).not.toBeNull();
    // No router navigation triggered
    expect(container.textContent).toContain("Second Embedded Project");

    dispose();
  });

  it("keeps embedded project tab navigation out of the router", async () => {
    const { container, dispose } = renderView();
    await tick();
    await tick();

    const projectsTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".board-canvas-tab")
    ).find((button) => button.textContent === "Project lifecycle");
    projectsTab?.click();
    await tick();
    await tick();

    container
      .querySelector<HTMLElement>('[data-testid="project-card-PRO-1"]')
      ?.click();
    await tick();
    await tick();

    const slicesTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".bpd-tab")
    ).find((button) => button.textContent?.trim() === "Slices");
    slicesTab?.click();
    await tick();

    expect(navigateMock).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/board/projects/PRO-1");
    expect(window.location.search).toBe("?tab=slices");
    expect(container.querySelector(".bpd-tab.active")?.textContent).toBe(
      "Slices"
    );

    dispose();
  });

  it("clicking a project in lifecycle tab shows BoardProjectDetailPage inline", async () => {
    const { container, dispose } = renderView();
    await tick();
    await tick();

    const projectsTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".board-canvas-tab")
    ).find((button) => button.textContent === "Project lifecycle");
    projectsTab?.click();
    await tick();
    await tick();

    // List is visible before clicking
    expect(
      container.querySelector('[data-testid="project-list-grouped"]')
    ).not.toBeNull();

    const row = container.querySelector<HTMLElement>(
      '[data-testid="project-card-PRO-1"]'
    );
    row?.click();
    await tick();
    await tick();

    // List hidden, detail page shown
    expect(
      container.querySelector('[data-testid="project-list-grouped"]')
    ).toBeNull();
    expect(container.querySelector(".bpd")).not.toBeNull();
    // Back button returns to list
    const back = container.querySelector(".bpd-back") as HTMLButtonElement;
    back?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(
      container.querySelector('[data-testid="project-list-grouped"]')
    ).not.toBeNull();
    expect(container.querySelector(".bpd")).toBeNull();

    dispose();
  });

  it("opens the project lifecycle detail from a board project URL", async () => {
    window.history.replaceState(null, "", "/board/projects/PRO-1");
    setPathSignal("/board/projects/PRO-1");

    const { container, dispose } = renderView();
    await tick();
    await tick();

    expect(isInaccessible(within(container).getByText("Embedded Overview Project", { exact: true }))).toBe(false);
    expect(within(container).queryByRole("textbox", { name: "Scratchpad" })).toBeNull();
    expect(within(container).queryByPlaceholderText("Ask anything...")).toBeNull();

    dispose();
  });

  it("opens board-hosted slice detail from a board slice URL", async () => {
    window.history.replaceState(
      null,
      "",
      "/board/projects/PRO-1/slices/PRO-1-S01?tab=specs"
    );
    setPathSignal("/board/projects/PRO-1/slices/PRO-1-S01");
    setSearchParamsSignal({ tab: "specs" });

    const { container, dispose } = renderView();
    await tick();
    await tick();

    expect(container.querySelector(".bpd")).not.toBeNull();
    expect(
      container.querySelector('[data-testid="slice-detail"]')
    ).not.toBeNull();
    expect(container.querySelector(".bpd-tab.active")?.textContent).toBe(
      "Slices"
    );

    dispose();
  });

  it("project detail loading stays inside the canvas Suspense boundary", async () => {
    fetchProjectMock.mockImplementation(() => new Promise(() => {}));
    const { container, dispose } = renderViewWithParentSuspense();
    await tick();
    await tick();

    const projectsTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".board-canvas-tab")
    ).find((button) => button.textContent === "Project lifecycle");
    projectsTab?.click();
    await tick();
    await tick();

    const row = container.querySelector<HTMLElement>(
      '[data-testid="project-card-PRO-1"]'
    );
    row?.click();
    await tick();

    expect(
      container.querySelector("[data-testid='parent-suspense']")
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='canvas-loading']")
    ).not.toBeNull();
    expect(within(container).getByRole("button", { name: "Scratchpad" })).toBeTruthy();

    dispose();
  });
});
