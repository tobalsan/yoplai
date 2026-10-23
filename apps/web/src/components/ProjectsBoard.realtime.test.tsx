// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { delegateEvents, render } from "solid-js/web";
import { ProjectsBoard } from "./ProjectsBoard";

let fileChangeCallbacks:
  | {
      onFileChanged?: (projectId: string, file: string) => void;
      onAgentChanged?: (projectId: string) => void;
      onError?: (error: string) => void;
    }
  | undefined;

vi.mock("../api", () => ({
  fetchProjects: vi.fn(() => []),
  fetchAreas: vi.fn(async () => []),
  fetchProject: vi.fn(async () => ({
    id: "PRO-0",
    title: "Mock",
    path: "PRO-0_mock",
    absolutePath: "/tmp/PRO-0_mock",
    frontmatter: {},
    content: "",
  })),
  updateProject: vi.fn(async () => ({
    id: "PRO-0",
    title: "Mock",
    path: "PRO-0_mock",
    absolutePath: "/tmp/PRO-0_mock",
    frontmatter: {},
    content: "",
  })),
  createProject: vi.fn(async () => ({
    ok: true,
    data: {
      id: "PRO-0",
      title: "Test Project",
      path: "PRO-0_test",
      absolutePath: "/tmp/PRO-0_test",
      frontmatter: {},
      content: "",
    },
  })),
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
  subscribeToFileChanges: vi.fn(
    (callbacks: {
      onFileChanged?: (projectId: string, file: string) => void;
      onAgentChanged?: (projectId: string) => void;
      onError?: (error: string) => void;
    }) => {
      fileChangeCallbacks = callbacks;
      return () => {
        fileChangeCallbacks = undefined;
      };
    }
  ),
  uploadAttachments: vi.fn(async () => ({ ok: true, data: [] })),
}));

vi.mock("./AgentSidebar", () => ({ AgentSidebar: () => null }));
vi.mock("./ContextPanel", () => ({ ContextPanel: () => null }));
vi.mock("./ActivityFeed", () => ({ ActivityFeed: () => null }));

vi.mock("@solidjs/router", () => ({
  useSearchParams: () => [{}, () => {}],
  useNavigate: () => vi.fn(),
  A: (props: Record<string, unknown>) => <a {...props} />,
}));

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

describe("ProjectsBoard realtime refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delegateEvents(["click", "input", "keydown"]);
    setupMatchMedia();
    setupRaf();
    localStorage.clear();
    fileChangeCallbacks = undefined;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("refetches projects on non-README file_changed events", async () => {
    const api = await import("../api");
    const fetchProjects = vi.mocked(api.fetchProjects);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <ProjectsBoard />, container);

    await vi.runAllTimersAsync();

    const initialCalls = fetchProjects.mock.calls.length;
    expect(initialCalls).toBeGreaterThan(0);
    expect(fileChangeCallbacks?.onFileChanged).toBeTypeOf("function");

    fileChangeCallbacks?.onFileChanged?.(
      "PRO-153",
      "PRO-153_make_ui_update_in_real_time/SPECS.md"
    );

    await vi.advanceTimersByTimeAsync(499);
    expect(fetchProjects.mock.calls.length).toBe(initialCalls);

    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect(fetchProjects.mock.calls.length).toBe(initialCalls + 1);

    dispose();
  });

  it("does not subscribe to project realtime while detail view is active", async () => {
    const api = await import("../api");
    const fetchProjects = vi.mocked(api.fetchProjects);
    const subscribeToFileChanges = vi.mocked(api.subscribeToFileChanges);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => <ProjectsBoard suspendProjectRealtime />,
      container
    );

    await vi.runAllTimersAsync();

    expect(fetchProjects.mock.calls.length).toBeGreaterThan(0);
    expect(subscribeToFileChanges).not.toHaveBeenCalled();
    expect(fileChangeCallbacks).toBeUndefined();

    dispose();
  });
});
