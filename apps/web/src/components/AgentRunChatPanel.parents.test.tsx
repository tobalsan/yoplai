// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/dom";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { SubagentRun } from "@yoplai/shared/types";
import type { SliceRecord } from "../api/types";
import { SliceDetailPage } from "./SliceDetailPage";
import { BoardProjectDetailPage } from "./board/BoardProjectDetailPage";
import { fetchRuntimeSubagents, resumeRuntimeSubagent } from "../api";

const [query, setQuery] = createSignal<Record<string, string | undefined>>({});
const searchParams = new Proxy(
  {},
  {
    get: (_target, key: string) => query()[key],
  }
);
const navigate = vi.fn((to: string) => {
  const url = new URL(to, "http://localhost");
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  setQuery(Object.fromEntries(url.searchParams.entries()));
});

vi.mock("@solidjs/router", () => ({
  useParams: () => ({
    projectId: "PRO-1",
    get sliceId() {
      return window.location.pathname.includes("/slices/")
        ? "PRO-1-S01"
        : undefined;
    },
  }),
  useSearchParams: () => [searchParams, vi.fn()],
  useNavigate: () => navigate,
}));

const slice: SliceRecord = {
  id: "PRO-1-S01",
  projectId: "PRO-1",
  dirPath: "/tmp/PRO-1/slices/PRO-1-S01",
  frontmatter: {
    id: "PRO-1-S01",
    project_id: "PRO-1",
    title: "Ship slice",
    status: "in_progress",
    hill_position: "executing",
    created_at: "2026-05-13T10:00:00Z",
    updated_at: "2026-05-13T10:00:00Z",
  },
  docs: { readme: "", specs: "", tasks: "", validation: "", thread: "" },
};
let followUpCompleted = false;

vi.mock("../api", () => ({
  fetchSlice: vi.fn(async () => slice),
  fetchSlices: vi.fn(async () => [slice]),
  fetchSubagents: vi.fn(async () => ({ ok: true, data: { items: [] } })),
  fetchProject: vi.fn(async () => ({
    id: "PRO-1",
    title: "Ship project",
    path: "PRO-1_ship-project",
    absolutePath: "/tmp/PRO-1",
    repoValid: true,
    frontmatter: { status: "shaping" },
    docs: { PITCH: "Pitch" },
    thread: [],
  })),
  fetchAreas: vi.fn(async () => []),
  fetchRuntimeSubagents: vi.fn(),
  fetchRuntimeSubagentLogs: vi.fn(async (id: string) => ({
    events: [
      {
        type: "assistant",
        text: followUpCompleted
          ? "**Follow-up complete**"
          : id === "slice-new"
            ? "**Slice transcript**"
            : id === "project-new"
              ? "**Project transcript**"
              : "**Earlier transcript**",
      },
    ],
    cursor: 1,
  })),
  resumeRuntimeSubagent: vi.fn(async (id: string) => {
    followUpCompleted = true;
    return { ok: true, data: run(id, "Resumed worker") };
  }),
  subscribeToFileChanges: vi.fn(() => () => {}),
  subscribeToSubagentChanges: vi.fn(() => () => {}),
}));

vi.mock("./board/DocEditor", () => ({
  DocEditor: () => <div>Document editor</div>,
}));

function run(id: string, label: string, sliceId?: string): SubagentRun {
  return {
    id,
    label,
    projectId: "PRO-1",
    sliceId,
    cli: "pi",
    cwd: "/tmp/PRO-1",
    prompt: "Check the project",
    status: "done",
    startedAt: id.endsWith("new")
      ? "2026-05-13T10:02:00Z"
      : "2026-05-13T10:00:00Z",
  };
}

let container: HTMLDivElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  followUpCompleted = false;
  setQuery({ tab: "agent", lead: "old-lead" });
  window.history.replaceState(
    null,
    "",
    "/projects/PRO-1/slices/PRO-1-S01?tab=agent&lead=old-lead"
  );
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
});

function sendFollowUp(content: string) {
  const ui = within(container);
  const input = ui.getByRole<HTMLTextAreaElement>("textbox");
  input.value = content;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  ui.getByRole("button", { name: "Send message" }).click();
}

