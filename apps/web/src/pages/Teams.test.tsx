// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { Team } from "../api/teams";

const mocks = vi.hoisted(() => ({
  fetchTeams: vi.fn(),
  createTeam: vi.fn(),
  updateTeam: vi.fn(),
  fetchTeamMembers: vi.fn(),
  fetchTeamAgents: vi.fn(),
  fetchUsers: vi.fn(),
  useSession: vi.fn(),
}));

vi.mock("../api/teams", () => ({
  ...mocks,
  deleteTeam: vi.fn(),
  fetchDeleteTeamPreview: vi.fn(),
  removeForkFromTeam: vi.fn(),
  setTeamMembers: vi.fn(),
}));
vi.mock("../api/admin", () => ({ fetchUsers: mocks.fetchUsers }));
vi.mock("../auth/client", () => ({ useSession: mocks.useSession }));
vi.mock("@solidjs/router", () => ({ A: () => document.createElement("a") }));

import { Teams } from "./Teams";

const team: Team = {
  id: "team-1", name: "Research", description: null, color: "#6b7280",
  icon: "fa-solid fa-users", allUsers: false, private: true, memberCount: 1, canManage: true,
  createdBy: "admin", createdAt: "2026-10-07",
};

describe("team privacy controls", () => {
  let container: HTMLDivElement;
  let dispose: () => void;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.fetchTeams.mockResolvedValue([team]);
    mocks.fetchTeamMembers.mockResolvedValue({ teamId: team.id, allUsers: false, members: [{ id: "user-1", name: "Member", email: null }] });
    mocks.fetchTeamAgents.mockResolvedValue([]);
    mocks.fetchUsers.mockResolvedValue([]);
    mocks.useSession.mockReturnValue(() => ({ data: { user: { role: "superadmin" } } }));
    container = document.createElement("div");
    document.body.append(container);
    dispose = render(() => <Teams />, container);
  });

  afterEach(() => {
    dispose();
    container.remove();
  });

  async function click(label: string) {
    await vi.waitFor(() => {
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
      expect(button).toBeDefined();
      button!.click();
    });
  }

  it("defaults new teams to public and allows private creation", async () => {
    await click("New team");
    const privacy = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(privacy.checked).toBe(false);
    const name = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    name.value = "Sensitive";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    privacy.click();
    await click("Create");
    expect(mocks.createTeam).toHaveBeenCalledWith(expect.objectContaining({ name: "Sensitive", private: true }));
  });

  it("shows a badge and toggles privacy immediately without changing members", async () => {
    await vi.waitFor(() => expect(container.querySelector(".team-card__private")?.textContent).toContain("Private"));
    mocks.updateTeam.mockResolvedValue({ ...team, private: false });
    await click("Members");
    await click("Private");
    expect(mocks.updateTeam).toHaveBeenCalledWith(team.id, { private: false });
    await vi.waitFor(() => expect(container.querySelector('[aria-label="Private team"]')?.textContent).toBe("Public"));
    expect(container.textContent).toContain("Member");
    expect(container.textContent).toContain("Current members stay unchanged");
  });

  it("preserves privacy and permits retry when an update fails", async () => {
    mocks.updateTeam.mockRejectedValue(new Error("Connection failed"));
    await click("Members");
    await click("Private");
    await vi.waitFor(() => expect(container.textContent).toContain("Connection failed"));
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Private team"]')!;
    expect(toggle.textContent).toBe("Private");
    expect(toggle.disabled).toBe(false);
  });

  it("keeps membership controls and Close usable while a privacy update hangs", async () => {
    mocks.updateTeam.mockImplementation(() => new Promise<Team>(() => {}));
    await click("Members");
    await click("Private");
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Private team"]')!;
    expect(toggle.disabled).toBe(true);
    toggle.click();
    expect(mocks.updateTeam).toHaveBeenCalledTimes(1);

    const allUsers = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(allUsers.disabled).toBe(false);
    allUsers.click();
    await vi.waitFor(() => expect(allUsers.checked).toBe(true));
    expect([...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save")?.disabled).toBe(false);
    await click("Close");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector(".team-card__name")?.textContent).toBe(team.name);
  });
});

describe("admin team scoping", () => {
  it("hides create/delete from admins and edit on teams they don't belong to", async () => {
    vi.resetAllMocks();
    mocks.fetchTeams.mockResolvedValue([
      { ...team, id: "own", name: "Own", canManage: true },
      { ...team, id: "other", name: "Other", canManage: false },
    ]);
    mocks.useSession.mockReturnValue(() => ({ data: { user: { role: "admin" } } }));
    const container = document.createElement("div");
    document.body.append(container);
    const dispose = render(() => <Teams />, container);
    await vi.waitFor(() => expect(container.textContent).toContain("Other"));
    const labels = [...container.querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(labels).not.toContain("New team");
    expect(labels).not.toContain("Delete");
    expect(labels.filter((label) => label === "Edit")).toHaveLength(1);
    dispose();
    container.remove();
  });
});
