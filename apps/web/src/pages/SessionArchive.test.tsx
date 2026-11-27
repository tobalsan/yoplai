// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const {
  fetchAgentSessionsMock,
  archiveAgentSessionMock,
  deleteAgentSessionMock,
  navigateMock,
  showToastMock,
} = vi.hoisted(() => ({
  fetchAgentSessionsMock: vi.fn(),
  archiveAgentSessionMock: vi.fn(),
  deleteAgentSessionMock: vi.fn(),
  navigateMock: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock("../api", () => ({
  fetchAgentSessions: fetchAgentSessionsMock,
  archiveAgentSession: archiveAgentSessionMock,
  deleteAgentSession: deleteAgentSessionMock,
}));

vi.mock("@solidjs/router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("../components/LeftNavShell", () => ({
  LeftNavShell: (props: { children: unknown }) => props.children,
}));

vi.mock("../lib/toast", () => ({
  showToast: showToastMock,
}));

import { SessionArchive } from "./SessionArchive";
import { defaultAvatarUrl } from "../lib/default-avatar";
import { defaultAvatarSources } from "../lib/default-avatar.fixture";

let root: HTMLDivElement;
let dispose: () => void;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  fetchAgentSessionsMock.mockReset();
  archiveAgentSessionMock.mockReset();
  deleteAgentSessionMock.mockReset();
  navigateMock.mockReset();
  showToastMock.mockReset();
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  dispose?.();
  root.remove();
});

