// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { ProjectDetailPage } from "./ProjectDetailPage";
import {
  fetchAgentStatuses,
  fetchProject,
  subscribeToStatus,
  useProjectRealtime,
  updateProject,
} from "../../api";

const navigateMock = vi.fn();

vi.mock("@solidjs/router", () => ({
  useParams: () => ({ id: "PRO-1" }),
  useNavigate: () => navigateMock,
}));

vi.mock("../../api", () => ({
  fetchProject: vi.fn(async () => ({
    id: "PRO-1",
    title: "Alpha Project",
    path: "PRO-1_alpha-project",
    absolutePath: "/tmp/PRO-1_alpha-project",
    repoValid: true,
    frontmatter: { area: "yoplai", status: "todo" },
    docs: {},
    thread: [],
  })),
  fetchAreas: vi.fn(async () => [
    { id: "yoplai", title: "Yoplai", color: "#53b97c", repo: "~/code/yoplai" },
  ]),
  fetchTasks: vi.fn(async () => ({
    tasks: [
      {
        title: "Route setup",
        status: "todo",
        checked: false,
        order: 0,
      },
    ],
    progress: { done: 0, total: 1 },
  })),
  fetchSpec: vi.fn(async () => ({ content: "# Title" })),
  addProjectComment: vi.fn(async () => ({})),
  updateProject: vi.fn(async () => ({})),
  updateTask: vi.fn(async () => ({})),
  createTask: vi.fn(async () => ({})),
  saveSpec: vi.fn(async () => ({})),
  fetchSubagents: vi.fn(async () => ({ ok: true, data: { items: [] } })),
  fetchSubagentLogs: vi.fn(async () => ({
    ok: true,
    data: { cursor: 0, events: [] },
  })),
  subscribeToFileChanges: vi.fn(() => () => {}),
  useProjectRealtime: vi.fn(() => () => {}),
  fetchAgentStatuses: vi.fn(async () => ({ statuses: {} })),
  subscribeToStatus: vi.fn(() => () => {}),
  spawnSubagent: vi.fn(async () => ({ ok: true, data: { slug: "alpha" } })),
  fetchSpawnOptions: vi.fn(async () => ({
    agents: [{ id: "agent-1", name: "Lead Agent" }],
    subagentTemplates: [],
  })),
}));

