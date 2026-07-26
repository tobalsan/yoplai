// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { SliceDetailPage } from "./SliceDetailPage";
import type { SliceRecord, SubagentListItem } from "../api/types";
import { updateSlice } from "../api";

const navigateMock = vi.fn();
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
) as Record<string, string | undefined>;

const MOCK_SLICE: SliceRecord = {
  id: "PRO-1-S01",
  projectId: "PRO-1",
  dirPath: "/tmp/PRO-1/slices/PRO-1-S01",
  frontmatter: {
    id: "PRO-1-S01",
    project_id: "PRO-1",
    title: "Auth flow",
    status: "in_progress",
    hill_position: "executing",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  },
  docs: {
    readme: "## Must\n- login\n\n## Nice\n- ~2FA",
    specs: "# Specs\nImplement OAuth login.",
    tasks: "- [ ] Implement login\n- [x] DB schema",
    validation: "- [ ] Login works end-to-end\n",
    thread:
      "## 2026-01-02T00:00:00.000Z\n\nWorker: **Done** with [auth](https://example.com).\n\n<script>alert(1)</script>\n",
  },
};

let fetchSliceMock: ReturnType<typeof vi.fn>;
let fetchSlicesMock: ReturnType<typeof vi.fn>;
let fetchSubagentsMock: ReturnType<typeof vi.fn>;
let interruptSubagentMock: ReturnType<typeof vi.fn>;
let dateNowSpy: { mockRestore: () => void };
let fileChangeCallbacks:
  | {
      onAgentChanged?: (projectId: string) => void;
      onFileChanged?: (projectId: string) => void;
    }
  | undefined;

vi.mock("../api", () => ({
  fetchSlices: (...args: unknown[]) => fetchSlicesMock(...args),
  fetchSlice: (...args: unknown[]) => fetchSliceMock(...args),
  updateSlice: vi.fn(async () => MOCK_SLICE),
  interruptSubagent: (...args: unknown[]) => interruptSubagentMock(...args),
  subscribeToFileChanges: vi.fn((callbacks) => {
    fileChangeCallbacks = callbacks;
    return () => {};
  }),
  subscribeToSubagentChanges: vi.fn(() => () => {}),
  fetchSubagents: (...args: unknown[]) => fetchSubagentsMock(...args),
}));

vi.mock("@solidjs/router", () => ({
  useNavigate: () => navigateMock,
  useParams: () => ({ projectId: "PRO-1", sliceId: "PRO-1-S01" }),
  useSearchParams: () => [searchParamsProxy, vi.fn()],
}));

