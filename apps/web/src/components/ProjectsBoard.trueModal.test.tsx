// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import { ProjectsBoard } from "./ProjectsBoard";
import {
  createProject,
  validateProjectRepo,
  fetchAreas,
  updateProject,
} from "../api";

const navigateMock = vi.fn();

vi.mock("@solidjs/router", () => ({
  useSearchParams: () => {
    const [project] = createSignal<string | undefined>(undefined);
    const params = {} as { readonly project?: string };
    Object.defineProperty(params, "project", {
      get: () => project(),
    });
    return [params, () => {}] as const;
  },
  useNavigate: () => navigateMock,
  A: (props: Record<string, unknown>) => <a {...props} />,
}));

vi.mock("../api", () => ({
  fetchProjects: vi.fn(async () => [
    {
      id: "PRO-1",
      title: "Alpha Project",
      path: "PRO-1_alpha-project",
      absolutePath: "/tmp/PRO-1_alpha-project",
      frontmatter: { status: "maybe" },
    },
  ]),
  fetchAreas: vi.fn(async () => []),
  fetchArchivedProjects: vi.fn(async () => []),
  fetchProject: vi.fn(async () => ({
    id: "PRO-1",
    title: "Alpha Project",
    path: "PRO-1_alpha-project",
    absolutePath: "/tmp/PRO-1_alpha-project",
    frontmatter: {},
    docs: { README: "Project details" },
    thread: [],
  })),
  updateProject: vi.fn(async () => ({})),
  deleteProject: vi.fn(async () => ({ ok: true })),
  archiveProject: vi.fn(async () => ({ ok: true })),
  unarchiveProject: vi.fn(async () => ({ ok: true })),
  createProject: vi.fn(async () => ({
    ok: true,
    data: { id: "PRO-2", title: "New" },
  })),
  validateProjectRepo: vi.fn(async () => ({ valid: true })),
  fetchAgents: vi.fn(async () => []),
  fetchAllSubagents: vi.fn(async () => ({ items: [] })),
  fetchFullHistory: vi.fn(async () => ({ messages: [] })),
  fetchSubagents: vi.fn(async () => ({ ok: true, data: { items: [] } })),
  fetchSubagentLogs: vi.fn(async () => ({
    ok: true,
    data: { cursor: 0, events: [] },
  })),
  fetchProjectBranches: vi.fn(async () => ({
    ok: true,
    data: { branches: [] },
  })),
  killSubagent: vi.fn(async () => ({ ok: true })),
  archiveSubagent: vi.fn(async () => ({ ok: true })),
  unarchiveSubagent: vi.fn(async () => ({ ok: true })),
  interruptSubagent: vi.fn(async () => ({ ok: true })),
  uploadAttachments: vi.fn(async () => ({ ok: true, data: [] })),
  addProjectComment: vi.fn(async () => ({})),
  updateProjectComment: vi.fn(async () => ({})),
  deleteProjectComment: vi.fn(async () => ({})),
  startProjectRun: vi.fn(async () => ({ ok: true })),
  subscribeToFileChanges: vi.fn(() => () => {}),
}));

vi.mock("./AgentSidebar", () => ({ AgentSidebar: () => null }));
vi.mock("./ContextPanel", () => ({ ContextPanel: () => null }));
vi.mock("./ActivityFeed", () => ({ ActivityFeed: () => null }));
vi.mock("./AgentChat", () => ({ AgentChat: () => null }));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const setupMatchMedia = () => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
};

const setupRaf = () => {
  window.requestAnimationFrame = (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(Date.now()), 0);
  window.cancelAnimationFrame = (id: number) => window.clearTimeout(id);
};

describe("ProjectsBoard card navigation", () => {
  beforeEach(() => {
    delegateEvents(["click", "input", "keydown"]);
    setupMatchMedia();
    setupRaf();
    localStorage.clear();
    localStorage.setItem(
      "yoplai:projects:expanded-columns",
      JSON.stringify(["triage"])
    );
  });

  afterEach(() => {
    navigateMock.mockReset();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("navigates to detail route on project click", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <ProjectsBoard />, container);

    await tick();
    await tick();

    const card = container.querySelector(".card") as HTMLDivElement;
    card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(navigateMock).toHaveBeenCalledWith("/projects/PRO-1");

    dispose();
  });

  it("prefills repo from selected area and submits it", async () => {
    vi.mocked(fetchAreas).mockResolvedValueOnce([
      {
        id: "yoplai",
        title: "Yoplai",
        color: "#3b8ecc",
        repo: "/tmp/yoplai",
      },
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <ProjectsBoard />, container);
    await tick();
    await tick();

    const newButton = container.querySelector(
      ".create-btn"
    ) as HTMLButtonElement;
    newButton.click();
    await tick();

    const titleInput = container.querySelector(
      "#create-title"
    ) as HTMLInputElement;
    titleInput.value = "Repo Project";
    titleInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const areaInput = container.querySelector(
      "#create-area"
    ) as HTMLInputElement;
    areaInput.focus();
    areaInput.value = "Yoplai";
    areaInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await tick();
    const areaButton = Array.from(
      container.querySelectorAll(".area-suggestion")
    ).find(
      (button) => button.textContent?.trim() === "Yoplai"
    ) as HTMLButtonElement;
    areaButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await tick();

    const repoInput = container.querySelector(
      "#create-repo"
    ) as HTMLInputElement;
    expect(repoInput.value).toBe("/tmp/yoplai");
    const createButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Create"
    ) as HTMLButtonElement;
    createButton.click();
    await tick();

    expect(createProject).toHaveBeenCalledWith({
      title: "Repo Project",
      area: "yoplai",
      repo: "/tmp/yoplai",
    });
    dispose();
  });

  it("shows repo validation feedback on blur without blocking creation", async () => {
    vi.mocked(validateProjectRepo).mockResolvedValueOnce({ valid: false });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <ProjectsBoard />, container);
    await tick();
    await tick();

    const newButton = container.querySelector(
      ".create-btn"
    ) as HTMLButtonElement;
    newButton.click();
    await tick();
    const repoInput = container.querySelector(
      "#create-repo"
    ) as HTMLInputElement;
    repoInput.value = "/tmp/missing";
    repoInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    repoInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await tick();
    await tick();

    expect(validateProjectRepo).toHaveBeenCalledWith("/tmp/missing");
    expect(container.textContent).toContain("Path is not a git repo");
    dispose();
  });

  it("shows an error toast when drag status update fails", async () => {
    vi.mocked(updateProject).mockRejectedValueOnce(
      new Error("Cannot move project to Shaping: project repo is not set.")
    );
    localStorage.setItem(
      "yoplai:projects:expanded-columns",
      JSON.stringify(["triage", "shaping"])
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <ProjectsBoard />, container);
    await tick();
    await tick();

    const card = container.querySelector(".card") as HTMLElement;
    card.dispatchEvent(new Event("dragstart", { bubbles: true }));
    let shapingColumn: HTMLElement | undefined;
    await vi.waitFor(() => {
      shapingColumn = Array.from(container.querySelectorAll(".column")).find(
        (column) => column.textContent?.includes("Shaping")
      ) as HTMLElement | undefined;
      expect(shapingColumn).toBeTruthy();
    });
    shapingColumn?.dispatchEvent(new Event("drop", { bubbles: true }));

    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        "Cannot move project to Shaping: project repo is not set."
      );
    });
    dispose();
  });
});