function mockMatchMedia({
  compact = false,
  mobile = false,
}: {
  compact?: boolean;
  mobile?: boolean;
} = {}) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn((query: string) => ({
      matches:
        query === "(max-width: 1199px)"
          ? compact
          : query === "(max-width: 768px)"
            ? mobile
            : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("ProjectDetailPage", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.mocked(fetchAgentStatuses).mockResolvedValue({ statuses: {} });
    vi.mocked(subscribeToStatus).mockImplementation(() => () => {});
  });

  it("navigates to /projects when Back to Projects is clicked", async () => {
    navigateMock.mockReset();
    mockMatchMedia();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <ProjectDetailPage />, container);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const backButton = container.querySelector(
      ".project-detail-back"
    ) as HTMLButtonElement;
    backButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(navigateMock).toHaveBeenCalledWith("/projects");

    dispose();
  });

  it("renders three-column shell and breadcrumb", async () => {
    mockMatchMedia();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <ProjectDetailPage />, container);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelector(".project-detail")).not.toBeNull();
    expect(container.querySelector(".project-detail__left")).not.toBeNull();
    expect(container.querySelector(".project-detail__center")).not.toBeNull();
    expect(container.querySelector(".project-detail__right")).not.toBeNull();
    expect(container.textContent).toContain("Back to Projects");
    expect(container.textContent).toContain("Yoplai");
    expect(container.textContent).toContain("Alpha Project");
    expect(document.title).toContain("Alpha Project");

    dispose();
  });

  it("shows Edit repo only inside the Actions menu", async () => {
    mockMatchMedia();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <ProjectDetailPage />, container);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.textContent).not.toContain("Edit repo…");
    const trigger = container.querySelector(
      ".project-detail-action-menu-trigger"
    ) as HTMLButtonElement;
    expect(trigger.textContent?.trim()).toBe("Actions ▾");
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.textContent).toContain("Edit repo…");

    dispose();
  });

  it("opens the repo modal from the Actions menu", async () => {
    mockMatchMedia();
    vi.mocked(fetchProject).mockResolvedValueOnce({
      id: "PRO-1",
      title: "Alpha Project",
      path: "PRO-1_alpha-project",
      absolutePath: "/tmp/PRO-1_alpha-project",
      repoValid: true,
      frontmatter: {
        area: "yoplai",
        status: "todo",
        repo: "/tmp/repo",
      },
      docs: {},
      thread: [],
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <ProjectDetailPage />, container);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const trigger = container.querySelector(
      ".project-detail-action-menu-trigger"
    ) as HTMLButtonElement;
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const edit = Array.from(
      container.querySelectorAll(".project-detail-action-item")
    ).find(
      (item) => item.textContent?.trim() === "Edit repo…"
    ) as HTMLButtonElement;
    edit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const input = container.querySelector(
      ".edit-repo-modal__input"
    ) as HTMLInputElement;
    expect(input.value).toBe("/tmp/repo");

    dispose();
  });

  it("allows inline title edit on double-click and updates breadcrumb after save", async () => {
    vi.mocked(updateProject).mockClear();
    mockMatchMedia();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <ProjectDetailPage />, container);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const titleEl = container.querySelector(
      ".project-detail-title"
    ) as HTMLSpanElement;
    titleEl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    const input = container.querySelector(
      ".project-detail-title-input"
    ) as HTMLInputElement;
    input.value = "Renamed Project";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const saveButton = container.querySelector(
      ".project-detail-title-save"
    ) as HTMLButtonElement;
    saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(updateProject).toHaveBeenCalledWith("PRO-1", {
      title: "Renamed Project",
    });
    expect(
      container.querySelector(".project-detail-breadcrumb")?.textContent
    ).toContain("Renamed Project");

    dispose();
  });

  it("opens spawn form in center panel after selecting a template", async () => {
    mockMatchMedia();
    localStorage.setItem(
      "yoplai:project:PRO-1:center-view",
      JSON.stringify({ tab: "activity" })
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <ProjectDetailPage />, container);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const tabsBefore = Array.from(container.querySelectorAll(".center-tab"));
    const activeBefore = tabsBefore.find((item) =>
      item.classList.contains("active")
    );
    expect(activeBefore?.textContent?.trim()).toBe("Activity");

    const addButton = container.querySelector(
      ".add-agent-btn"
    ) as HTMLButtonElement;
    addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // Wait for fetchSpawnOptions to resolve
    await new Promise((resolve) => setTimeout(resolve, 0));

    const leadOption = Array.from(
      container.querySelectorAll(".template-option")
    ).find((item) =>
      item.textContent?.includes("Lead Agent")
    ) as HTMLButtonElement;
    leadOption.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    const tabsAfter = Array.from(container.querySelectorAll(".center-tab"));
    const activeAfter = tabsAfter.find((item) =>
      item.classList.contains("active")
    );
    expect(activeAfter?.textContent?.trim()).toBe("Chat");
    expect(container.textContent).toContain("Spawn Agent");

    dispose();
    localStorage.removeItem("yoplai:project:PRO-1:center-view");
  });

  it("restores a center view stored under the legacy per-project aihub key", async () => {
    mockMatchMedia();
    localStorage.clear();
    localStorage.setItem(
      "aihub:project:PRO-1:center-view",
      JSON.stringify({ tab: "activity" })
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <ProjectDetailPage />, container);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const active = Array.from(container.querySelectorAll(".center-tab")).find(
      (item) => item.classList.contains("active")
    );
    expect(active?.textContent?.trim()).toBe("Activity");
    expect(localStorage.getItem("yoplai:project:PRO-1:center-view")).toContain(
      "activity"
    );
    // A different project's legacy value must not leak in.
    expect(localStorage.getItem("yoplai:project:PRO-2:center-view")).toBeNull();

    dispose();
    localStorage.clear();
  });

  it("keeps the new per-project center view over a legacy one", async () => {
    mockMatchMedia();
    localStorage.clear();
    localStorage.setItem(
      "yoplai:project:PRO-1:center-view",
      JSON.stringify({ tab: "changes" })
    );
    localStorage.setItem(
      "aihub:project:PRO-1:center-view",
      JSON.stringify({ tab: "activity" })
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <ProjectDetailPage />, container);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const active = Array.from(container.querySelectorAll(".center-tab")).find(
      (item) => item.classList.contains("active")
    );
    expect(active?.textContent?.trim()).toBe("Changes");

    dispose();
    localStorage.clear();
  });

  it("disables agent creation and shows repo error when repo is invalid", async () => {
    mockMatchMedia();
    vi.mocked(fetchProject).mockResolvedValueOnce({
      id: "PRO-1",
      title: "Alpha Project",
      path: "PRO-1_alpha-project",
      absolutePath: "/tmp/PRO-1_alpha-project",
      repoValid: false,
      frontmatter: {
        area: "yoplai",
        status: "todo",
        repo: "/tmp/missing-repo",
      },
      docs: {},
      thread: [],
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <ProjectDetailPage />, container);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const addButton = container.querySelector(
      ".add-agent-btn"
    ) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Repo path not found: /tmp/missing-repo"
    );

    dispose();
  });

  it("renders a single mobile tabbed layout with overview by default", async () => {
    mockMatchMedia({ compact: true, mobile: true });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <ProjectDetailPage />, container);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const tabs = Array.from(
      container.querySelectorAll(".project-detail-merged-tabs button")
    ).map((button) => button.textContent?.trim());
    expect(tabs).toEqual([
      "Overview",
      "Chat",
      "Activity",
      "Changes",
      "Spec",
      "Slices",
    ]);
    expect(container.querySelector(".project-detail__center")).toBeNull();
    expect(container.querySelector(".project-detail__right")).toBeNull();
    expect(container.textContent).toContain("Back to Projects");
    expect(container.textContent).toContain("Yoplai");

    const activeTab = container.querySelector(
      ".project-detail-merged-tabs button.active"
    ) as HTMLButtonElement;
    expect(activeTab.textContent?.trim()).toBe("Overview");
    const styles = Array.from(container.querySelectorAll("style"))
      .map((node) => node.textContent ?? "")
      .join("\n");
    expect(styles).toContain(
      ".project-detail__merged-body {\n          min-height: 0;\n          overflow: hidden;"
    );

    dispose();
  });

  it("ignores session file changes for project refetch", async () => {
    mockMatchMedia();
    vi.mocked(fetchProject).mockClear();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <ProjectDetailPage />, container);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const initialCalls = vi.mocked(fetchProject).mock.calls.length;
    const callback = vi.mocked(useProjectRealtime).mock.calls[0]?.[2];
    expect(callback).toBeTypeOf("function");

    callback?.({
      type: "file_changed",
      projectId: "PRO-1",
      file: "PRO-1_alpha-project/sessions/coordinator/session.jsonl",
    });

    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(vi.mocked(fetchProject).mock.calls.length).toBe(initialCalls);

    dispose();
  });
});