vi.mock("./board/DocEditor", () => ({
  DocEditor: (props: {
    docKey: string;
    content: string;
    onSave: (content: string) => void;
  }) => (
    <div
      data-testid="doc-editor"
      data-dockey={props.docKey}
      data-content={props.content}
    >
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

vi.mock("./AgentRunChatPanel", () => ({
  AgentRunChatPanel: (props: {
    projectId?: string;
    sliceId?: string;
    selectedRunId?: string;
    onSelectedRunIdChange?: (runId: string | undefined) => void;
  }) => (
    <div
      data-testid="agent-run-chat-panel"
      data-project-id={props.projectId}
      data-slice-id={props.sliceId}
      data-selected-run-id={props.selectedRunId}
    >
      <button type="button" onClick={() => props.onSelectedRunIdChange?.("run-1")}>
        Select run
      </button>
    </div>
  ),
}));

let container: HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  setSearchParamsSignal({});
  window.history.replaceState(null, "", "/projects/PRO-1/slices/PRO-1-S01");
  navigateMock.mockImplementation((to: string) => {
    const url = new URL(to, "http://localhost");
    window.history.pushState(null, "", `${url.pathname}${url.search}`);
    setSearchParamsSignal(Object.fromEntries(url.searchParams.entries()));
  });
  dateNowSpy = vi
    .spyOn(Date, "now")
    .mockReturnValue(new Date("2026-01-02T00:05:00.000Z").getTime());
  container = document.createElement("div");
  document.body.appendChild(container);
  fetchSliceMock = vi.fn(async () => MOCK_SLICE);
  fetchSlicesMock = vi.fn(async () => [MOCK_SLICE]);
  fetchSubagentsMock = vi.fn(async () => ({
    ok: true as const,
    data: { items: [] as SubagentListItem[] },
  }));
  interruptSubagentMock = vi.fn(async () => ({
    ok: true as const,
    data: { slug: "worker" },
  }));
  fileChangeCallbacks = undefined;
});

afterEach(() => {
  dateNowSpy.mockRestore();
  document.body.removeChild(container);
});

describe("SliceDetailPage", () => {
  it("renders slice title and ID in breadcrumb", async () => {
    render(() => <SliceDetailPage />, container);
    await vi.waitFor(() => {
      expect(container.querySelector(".slice-detail-id")).not.toBeNull();
    });
    expect(container.querySelector(".slice-detail-id")?.textContent).toBe(
      "PRO-1-S01"
    );
    expect(
      container.querySelector(".slice-detail-title-crumb")?.textContent
    ).toBe("Auth flow");
  });

  it("renders status pill with current status", async () => {
    render(() => <SliceDetailPage />, container);
    await vi.waitFor(() => {
      expect(
        container.querySelector(".slice-detail-status-pill")
      ).not.toBeNull();
    });
    expect(
      container.querySelector(".slice-detail-status-pill")?.textContent
    ).toBe("In Progress");
  });

  it("renders frontmatter metadata in sidebar", async () => {
    render(() => <SliceDetailPage />, container);
    await vi.waitFor(() => {
      expect(container.querySelector(".slice-detail-sidebar")).not.toBeNull();
    });
    const sidebar = container.querySelector(".slice-detail-sidebar")!;
    expect(sidebar.textContent).toContain("executing"); // hill_position
  });

  it("renders blockers list with count and statuses", async () => {
    fetchSliceMock = vi.fn(async () => ({
      ...MOCK_SLICE,
      frontmatter: {
        ...MOCK_SLICE.frontmatter,
        blocked_by: ["PRO-1-S02", "PRO-1-S03"],
      },
    }));
    fetchSlicesMock = vi.fn(async () => [
      MOCK_SLICE,
      {
        ...MOCK_SLICE,
        id: "PRO-1-S02",
        frontmatter: {
          ...MOCK_SLICE.frontmatter,
          id: "PRO-1-S02",
          title: "Database schema",
          status: "review",
        },
      },
      {
        ...MOCK_SLICE,
        id: "PRO-1-S03",
        frontmatter: {
          ...MOCK_SLICE.frontmatter,
          id: "PRO-1-S03",
          title: "OAuth provider",
          status: "done",
        },
      },
    ]);

    render(() => <SliceDetailPage />, container);
    await vi.waitFor(() => {
      expect(
        container.querySelectorAll(".slice-detail-blocker-row").length
      ).toBe(2);
    });

    const blockers = container.querySelector(".slice-detail-blockers")!;
    expect(blockers.textContent).toContain("Blockers (2)");
    expect(blockers.textContent).toContain("PRO-1-S02");
    expect(blockers.textContent).toContain("Review");
    expect(blockers.textContent).toContain("Database schema");
    expect(blockers.textContent).toContain("PRO-1-S03");
    expect(blockers.textContent).toContain("Done");
    expect(blockers.textContent).toContain("OAuth provider");
  });

  it("hides blockers section when blocked_by is empty", async () => {
    fetchSliceMock = vi.fn(async () => ({
      ...MOCK_SLICE,
      frontmatter: { ...MOCK_SLICE.frontmatter, blocked_by: [] },
    }));

    render(() => <SliceDetailPage />, container);
    await vi.waitFor(() => {
      expect(container.querySelector(".slice-detail-sidebar")).not.toBeNull();
    });

    expect(container.querySelector(".slice-detail-blockers")).toBeNull();
    expect(
      container.querySelector(".slice-detail-sidebar")?.textContent
    ).not.toContain("Blockers");
  });

  it("renders Specs tab content by default", async () => {
    render(() => <SliceDetailPage />, container);
    await vi.waitFor(() => {
      expect(
        container.querySelector(".slice-detail-tab-content")
      ).not.toBeNull();
    });
    const tabs = container.querySelectorAll(".slice-detail-tab-btn");
    expect(tabs.length).toBe(5);
    expect(tabs[0]?.textContent).toBe("Specs");
    expect(tabs[0]?.classList.contains("active")).toBe(true);
    const editor = container.querySelector("[data-testid='doc-editor']");
    expect(editor?.getAttribute("data-dockey")).toBe("SPECS");
    expect(editor?.getAttribute("data-content")).toContain(
      "Implement OAuth login."
    );
    expect(container.textContent).not.toContain("README");
  });

  it("switches to tasks tab and shows editable document", async () => {
    render(() => <SliceDetailPage />, container);
    await vi.waitFor(() => {
      const tabs = container.querySelectorAll(".slice-detail-tab-btn");
      expect(tabs.length).toBe(5);
    });
    const tabs = container.querySelectorAll(".slice-detail-tab-btn");
    // Tab order: specs, tasks, validation, thread, agent
    const tasksTab = tabs[1] as HTMLElement;
    tasksTab.click();
    await vi.waitFor(() => {
      expect(
        container.querySelector("[data-testid='doc-editor']")
      ).not.toBeNull();
    });
    const editor = container.querySelector("[data-testid='doc-editor']");
    expect(editor?.getAttribute("data-dockey")).toBe("TASKS");
    expect(editor?.getAttribute("data-content")).toContain("Implement login");
  });

  it("switches to specs tab and shows editable document", async () => {
    render(() => <SliceDetailPage />, container);
    await vi.waitFor(() => {
      const tabs = container.querySelectorAll(".slice-detail-tab-btn");
      expect(tabs.length).toBe(5);
    });
    const specsTab = container.querySelectorAll(
      ".slice-detail-tab-btn"
    )[0] as HTMLElement;
    specsTab.click();
    await vi.waitFor(() => {
      expect(
        container.querySelector("[data-testid='doc-editor']")
      ).not.toBeNull();
    });
    const editor = container.querySelector("[data-testid='doc-editor']");
    expect(editor?.getAttribute("data-dockey")).toBe("SPECS");
    expect(editor?.getAttribute("data-content")).toContain(
      "Implement OAuth login."
    );
  });

  it("renders thread entries as markdown comment cards safely", async () => {
    render(() => <SliceDetailPage />, container);
    await vi.waitFor(() => {
      const tabs = container.querySelectorAll(".slice-detail-tab-btn");
      expect(tabs.length).toBe(5);
    });

    const tabs = container.querySelectorAll(".slice-detail-tab-btn");
    (tabs[3] as HTMLElement).click();

    await vi.waitFor(() => {
      expect(
        container.querySelector(".slice-detail-thread-card")
      ).not.toBeNull();
    });

    const card = container.querySelector(
      ".slice-detail-thread-card"
    ) as HTMLElement;
    expect(card.querySelector(".slice-detail-thread-author")?.textContent).toBe(
      "Yoplai"
    );
    expect(card.querySelector(".slice-detail-thread-date")?.textContent).toBe(
      "5m ago"
    );

    const body = card.querySelector(
      ".slice-detail-thread-markdown"
    ) as HTMLElement;
    expect(body.textContent).toContain("Worker: Done with auth.");
    expect(body.innerHTML).toContain("<strong>Done</strong>");
    expect(body.innerHTML).not.toContain("<script>");
    const link = body.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders empty thread placeholder", async () => {
    fetchSliceMock = vi.fn(async () => ({
      ...MOCK_SLICE,
      docs: { ...MOCK_SLICE.docs, thread: "" },
    }));

    render(() => <SliceDetailPage />, container);
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".slice-detail-tab-btn").length).toBe(
        5
      );
    });

    const tabs = container.querySelectorAll(".slice-detail-tab-btn");
    (tabs[3] as HTMLElement).click();

    await vi.waitFor(() => {
      expect(container.querySelector(".slice-detail-empty")?.textContent).toBe(
        "No thread entries yet."
      );
    });
  });

  it("renders recent runs timestamps only when available", async () => {
    fetchSubagentsMock = vi.fn(async () => ({
      ok: true as const,
      data: {
        items: [
          {
            slug: "worker",
            name: "Worker",
            status: "replied",
            sliceId: "PRO-1-S01",
            lastActive: "2026-01-02T00:02:00.000Z",
          },
          {
            slug: "reviewer",
            name: "Reviewer",
            status: "running",
            sliceId: "PRO-1-S01",
            startedAt: "2026-01-01T22:05:00.000Z",
          },
          {
            slug: "untimed",
            name: "Untimed",
            status: "error",
            sliceId: "PRO-1-S01",
          },
          {
            slug: "other-slice",
            name: "Other Slice",
            status: "replied",
            sliceId: "PRO-1-S02",
            lastActive: "2026-01-02T00:04:00.000Z",
          },
        ] satisfies SubagentListItem[],
      },
    }));

    render(() => <SliceDetailPage />, container);
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".slice-detail-run-row").length).toBe(
        3
      );
    });

    const rows = Array.from(
      container.querySelectorAll(".slice-detail-run-row")
    );
    expect(rows[0]?.textContent).toContain("Reviewer");
    expect(rows[0]?.querySelector(".slice-detail-run-time")?.textContent).toBe(
      "2h ago"
    );
    expect(rows[1]?.textContent).toContain("Worker");
    expect(rows[1]?.querySelector(".slice-detail-run-time")?.textContent).toBe(
      "3m ago"
    );
    expect(rows[2]?.textContent).toContain("Untimed");
    expect(rows[2]?.querySelector(".slice-detail-run-time")).toBeNull();
    expect(container.textContent).not.toContain("Other Slice");
  });

  it("renders the agent tab with the scoped session chat panel", async () => {
    fetchSubagentsMock = vi.fn(async () => ({
      ok: true as const,
      data: {
        items: [
          {
            slug: "worker",
            name: "Worker",
            status: "running",
            sliceId: "PRO-1-S01",
            startedAt: "2026-01-02T00:03:00.000Z",
            baseBranch: "main",
          },
          {
            slug: "other-slice",
            name: "Other Slice",
            status: "replied",
            sliceId: "PRO-1-S02",
            startedAt: "2026-01-02T00:04:00.000Z",
          },
        ] satisfies SubagentListItem[],
      },
    }));

    render(() => <SliceDetailPage />, container);
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".slice-detail-tab-btn").length).toBe(
        5
      );
    });
    const agentTab = container.querySelectorAll(
      ".slice-detail-tab-btn"
    )[4] as HTMLElement;
    agentTab.click();

    await vi.waitFor(() => {
      expect(
        container.querySelector("[data-testid='agent-run-chat-panel']")
      ).not.toBeNull();
    });
    const panel = container.querySelector(
      "[data-testid='agent-run-chat-panel']"
    ) as HTMLElement;
    expect(panel.getAttribute("data-project-id")).toBe("PRO-1");
    expect(panel.getAttribute("data-slice-id")).toBe("PRO-1-S01");
    expect(panel.textContent).not.toContain("View raw JSON");
  });

  it("refreshes agent runs when project agent state changes", async () => {
    fetchSubagentsMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, data: { items: [] } })
      .mockResolvedValue({
        ok: true as const,
        data: {
          items: [
            {
              slug: "worker",
              status: "running",
              sliceId: "PRO-1-S01",
            },
          ] satisfies SubagentListItem[],
        },
      });

    render(() => <SliceDetailPage />, container);
    await vi.waitFor(() => {
      expect(fileChangeCallbacks).toBeDefined();
    });
    fileChangeCallbacks?.onAgentChanged?.("PRO-1");

    await vi.waitFor(() => {
      expect(fetchSubagentsMock).toHaveBeenCalledTimes(2);
    });
  });

  it("saves each editable document tab through updateSlice", async () => {
    render(() => <SliceDetailPage />, container);
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".slice-detail-tab-btn").length).toBe(
        5
      );
    });

    const tabs = Array.from(
      container.querySelectorAll(".slice-detail-tab-btn")
    ) as HTMLElement[];
    const cases = [
      { tab: tabs[0], key: "SPECS", payload: { specs: "saved:SPECS" } },
      { tab: tabs[1], key: "TASKS", payload: { tasks: "saved:TASKS" } },
      {
        tab: tabs[2],
        key: "VALIDATION",
        payload: { validation: "saved:VALIDATION" },
      },
    ];

    for (const item of cases) {
      item.tab.click();
      await vi.waitFor(() => {
        expect(
          container
            .querySelector("[data-testid='doc-editor']")
            ?.getAttribute("data-dockey")
        ).toBe(item.key);
      });
      const button = container.querySelector(
        `[data-testid='save-doc-${item.key}']`
      ) as HTMLButtonElement;
      button.click();
      await vi.waitFor(() => {
        expect(updateSlice).toHaveBeenCalledWith(
          "PRO-1",
          "PRO-1-S01",
          item.payload
        );
      });
    }
  });

  it("activates slice tabs from the URL and updates the URL on tab click", async () => {
    window.history.replaceState(
      null,
      "",
      "/board/projects/PRO-1/slices/PRO-1-S01?tab=tasks"
    );
    setSearchParamsSignal({ tab: "tasks" });

    render(() => <SliceDetailPage />, container);
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='doc-editor']")
          ?.getAttribute("data-dockey")
      ).toBe("TASKS");
    });

    const validationTab = Array.from(
      container.querySelectorAll(".slice-detail-tab-btn")
    ).find((tab) => tab.textContent?.trim() === "Validation") as HTMLElement;
    validationTab.click();

    await vi.waitFor(() => {
      expect(window.location.pathname + window.location.search).toBe(
        "/board/projects/PRO-1/slices/PRO-1-S01?tab=validation"
      );
    });
  });

  it("keeps embedded board slice tabs on board routes", async () => {
    window.history.replaceState(null, "", "/projects/PRO-1");

    render(
      () => (
        <SliceDetailPage
          projectId="PRO-1"
          sliceId="PRO-1-S01"
          routeBase="board"
        />
      ),
      container
    );

    await vi.waitFor(() => {
      expect(
        container.querySelector("[data-testid='doc-editor']")
      ).not.toBeNull();
    });

    const tasksTab = Array.from(
      container.querySelectorAll(".slice-detail-tab-btn")
    ).find((tab) => tab.textContent?.trim() === "Tasks") as HTMLElement;
    tasksTab.click();

    await vi.waitFor(() => {
      expect(window.location.pathname + window.location.search).toBe(
        "/board/projects/PRO-1/slices/PRO-1-S01?tab=tasks"
      );
    });
  });
});
