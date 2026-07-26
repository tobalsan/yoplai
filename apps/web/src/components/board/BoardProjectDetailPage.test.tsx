// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Suspense, createResource, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { BoardProjectDetailPage } from "./BoardProjectDetailPage";
import {
  fetchProject,
  updateProject,
  addProjectComment,
  createSlice,
  fetchBoardActivity,
} from "../../api";

const navigateMock = vi.fn();
const [searchParamsSignal, setSearchParamsSignal] = createSignal<
  Record<string, string | undefined>
>({});
const [pathSignal, setPathSignal] = createSignal("/board/projects/PRO-42");
const searchParamsProxy = new Proxy(
  {},
  {
    get(_target, key: string) {
      return searchParamsSignal()[key];
    },
  }
) as Record<string, string | undefined>;
const paramsProxy = new Proxy(
  {},
  {
    get(_target, key: string) {
      const match = pathSignal().match(
        /^\/board\/projects\/([^/]+)(?:\/slices\/([^/]+))?/
      );
      if (key === "projectId") {
        return decodeURIComponent(match?.[1] ?? "PRO-42");
      }
      if (key === "sliceId") {
        return match?.[2] ? decodeURIComponent(match[2]) : undefined;
      }
      return undefined;
    },
  }
) as { projectId: string; sliceId?: string };
const { sliceKanbanSuspendedMock, sliceKanbanPromise } = vi.hoisted(() => ({
  sliceKanbanSuspendedMock: vi.fn(() => false),
  sliceKanbanPromise: new Promise(() => {}),
}));

vi.mock("@solidjs/router", () => ({
  useParams: () => paramsProxy,
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParamsProxy, vi.fn()],
}));

const MOCK_PROJECT = {
  id: "PRO-42",
  title: "Refactor Auth",
  path: "PRO-42_refactor-auth",
  absolutePath: "/tmp/PRO-42_refactor-auth",
  repoValid: true,
  frontmatter: { area: "yoplai", status: "shaping" },
  docs: {
    PITCH: "# Refactor Auth\n\nThis is the pitch.",
    THREAD: "# Thread\n\nDiscussion here.",
  },
  thread: [
    {
      author: "Alice",
      date: "2026-01-15T10:00:00Z",
      body: "First **comment** with [link](https://example.com).\n\n<script>alert(1)</script>",
    },
  ],
};

