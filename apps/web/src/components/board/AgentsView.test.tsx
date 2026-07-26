// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { AgentsView } from "./AgentsView";
import type { SubagentRun } from "@yoplai/shared/types";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const {
  fetchBoardAgentsMock,
  killBoardAgentMock,
  subscribeToSubagentChangesMock,
} = vi.hoisted(() => ({
  fetchBoardAgentsMock: vi.fn(),
  killBoardAgentMock: vi.fn(),
  subscribeToSubagentChangesMock: vi.fn(),
}));

vi.mock("../../api", () => ({
  fetchBoardAgents: fetchBoardAgentsMock,
  killBoardAgent: killBoardAgentMock,
  subscribeToSubagentChanges: subscribeToSubagentChangesMock,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRun(
  overrides: Partial<SubagentRun> & { id: string }
): SubagentRun {
  const { id, ...rest } = overrides;
  return {
    id,
    label: "Worker",
    cli: "claude",
    cwd: "/tmp",
    prompt: "do the thing",
    status: "running",
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    archived: false,
    ...rest,
  } as SubagentRun;
}

let container: HTMLElement;
let dispose: () => void;

beforeEach(() => {
  fetchBoardAgentsMock.mockReset();
  killBoardAgentMock.mockReset();
  subscribeToSubagentChangesMock.mockReturnValue(() => undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  dispose?.();
  container.remove();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AgentsView — empty state", () => {
  it("renders empty state when no runs", async () => {
    fetchBoardAgentsMock.mockResolvedValue({ runs: [] });
    await new Promise<void>((resolve) => {
      dispose = render(() => <AgentsView />, container);
      setTimeout(resolve, 50);
    });
    expect(
      container.querySelector("[data-testid='agents-empty']")
    ).not.toBeNull();
  });
});

describe("AgentsView — grouping by project", () => {
  it("groups runs by projectId", async () => {
    fetchBoardAgentsMock.mockResolvedValue({
      runs: [
        makeRun({
          id: "sar_1",
          projectId: "PRO-238",
          sliceId: "PRO-238-S03",
          label: "Worker",
        }),
        makeRun({
          id: "sar_2",
          projectId: "PRO-201",
          sliceId: "PRO-201-S01",
          label: "Reviewer",
        }),
        makeRun({
          id: "sar_3",
          projectId: "PRO-238",
          sliceId: "PRO-238-S04",
          label: "Worker",
        }),
      ],
    });
    await new Promise<void>((resolve) => {
      dispose = render(() => <AgentsView />, container);
      setTimeout(resolve, 50);
    });
    // Two groups: PRO-238 and PRO-201
    const groups = container.querySelectorAll("[data-testid^='group-']");
    expect(groups.length).toBe(2);
    const groupIds = Array.from(groups).map((g) =>
      g.getAttribute("data-testid")
    );
    expect(groupIds).toContain("group-PRO-238");
    expect(groupIds).toContain("group-PRO-201");
  });

  it("groups run without projectId under __unassigned", async () => {
    fetchBoardAgentsMock.mockResolvedValue({
      runs: [makeRun({ id: "sar_noproj", label: "Manual" })],
    });
    await new Promise<void>((resolve) => {
      dispose = render(() => <AgentsView />, container);
      setTimeout(resolve, 50);
    });
    const group = container.querySelector("[data-testid='group-__unassigned']");
    expect(group).not.toBeNull();
  });

  it("shows no-slice badge for runs without sliceId", async () => {
    fetchBoardAgentsMock.mockResolvedValue({
      runs: [
        makeRun({ id: "sar_noslice", projectId: "PRO-5" }),
        // no sliceId
      ],
    });
    await new Promise<void>((resolve) => {
      dispose = render(() => <AgentsView />, container);
      setTimeout(resolve, 50);
    });
    const badge = container.querySelector(".agents-no-slice-badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("no-slice");
  });

  it("shows sliceId for runs with sliceId", async () => {
    fetchBoardAgentsMock.mockResolvedValue({
      runs: [
        makeRun({ id: "sar_slice", projectId: "PRO-6", sliceId: "PRO-6-S02" }),
      ],
    });
    await new Promise<void>((resolve) => {
      dispose = render(() => <AgentsView />, container);
      setTimeout(resolve, 50);
    });
    const badge = container.querySelector(".agents-no-slice-badge");
    expect(badge).toBeNull();
    expect(container.querySelector(".agents-run-slice")?.textContent).toBe(
      "PRO-6-S02"
    );
  });
});

describe("AgentsView — kill flow", () => {
  it("opens confirmation dialog when kill button clicked", async () => {
    fetchBoardAgentsMock.mockResolvedValue({
      runs: [
        makeRun({
          id: "sar_kill_test",
          projectId: "PRO-7",
          sliceId: "PRO-7-S01",
          label: "Worker",
        }),
      ],
    });
    await new Promise<void>((resolve) => {
      dispose = render(() => <AgentsView />, container);
      setTimeout(resolve, 50);
    });

    const killBtn = container.querySelector(
      ".agents-btn-kill"
    ) as HTMLButtonElement;
    expect(killBtn).not.toBeNull();
    killBtn.click();

    await Promise.resolve();
    const dialog = container.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Worker");
    expect(dialog?.textContent).toContain("PRO-7-S01");
  });

  it("calls killBoardAgent and refreshes on confirm", async () => {
    fetchBoardAgentsMock
      .mockResolvedValueOnce({
        runs: [
          makeRun({
            id: "sar_kill_confirm",
            projectId: "PRO-8",
            sliceId: "PRO-8-S01",
            label: "Worker",
          }),
        ],
      })
      .mockResolvedValue({ runs: [] });
    killBoardAgentMock.mockResolvedValue({
      ok: true,
      runId: "sar_kill_confirm",
      status: "interrupted",
    });

    await new Promise<void>((resolve) => {
      dispose = render(() => <AgentsView />, container);
      setTimeout(resolve, 50);
    });

    // Click kill
    const killBtn = container.querySelector(
      ".agents-btn-kill"
    ) as HTMLButtonElement;
    killBtn.click();
    await Promise.resolve();

    // Confirm
    const confirmBtn = container.querySelector(
      ".agents-kill-btn-confirm"
    ) as HTMLButtonElement;
    expect(confirmBtn).not.toBeNull();
    confirmBtn.click();

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(killBoardAgentMock).toHaveBeenCalledWith("sar_kill_confirm");
    // After kill + refresh, empty state shown
    expect(
      container.querySelector("[data-testid='agents-empty']")
    ).not.toBeNull();
  });

  it("cancels dialog without killing when cancel clicked", async () => {
    fetchBoardAgentsMock.mockResolvedValue({
      runs: [makeRun({ id: "sar_cancel_test", projectId: "PRO-9" })],
    });

    await new Promise<void>((resolve) => {
      dispose = render(() => <AgentsView />, container);
      setTimeout(resolve, 50);
    });

    const killBtn = container.querySelector(
      ".agents-btn-kill"
    ) as HTMLButtonElement;
    killBtn.click();
    await Promise.resolve();

    const cancelBtn = container.querySelector(
      ".agents-kill-btn-cancel"
    ) as HTMLButtonElement;
    cancelBtn.click();
    await Promise.resolve();

    expect(killBoardAgentMock).not.toHaveBeenCalled();
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });
});