describe("agent runs through their real parent pages", () => {
  it("ignores an old lead query in the slice and resumes its fallback run", async () => {
    vi.mocked(fetchRuntimeSubagents).mockResolvedValue({
      items: [
        run("slice-old", "Earlier slice worker", "PRO-1-S01"),
        run("slice-new", "Slice worker", "PRO-1-S01"),
      ],
    });
    dispose = render(() => <SliceDetailPage />, container);
    const ui = within(container);
    await vi.waitFor(() =>
      expect(ui.getByRole("button", { name: /Slice worker/ })).toBeTruthy()
    );
    expect(ui.queryByRole("button", { name: "+ New session" })).toBeNull();
    expect(ui.queryByText("Lead chats")).toBeNull();
    expect(ui.getByText("Slice transcript")).toBeTruthy();
    expect(window.location.search).toBe("?tab=agent&run=slice-new");

    sendFollowUp("Continue this slice");
    await vi.waitFor(() =>
      expect(ui.getByText("Follow-up complete")).toBeTruthy()
    );
    expect(resumeRuntimeSubagent).toHaveBeenCalledWith(
      "slice-new",
      "Continue this slice"
    );

    vi.mocked(resumeRuntimeSubagent).mockResolvedValueOnce({
      ok: false,
      error: "Runner unavailable",
    });
    sendFollowUp("Retry this slice");
    await vi.waitFor(() =>
      expect(ui.getByText("Runner unavailable")).toBeTruthy()
    );
    expect(ui.getByText("Retry this slice")).toBeTruthy();
    expect(ui.getByText("Follow-up complete")).toBeTruthy();
  });

  it("ignores an old lead query in the project and resumes its shaping run", async () => {
    window.history.replaceState(
      null,
      "",
      "/board/projects/PRO-1?tab=agent&lead=old-lead"
    );
    vi.mocked(fetchRuntimeSubagents).mockResolvedValue({
      items: [
        run("project-old", "Earlier project worker"),
        run("project-new", "Project worker"),
        run("slice-new", "Slice worker", "PRO-1-S01"),
      ],
    });
    dispose = render(() => <BoardProjectDetailPage />, container);
    const ui = within(container);
    await vi.waitFor(() =>
      expect(ui.getByRole("button", { name: /Project worker/ })).toBeTruthy()
    );
    expect(ui.queryByRole("button", { name: "+ New session" })).toBeNull();
    expect(ui.queryByText("Lead chats")).toBeNull();
    expect(ui.queryByRole("button", { name: /Slice worker/ })).toBeNull();
    expect(ui.getByText("Project transcript")).toBeTruthy();
    expect(window.location.search).toBe("?tab=agent&run=project-new");

    sendFollowUp("Continue this project");
    await vi.waitFor(() =>
      expect(ui.getByText("Follow-up complete")).toBeTruthy()
    );
    expect(resumeRuntimeSubagent).toHaveBeenCalledWith(
      "project-new",
      "Continue this project"
    );

    vi.mocked(resumeRuntimeSubagent).mockResolvedValueOnce({
      ok: false,
      error: "Project runner unavailable",
    });
    sendFollowUp("Retry this project");
    await vi.waitFor(() =>
      expect(ui.getByText("Project runner unavailable")).toBeTruthy()
    );
    expect(ui.getByText("Retry this project")).toBeTruthy();
    expect(ui.getByText("Follow-up complete")).toBeTruthy();
  });

  it("keeps a slice run deep link instead of selecting the newest run", async () => {
    setQuery({ tab: "agent", lead: "old-lead", run: "slice-old" });
    vi.mocked(fetchRuntimeSubagents).mockResolvedValue({
      items: [
        run("slice-old", "Earlier slice worker", "PRO-1-S01"),
        run("slice-new", "Slice worker", "PRO-1-S01"),
      ],
    });
    dispose = render(() => <SliceDetailPage />, container);
    const ui = within(container);
    await vi.waitFor(() =>
      expect(ui.getByText("Earlier transcript")).toBeTruthy()
    );
    expect(ui.queryByText("Slice transcript")).toBeNull();
    sendFollowUp("Continue the linked slice run");
    await vi.waitFor(() =>
      expect(ui.getByText("Follow-up complete")).toBeTruthy()
    );
    expect(resumeRuntimeSubagent).toHaveBeenCalledWith(
      "slice-old",
      "Continue the linked slice run"
    );
    expect(fetchRuntimeSubagents).toHaveBeenCalledWith({
      projectId: "PRO-1",
      sliceId: "PRO-1-S01",
      includeArchived: true,
    });
  });

  it("keeps a project run deep link instead of selecting the newest run", async () => {
    window.history.replaceState(
      null,
      "",
      "/board/projects/PRO-1?tab=agent&run=project-old&lead=old-lead"
    );
    setQuery({ tab: "agent", lead: "old-lead", run: "project-old" });
    vi.mocked(fetchRuntimeSubagents).mockResolvedValue({
      items: [
        run("project-old", "Earlier project worker"),
        run("project-new", "Project worker"),
      ],
    });
    dispose = render(() => <BoardProjectDetailPage />, container);
    const ui = within(container);
    await vi.waitFor(() =>
      expect(ui.getByText("Earlier transcript")).toBeTruthy()
    );
    expect(ui.queryByText("Project transcript")).toBeNull();
    sendFollowUp("Continue the linked project run");
    await vi.waitFor(() =>
      expect(ui.getByText("Follow-up complete")).toBeTruthy()
    );
    expect(resumeRuntimeSubagent).toHaveBeenCalledWith(
      "project-old",
      "Continue the linked project run"
    );
  });
});