vi.mock("../../api", () => ({
  fetchProject: vi.fn(async () => MOCK_PROJECT),
  fetchAreas: vi.fn(async () => [
    { id: "yoplai", title: "Yoplai", color: "#53b97c", repo: "~/code/yoplai" },
  ]),
  updateProject: vi.fn(async () => MOCK_PROJECT),
  addProjectComment: vi.fn(async () => ({
    author: "Yoplai",
    date: new Date().toISOString(),
    body: "New comment",
  })),
  createSlice: vi.fn(async () => ({
    id: "PRO-42-S01",
    projectId: "PRO-42",
    dirPath: "slices/PRO-42-S01",
    frontmatter: {
      id: "PRO-42-S01",
      project_id: "PRO-42",
      title: "My new slice",
      status: "todo",
      hill_position: "figuring",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    docs: { readme: "", specs: "", tasks: "", validation: "", thread: "" },
  })),
  subscribeToFileChanges: vi.fn(() => () => {}),
  subscribeToSubagentChanges: vi.fn(() => () => {}),
  fetchRuntimeSubagents: vi.fn(async () => ({ items: [] })),
  fetchRuntimeSubagentLogs: vi.fn(async () => ({ events: [], cursor: 0 })),
  interruptRuntimeSubagent: vi.fn(async () => ({ ok: true, data: {} })),
  archiveRuntimeSubagent: vi.fn(async () => ({ ok: true, data: {} })),
  deleteRuntimeSubagent: vi.fn(async () => ({ ok: true })),
  resumeRuntimeSubagent: vi.fn(async () => ({ ok: true, data: {} })),
  fetchAgents: vi.fn(async () => []),
  fetchBoardActivity: vi.fn(async () => ({
    items: [
      {
        id: "activity-1",
        type: "project_status",
        projectId: "PRO-42",
        actor: "PRO-42",
        action: "→ active",
        timestamp: new Date().toISOString(),
        color: "green",
      },
    ],
  })),
  // SliceKanbanWidget deps
  fetchSlices: vi.fn(async () => []),
  updateSlice: vi.fn(async () => ({})),
}));

// Mock DocEditor to avoid Tiptap DOM complexity
vi.mock("./DocEditor", () => ({
  DocEditor: (props: {
    projectId: string;
    docKey: string;
    content: string;
    onSave: (c: string) => void;
    headerContent?: JSX.Element;
  }) => (
    <div
      data-testid="doc-editor"
      data-dockey={props.docKey}
      data-content={props.content}
    >
      {props.headerContent}
      <button
        type="button"
        data-testid={`save-doc-${props.docKey}`}
        onClick={() => props.onSave(`saved:${props.docKey}`)}
      >
        Save
      </button>
    </div>
  ),
}));

// Mock SliceKanbanWidget
vi.mock("../SliceKanbanWidget", () => ({
  SliceKanbanWidget: (props: {
    projectId: string;
    onSliceClick?: (sliceId: string) => void;
  }) => {
    const [ready] = createResource(
      () => props.projectId,
      async () => {
        if (sliceKanbanSuspendedMock()) await sliceKanbanPromise;
        return true;
      }
    );
    ready();
    return (
      <button
        type="button"
        data-testid="slice-kanban"
        data-project-id={props.projectId}
        onClick={() => props.onSliceClick?.("PRO-42-S01")}
      >
        Open slice
      </button>
    );
  },
}));

vi.mock("../SliceDetailPage", () => ({
  SliceDetailPage: (props: {
    projectId: string;
    sliceId: string;
    routeBase?: string;
    onBack?: () => void;
  }) => (
    <div
      data-testid="slice-detail"
      data-project-id={props.projectId}
      data-slice-id={props.sliceId}
      data-route-base={props.routeBase}
    >
      <button type="button" data-testid="slice-back" onClick={props.onBack}>
        Back to project
      </button>
    </div>
  ),
}));

function wait(ms = 0) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe("BoardProjectDetailPage", () => {
  let container: HTMLDivElement;
  let dispose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/board/projects/PRO-42");
    setPathSignal("/board/projects/PRO-42");
    setSearchParamsSignal({});
    navigateMock.mockImplementation((to: string) => {
      const url = new URL(to, "http://localhost");
      window.history.pushState(null, "", `${url.pathname}${url.search}`);
      setPathSignal(url.pathname);
      setSearchParamsSignal(Object.fromEntries(url.searchParams.entries()));
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    sliceKanbanSuspendedMock.mockReturnValue(false);
    vi.mocked(fetchProject).mockResolvedValue(MOCK_PROJECT);
    vi.mocked(updateProject).mockResolvedValue(MOCK_PROJECT);
  });

  afterEach(() => {
    dispose?.();
    window.history.replaceState(null, "", "/board/projects/PRO-42");
    document.body.removeChild(container);
    container = document.createElement("div");
  });

  it("renders header with ID, title, status pill, area, and back button", async () => {
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    expect(container.textContent).toContain("PRO-42");
    expect(container.textContent).toContain("Refactor Auth");
    expect(container.textContent).toContain("shaping");
    expect(container.textContent).toContain("Yoplai");
    const back = container.querySelector(".bpd-back");
    expect(back).not.toBeNull();
  });

  it("navigates to /board on back button click", async () => {
    navigateMock.mockReset();
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();

    const back = container.querySelector(".bpd-back") as HTMLButtonElement;
    back.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(navigateMock).toHaveBeenCalledWith("/board");
  });

  it("renders 5 tabs: Pitch, Slices, Thread, Activity, Agent", async () => {
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    const tabs = Array.from(container.querySelectorAll(".bpd-tab")).map((t) =>
      t.textContent?.trim()
    );
    expect(tabs).toEqual(["Pitch", "Slices", "Thread", "Activity", "Agent"]);
  });

  it("Pitch tab is active by default and shows DocEditor for PITCH", async () => {
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    const activeTab = container.querySelector(".bpd-tab.active");
    expect(activeTab?.textContent?.trim()).toBe("Pitch");

    const editor = container.querySelector("[data-testid='doc-editor']");
    expect(editor).not.toBeNull();
    expect(editor?.getAttribute("data-dockey")).toBe("PITCH");
    expect(editor?.getAttribute("data-content")).toContain("Refactor Auth");
  });

  it("activates project tabs from the URL and updates the URL on tab click", async () => {
    window.history.replaceState(null, "", "/board/projects/PRO-42?tab=thread");
    setSearchParamsSignal({ tab: "thread" });

    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    expect(
      container.querySelector(".bpd-tab.active")?.textContent?.trim()
    ).toBe("Thread");

    const activityTab = Array.from(container.querySelectorAll(".bpd-tab")).find(
      (t) => t.textContent?.trim() === "Activity"
    ) as HTMLButtonElement;
    activityTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();

    expect(navigateMock).toHaveBeenCalledWith(
      "/board/projects/PRO-42?tab=activity"
    );
    expect(window.location.pathname + window.location.search).toBe(
      "/board/projects/PRO-42?tab=activity"
    );
  });

  it("switching to Slices tab shows SliceKanbanWidget and Add slice button", async () => {
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    const slicesTab = Array.from(container.querySelectorAll(".bpd-tab")).find(
      (t) => t.textContent?.trim() === "Slices"
    ) as HTMLButtonElement;
    slicesTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();
    await wait();

    expect(
      container.querySelector("[data-testid='slice-kanban']")
    ).not.toBeNull();
    expect(
      (container.querySelector("[data-testid='slice-kanban']") as HTMLElement)
        ?.dataset.projectId
    ).toBe("PRO-42");

    const addBtn = container.querySelector(".bpd-add-slice-btn");
    expect(addBtn).not.toBeNull();
    expect(addBtn?.textContent?.trim()).toContain("Add slice");
  });

  it("Slices tab loading stays inside the tab panel Suspense boundary", async () => {
    sliceKanbanSuspendedMock.mockReturnValue(true);
    dispose = render(
      () => (
        <Suspense
          fallback={<div data-testid="parent-suspense">Parent loading</div>}
        >
          <BoardProjectDetailPage />
        </Suspense>
      ),
      container
    );
    await wait();
    await wait();

    const slicesTab = Array.from(container.querySelectorAll(".bpd-tab")).find(
      (t) => t.textContent?.trim() === "Slices"
    ) as HTMLButtonElement;
    slicesTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();

    expect(
      container.querySelector("[data-testid='parent-suspense']")
    ).toBeNull();
    expect(container.querySelector(".bpd-header")).not.toBeNull();
    expect(container.querySelector(".bpd-tabs")).not.toBeNull();
    expect(container.querySelector(".bpd-slices-kanban")).not.toBeNull();
  });

  it("opens slice detail inside the Slices tab pane", async () => {
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    const slicesTab = Array.from(container.querySelectorAll(".bpd-tab")).find(
      (t) => t.textContent?.trim() === "Slices"
    ) as HTMLButtonElement;
    slicesTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();

    const kanban = container.querySelector(
      "[data-testid='slice-kanban']"
    ) as HTMLButtonElement;
    kanban.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();

    const activeTab = container.querySelector(".bpd-tab.active");
    expect(activeTab?.textContent?.trim()).toBe("Slices");
    const detail = container.querySelector("[data-testid='slice-detail']");
    expect(detail).not.toBeNull();
    expect(detail?.getAttribute("data-project-id")).toBe("PRO-42");
    expect(detail?.getAttribute("data-slice-id")).toBe("PRO-42-S01");
    expect(detail?.getAttribute("data-route-base")).toBe("board");
    expect(container.querySelector(".bpd-header")).not.toBeNull();
    expect(window.location.pathname).toBe(
      "/board/projects/PRO-42/slices/PRO-42-S01"
    );
  });

  it("opens slice detail from a nested board slice URL", async () => {
    window.history.replaceState(
      null,
      "",
      "/board/projects/PRO-42/slices/PRO-42-S01"
    );
    setPathSignal("/board/projects/PRO-42/slices/PRO-42-S01");

    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    expect(
      container.querySelector(".bpd-tab.active")?.textContent?.trim()
    ).toBe("Slices");
    const detail = container.querySelector("[data-testid='slice-detail']");
    expect(detail).not.toBeNull();
    expect(detail?.getAttribute("data-slice-id")).toBe("PRO-42-S01");
  });

  it("slice creation form appears and submits on click", async () => {
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    // Navigate to Slices tab
    const slicesTab = Array.from(container.querySelectorAll(".bpd-tab")).find(
      (t) => t.textContent?.trim() === "Slices"
    ) as HTMLButtonElement;
    slicesTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();

    // Click + Add slice
    const addBtn = container.querySelector(
      ".bpd-add-slice-btn"
    ) as HTMLButtonElement;
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();

    // Form should appear
    const form = container.querySelector(".bpd-add-slice-form");
    expect(form).not.toBeNull();

    // Fill in title
    const input = container.querySelector(
      ".bpd-add-slice-input"
    ) as HTMLInputElement;
    input.value = "My new slice";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    // Submit
    const submit = container.querySelector(
      ".bpd-add-slice-submit"
    ) as HTMLButtonElement;
    submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    form?.dispatchEvent(new Event("submit", { bubbles: true }));
    await wait();
    await wait();

    expect(createSlice).toHaveBeenCalledWith("PRO-42", {
      title: "My new slice",
      status: "todo",
    });
  });

  it("shows slice creation API errors", async () => {
    vi.mocked(createSlice).mockRejectedValueOnce(
      new Error("Cannot create slice")
    );
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    const slicesTab = Array.from(container.querySelectorAll(".bpd-tab")).find(
      (t) => t.textContent?.trim() === "Slices"
    ) as HTMLButtonElement;
    slicesTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();

    const addBtn = container.querySelector(
      ".bpd-add-slice-btn"
    ) as HTMLButtonElement;
    addBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = container.querySelector(
      ".bpd-add-slice-input"
    ) as HTMLInputElement;
    input.value = "My new slice";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const form = container.querySelector(".bpd-add-slice-form");
    form?.dispatchEvent(new Event("submit", { bubbles: true }));

    await wait();
    expect(container.textContent).toContain("Cannot create slice");
  });

  it("Thread tab shows comments and comment form without DocEditor", async () => {
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    const threadTab = Array.from(container.querySelectorAll(".bpd-tab")).find(
      (t) => t.textContent?.trim() === "Thread"
    ) as HTMLButtonElement;
    threadTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();

    const editor = container.querySelector("[data-testid='doc-editor']");
    expect(editor).toBeNull();

    // Existing comment shown
    expect(container.textContent).toContain("First comment with link.");
    expect(container.textContent).toContain("Alice");

    const body = container.querySelector(".bpd-comment-body") as HTMLElement;
    expect(body.innerHTML).toContain("<strong>comment</strong>");
    expect(body.innerHTML).not.toContain("<script>");
    const link = body.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");

    // Comment form present
    const commentInput = container.querySelector(".bpd-comment-input");
    expect(commentInput).not.toBeNull();
    const submitBtn = container.querySelector(".bpd-comment-submit");
    expect(submitBtn).not.toBeNull();
  });

  it("Thread tab shows empty state when there are no comments", async () => {
    vi.mocked(fetchProject).mockResolvedValue({
      ...MOCK_PROJECT,
      thread: [],
    });
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    const threadTab = Array.from(container.querySelectorAll(".bpd-tab")).find(
      (t) => t.textContent?.trim() === "Thread"
    ) as HTMLButtonElement;
    threadTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();

    expect(container.textContent).toContain("No comments yet.");
    expect(container.querySelector("[data-testid='doc-editor']")).toBeNull();
    expect(container.querySelector(".bpd-comment-input")).not.toBeNull();
  });

  it("post comment calls addProjectComment and refetches", async () => {
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    const threadTab = Array.from(container.querySelectorAll(".bpd-tab")).find(
      (t) => t.textContent?.trim() === "Thread"
    ) as HTMLButtonElement;
    threadTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();

    const input = container.querySelector(
      ".bpd-comment-input"
    ) as HTMLTextAreaElement;
    input.value = "Hello world";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await wait();

    const form = container.querySelector(
      ".bpd-comment-form"
    ) as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true }));
    await wait();
    await wait();

    expect(addProjectComment).toHaveBeenCalledWith("PRO-42", "Hello world");
  });

  it("Activity tab shows project feed", async () => {
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    const activityTab = Array.from(container.querySelectorAll(".bpd-tab")).find(
      (t) => t.textContent?.trim() === "Activity"
    ) as HTMLButtonElement;
    activityTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();

    await wait();

    expect(fetchBoardActivity).toHaveBeenCalledWith({
      projectId: "PRO-42",
      limit: 20,
    });
    expect(container.textContent).toContain("PRO-42");
    expect(container.textContent).toContain("→ active");
  });

  it("Pitch tab save calls updateProject with PITCH content", async () => {
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    const saveBtn = container.querySelector(
      "[data-testid='save-doc-PITCH']"
    ) as HTMLButtonElement;
    expect(saveBtn).not.toBeNull();
    saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();

    expect(updateProject).toHaveBeenCalledWith("PRO-42", {
      docs: { PITCH: "saved:PITCH" },
    });
  });

  it("lifecycle action menu shows Move to active for shaping status", async () => {
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    const trigger = container.querySelector(
      ".bpd-action-menu-trigger"
    ) as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();

    const items = Array.from(
      container.querySelectorAll(".bpd-action-item")
    ).map((el) => el.textContent?.trim());
    expect(items).toContain("Move to active");
  });

  it("action menu shows Edit repo and opens the modal", async () => {
    vi.mocked(fetchProject).mockResolvedValue({
      ...MOCK_PROJECT,
      frontmatter: { ...MOCK_PROJECT.frontmatter, repo: "/tmp/repo" },
    });
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    expect(container.textContent).not.toContain("Edit repo…");
    const trigger = container.querySelector(
      ".bpd-action-menu-trigger"
    ) as HTMLButtonElement;
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();

    const edit = Array.from(
      container.querySelectorAll(".bpd-action-item")
    ).find(
      (el) => el.textContent?.trim() === "Edit repo…"
    ) as HTMLButtonElement;
    expect(edit).not.toBeNull();
    edit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();

    const input = container.querySelector(
      ".edit-repo-modal__input"
    ) as HTMLInputElement;
    expect(input.value).toBe("/tmp/repo");
  });

  it("lifecycle action calls updateProject with next status", async () => {
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    const trigger = container.querySelector(
      ".bpd-action-menu-trigger"
    ) as HTMLButtonElement;
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();

    const moveActive = Array.from(
      container.querySelectorAll(".bpd-action-item")
    ).find(
      (el) => el.textContent?.trim() === "Move to active"
    ) as HTMLButtonElement;
    moveActive.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wait();
    await wait();

    expect(updateProject).toHaveBeenCalledWith("PRO-42", { status: "active" });
  });

  it("tab navigation: all 4 tabs clickable", async () => {
    dispose = render(() => <BoardProjectDetailPage />, container);
    await wait();
    await wait();

    const tabLabels = ["Pitch", "Slices", "Thread", "Activity"];
    for (const label of tabLabels) {
      const tab = Array.from(container.querySelectorAll(".bpd-tab")).find(
        (t) => t.textContent?.trim() === label
      ) as HTMLButtonElement;
      tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await wait();

      const active = container.querySelector(".bpd-tab.active");
      expect(active?.textContent?.trim()).toBe(label);
    }
  });
});