describe("SessionArchive", () => {
  it("renders list from mocked fetchAgentSessions filtering archived sessions", async () => {
    fetchAgentSessionsMock.mockResolvedValue({
      items: [
        {
          agentId: "alpha",
          sessionId: "s1",
          createdAt: Date.now() - 86400000,
          lastActivity: Date.now() - 3600000,
          messageCount: 5,
          firstUserMessage: "Archived chat",
          archived: Date.now() - 3600000,
          isMain: false,
          pinned: null,
        },
        {
          agentId: "beta",
          sessionId: "s2",
          createdAt: Date.now(),
          lastActivity: Date.now(),
          messageCount: 2,
          firstUserMessage: "Another archived",
          archived: Date.now() - 7200000,
          isMain: false,
          pinned: null,
        },
      ],
    });
    dispose = render(() => <SessionArchive />, root);
    await tick();
    expect(fetchAgentSessionsMock).toHaveBeenCalledWith({ includeArchived: true });
    expect(root.textContent).toContain("Archived chat");
    expect(root.textContent).toContain("Another archived");
    expect(root.textContent).toContain("alpha");
    expect(root.textContent).toContain("beta");
  });

  it("shows the default avatar for an archived chat whose agent has no avatar", async () => {
    fetchAgentSessionsMock.mockResolvedValue({
      items: [{ agentId: "alpha", sessionId: "s1", createdAt: Date.now(), lastActivity: Date.now(), messageCount: 1, firstUserMessage: "Archived chat", archived: Date.now(), isMain: false, pinned: null }],
    });
    dispose = render(() => <SessionArchive />, root);
    await tick();
    expect(defaultAvatarSources(root)).toContain(defaultAvatarUrl("alpha"));
  });

  it("shows empty state when no archived chats", async () => {
    fetchAgentSessionsMock.mockResolvedValue({ items: [] });
    dispose = render(() => <SessionArchive />, root);
    await tick();
    expect(root.textContent).toContain("No archived chats.");
  });

  it("calls archiveAgentSession on Restore and removes row", async () => {
    fetchAgentSessionsMock.mockResolvedValue({
      items: [
        {
          agentId: "alpha",
          sessionId: "s1",
          createdAt: Date.now(),
          lastActivity: Date.now(),
          messageCount: 3,
          firstUserMessage: "Restore me",
          archived: Date.now() - 3600000,
          isMain: false,
          pinned: null,
        },
      ],
    });
    archiveAgentSessionMock.mockResolvedValue(undefined);
    dispose = render(() => <SessionArchive />, root);
    await tick();
    expect(root.textContent).toContain("Restore me");
    const restoreButton = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (btn) => btn.textContent === "Restore"
    );
    expect(restoreButton).toBeTruthy();
    restoreButton!.click();
    await tick();
    expect(archiveAgentSessionMock).toHaveBeenCalledWith("alpha", "s1", false);
    expect(showToastMock).toHaveBeenCalledWith("Chat restored", "success");
    expect(root.textContent).not.toContain("Restore me");
  });

  it("opens confirm dialog on Delete and calls deleteAgentSession", async () => {
    fetchAgentSessionsMock.mockResolvedValue({
      items: [
        {
          agentId: "gamma",
          sessionId: "s3",
          createdAt: Date.now(),
          lastActivity: Date.now(),
          messageCount: 1,
          firstUserMessage: "Delete me",
          archived: Date.now() - 7200000,
          isMain: false,
          pinned: null,
        },
      ],
    });
    deleteAgentSessionMock.mockResolvedValue(undefined);
    dispose = render(() => <SessionArchive />, root);
    await tick();
    expect(root.textContent).toContain("Delete me");
    const deleteButton = Array.from(root.querySelectorAll<HTMLButtonElement>(".archive-session-actions button")).find(
      (btn) => btn.textContent === "Delete"
    );
    expect(deleteButton).toBeTruthy();
    deleteButton!.click();
    await tick();
    expect(root.textContent).toContain("Delete archived chat?");
    expect(root.textContent).toContain("This will permanently delete the chat and all its history.");
    const dialog = root.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    const confirmButton = Array.from(dialog!.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent === "Delete"
    );
    expect(confirmButton).toBeTruthy();
    confirmButton!.click();
    await tick();
    expect(deleteAgentSessionMock).toHaveBeenCalledWith("gamma", "s3");
    expect(showToastMock).toHaveBeenCalledWith("Chat deleted", "success");
    expect(root.textContent).not.toContain("Delete me");
  });

  it("opens an archived chat with an encoded session id", async () => {
    fetchAgentSessionsMock.mockResolvedValue({
      items: [
        {
          agentId: "delta",
          sessionId: "tile#plan%23",
          createdAt: Date.now(),
          lastActivity: Date.now(),
          messageCount: 10,
          firstUserMessage: "Open me",
          archived: Date.now() - 1800000,
          isMain: false,
          pinned: null,
        },
      ],
    });
    dispose = render(() => <SessionArchive />, root);
    await tick();
    const openButton = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (btn) => btn.textContent === "Open"
    );
    expect(openButton).toBeTruthy();
    openButton!.click();
    expect(navigateMock).toHaveBeenCalledWith("/chat/delta?session=tile%23plan%2523");
  });

  it("refreshes list on chat-projects-changed event", async () => {
    fetchAgentSessionsMock.mockResolvedValue({
      items: [
        {
          agentId: "epsilon",
          sessionId: "s5",
          createdAt: Date.now(),
          lastActivity: Date.now(),
          messageCount: 5,
          firstUserMessage: "First archived",
          archived: Date.now() - 3600000,
          isMain: false,
          pinned: null,
        },
      ],
    });
    dispose = render(() => <SessionArchive />, root);
    await tick();
    expect(root.textContent).toContain("First archived");
    const rows = root.querySelectorAll(".archive-session");
    expect(rows.length).toBe(1);

    fetchAgentSessionsMock.mockResolvedValue({
      items: [
        {
          agentId: "epsilon",
          sessionId: "s5",
          createdAt: Date.now(),
          lastActivity: Date.now(),
          messageCount: 5,
          firstUserMessage: "First archived",
          archived: Date.now() - 3600000,
          isMain: false,
          pinned: null,
        },
        {
          agentId: "zeta",
          sessionId: "s6",
          createdAt: Date.now(),
          lastActivity: Date.now(),
          messageCount: 3,
          firstUserMessage: "Second archived",
          archived: Date.now() - 1800000,
          isMain: false,
          pinned: null,
        },
      ],
    });

    window.dispatchEvent(new Event("chat-projects-changed"));
    await tick();

    const updatedRows = root.querySelectorAll(".archive-session");
    expect(updatedRows.length).toBe(2);
    expect(root.textContent).toContain("First archived");
    expect(root.textContent).toContain("Second archived");
  });
});
