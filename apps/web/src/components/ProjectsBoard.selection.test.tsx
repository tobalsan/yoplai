// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { within, waitFor } from "@testing-library/dom";
import { render } from "solid-js/web";
import { ProjectsBoard } from "./ProjectsBoard";
import { getSessionKey } from "../api/chat";

const { navigate } = vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  return { navigate: vi.fn() };
});

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    fetchProjects: vi.fn(async () => []),
    fetchAreas: vi.fn(async () => []),
    fetchAgents: vi.fn(async () => [{ id: "PRO-lead/one", name: "Lead One" }]),
    fetchAllSubagents: vi.fn(async () => ({ items: [] })),
    fetchAgentStatuses: vi.fn(async () => ({ statuses: {} })),
    fetchBoardActivity: vi.fn(async () => ({
      items: [
        {
          id: "message",
          type: "agent_message",
          actor: "Lead One",
          action: "said hello",
          timestamp: "2026-10-23T12:00:00Z",
          color: "green",
        },
        {
          id: "project-run",
          type: "run_start",
          actor: "Runner",
          action: "started project run",
          projectId: "PRO-1",
          runSlug: "run-a",
          timestamp: "2026-10-23T12:00:00Z",
          color: "blue",
        },
        {
          id: "bare-run",
          type: "run_start",
          actor: "Runner",
          action: "started bare run",
          projectId: "",
          runSlug: "run-a",
          timestamp: "2026-10-23T12:00:00Z",
          color: "blue",
        },
        {
          id: "unknown",
          type: "run_start",
          actor: "Runner",
          action: "started unknown run",
          projectId: "",
          runSlug: "PRO-unknown",
          timestamp: "2026-10-23T12:00:00Z",
          color: "blue",
        },
      ],
    })),
    subscribeToStatus: vi.fn(() => () => {}),
    subscribeToFileChanges: vi.fn(() => () => {}),
  };
});

vi.mock("../lib/capabilities", () => ({ isExtensionEnabled: () => true }));

vi.mock("@solidjs/router", () => ({
  useSearchParams: () => [{}, () => {}],
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: "/board" }),
  A: (props: Record<string, unknown>) => <a {...props} />,
}));

let dispose: (() => void) | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  navigate.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
  localStorage.clear();
});

describe("ProjectsBoard context panel navigation", () => {
  it("opens a directory agent's current session on the main chat page", async () => {
    localStorage.setItem("yoplai:sessionKey:PRO-lead/one", "existing-session");
    dispose = render(() => <ProjectsBoard withSidebar={false} />, container);
    await waitFor(() => {
      expect(
        within(container).getByRole("button", { name: /Lead One/ })
      ).toBeTruthy();
    });

    within(container)
      .getByRole("button", { name: /Lead One/ })
      .click();

    expect(navigate).toHaveBeenCalledWith("/chat/PRO-lead%2Fone");
    expect(getSessionKey("PRO-lead/one")).toBe("existing-session");
  });
  it("opens a Feed run's project using the existing project destination", async () => {
    localStorage.setItem("yoplai:context-panel:mode", "feed");
    dispose = render(() => <ProjectsBoard withSidebar={false} />, container);
    await waitFor(() => {
      expect(
        within(container).getByRole("button", { name: /started project run/ })
      ).toBeTruthy();
    });

    within(container)
      .getByRole("button", { name: /started project run/ })
      .click();

    expect(navigate).toHaveBeenCalledWith("/projects/PRO-1");
  });

  it("opens a Feed agent's current session on the main chat page", async () => {
    localStorage.setItem("yoplai:context-panel:mode", "feed");
    localStorage.setItem("yoplai:sessionKey:PRO-lead/one", "existing-session");
    dispose = render(() => <ProjectsBoard withSidebar={false} />, container);
    await waitFor(() => {
      expect(
        within(container).getByRole("button", { name: /Lead One said hello/ })
      ).toBeTruthy();
    });

    within(container)
      .getByRole("button", { name: /Lead One said hello/ })
      .click();

    expect(navigate).toHaveBeenCalledWith("/chat/PRO-lead%2Fone");
    expect(getSessionKey("PRO-lead/one")).toBe("existing-session");
  });

  it.each(["bare", "unknown"])(
    "does nothing for a Feed %s run without a project",
    async (kind) => {
      localStorage.setItem("yoplai:context-panel:mode", "feed");
      dispose = render(() => <ProjectsBoard withSidebar={false} />, container);
      const label =
        kind === "bare" ? /started bare run/ : /started unknown run/;
      await waitFor(() => {
        expect(
          within(container).getByRole("button", { name: label })
        ).toBeTruthy();
      });

      within(container).getByRole("button", { name: label }).click();

      expect(navigate).not.toHaveBeenCalled();
    }
  );

  it.each(["yoplai", "aihub"])(
    "ignores restored %s agent selection without navigating",
    async (prefix) => {
      localStorage.setItem(
        prefix + ":context-panel:selected-agent",
        "PRO-lead/one"
      );
      localStorage.setItem("yoplai:context-panel:mode", "chat");
      dispose = render(() => <ProjectsBoard withSidebar={false} />, container);
      await waitFor(() => {
        expect(
          within(container).getByRole("button", { name: /Lead One/ })
        ).toBeTruthy();
      });

      expect(navigate).not.toHaveBeenCalled();
      expect(
        within(container).queryByRole("button", { name: "Chat" })
      ).toBeNull();
    }
  );
});
