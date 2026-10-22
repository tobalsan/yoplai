// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "solid-js";
import { render } from "solid-js/web";
import type { Team } from "../api/teams";

const mocks = vi.hoisted(() => ({
  fetchTeams: vi.fn(),
  fetchTeamlessUsers: vi.fn(),
  addTeamMember: vi.fn(),
  createTeam: vi.fn(),
  updateTeam: vi.fn(),
  fetchTeamMembers: vi.fn(),
  fetchTeamAgents: vi.fn(),
  fetchUsers: vi.fn(),
  fetchPool: vi.fn(),
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
vi.mock("../api/agents", () => ({ fetchPool: mocks.fetchPool }));
vi.mock("../auth/client", () => ({ useSession: mocks.useSession }));
vi.mock("@solidjs/router", () => ({ A: () => document.createElement("a") }));

import { Teams } from "./Teams";

const team: Team = {
  id: "team-1", name: "Research", description: null, color: "#6b7280",
  icon: "fa-solid fa-users", allUsers: false, private: true, memberCount: 1, canManage: true,
  createdBy: "admin", createdAt: "2026-10-07",
};

describe("team organization", () => {
  let container: HTMLDivElement;
  let dispose: () => void;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.fetchTeams.mockResolvedValue([team, { ...team, id: "foreign", name: "HR", canManage: false }]);
    mocks.fetchTeamlessUsers.mockResolvedValue([{ id: "newcomer", name: "Newcomer", email: "new@example.test", approved: false, role: "user" }]);
    mocks.addTeamMember.mockResolvedValue({ teamId: team.id, allUsers: false, members: [] });
    mocks.fetchTeamMembers.mockResolvedValue({ teamId: team.id, allUsers: false, members: [{ id: "user-1", name: "Member", email: null }] });
    mocks.fetchTeamAgents.mockResolvedValue([]);
    mocks.fetchUsers.mockResolvedValue([]);
    mocks.fetchPool.mockResolvedValue([]);
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

  it("places a pending team-less newcomer using only manageable teams", async () => {
    await vi.waitFor(() => expect(container.textContent).toContain("No team (1)"));
    expect(container.textContent).toContain("Newcomer");
    expect(container.textContent).toContain("new@example.test");
    expect(container.textContent).toContain("Pending");
    const picker = container.querySelector<HTMLSelectElement>('[aria-label="Team for Newcomer"]')!;
    expect([...picker.options].map((option) => option.text)).toEqual(["Choose a team", "Research"]);
    picker.value = team.id;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await click("Add to team");
    await vi.waitFor(() => expect(mocks.addTeamMember).toHaveBeenCalledWith(team.id, "newcomer"));
    await vi.waitFor(() => expect(container.textContent).toContain("Everyone is in a team"));
    expect(container.textContent).not.toContain("Newcomer");
  });

  it("shows photos and initials in the No team directory", async () => {
    dispose();
    mocks.fetchTeamlessUsers.mockResolvedValue([
      { id: "ada", name: "Ada Lovelace", email: "ada@example.test", image: "https://lh3.googleusercontent.com/ada", approved: true, role: "user" },
      { id: "bob", name: "Bob Ross", email: "bob@example.test", image: null, approved: true, role: "user" },
    ]);
    dispose = render(() => <Teams />, container);
    await vi.waitFor(() => expect(container.textContent).toContain("No team (2)"));
    const rows = container.querySelectorAll(".team-member");
    const photo = rows[0]!.querySelector("img");
    expect(photo?.getAttribute("src")).toBe("https://lh3.googleusercontent.com/ada");
    expect(rows[1]!.querySelector(".team-detail__avatar")?.textContent).toBe("BR");
    photo!.dispatchEvent(new Event("error"));
    expect(rows[0]!.querySelector(".team-detail__avatar")?.textContent).toBe("AL");
  });

  it("keeps placement retryable after failure and the rest of the page usable during a hung add", async () => {
    mocks.addTeamMember.mockRejectedValueOnce(new Error("Placement failed"));
    await vi.waitFor(() => expect(container.textContent).toContain("No team (1)"));
    const picker = container.querySelector<HTMLSelectElement>('[aria-label="Team for Newcomer"]')!;
    picker.value = team.id;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await click("Add to team");
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Placement failed"));
    expect(container.textContent).toContain("Newcomer");
    mocks.addTeamMember.mockImplementation(() => new Promise(() => {}));
    await click("Add to team");
    const adding = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Adding…")!;
    expect(adding.disabled).toBe(true);
    adding.click();
    expect(mocks.addTeamMember).toHaveBeenCalledTimes(2);
    await click("Members");
    await click("Close");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("disables placement with a hint for staff who manage no teams", async () => {
    dispose();
    mocks.fetchTeams.mockResolvedValue([{ ...team, canManage: false }]);
    mocks.useSession.mockReturnValue(() => ({ data: { user: { role: "admin" } } }));
    dispose = render(() => <Teams />, container);
    await vi.waitFor(() => expect(container.textContent).toContain("No team (1)"));
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Team for Newcomer"]')?.disabled).toBe(true);
    expect(container.textContent).toContain("You do not manage any teams");
  });

  it("keeps teams usable when the No team directory fails to load", async () => {
    dispose();
    mocks.fetchTeamlessUsers.mockRejectedValue(new Error("Directory offline"));
    dispose = render(() => <ErrorBoundary fallback={<p>Page failed</p>}><Teams /></ErrorBoundary>, container);
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Directory offline"));
    expect(container.textContent).toContain("Research");
    expect(container.textContent).not.toContain("Everyone is in a team");
    await click("Members");
    await click("Close");
  });

  it("shows Public and Private badges on the team's owned agents", async () => {
    mocks.fetchTeamAgents.mockResolvedValue([
      { sourcePoolId: "casey", forkAgentId: "Casey", public: true, assignment: { mode: "list", teamIds: [team.id] } },
      { sourcePoolId: "henry", forkAgentId: "Henry", public: false, assignment: { mode: "list", teamIds: [team.id] } },
    ]);
    mocks.fetchPool.mockResolvedValue([{ id: "casey", name: "Casey Sales", avatar: "/api/pool/casey/avatar" }]);
    await click("Members");
    await vi.waitFor(() => expect(container.textContent).toContain("Casey Sales"));
    expect(container.querySelector('img[src="/api/pool/casey/avatar"]')).not.toBeNull();
    const rows = [...container.querySelectorAll("li")];
    expect(rows.find((row) => row.textContent?.includes("Casey"))?.textContent).toContain("Public");
    expect(rows.find((row) => row.textContent?.includes("Henry"))?.textContent).toContain("Private");
  });

  it("shows member photos with initials for absent or failed photos", async () => {
    mocks.fetchTeamMembers.mockResolvedValue({ teamId: team.id, allUsers: false, members: [
      { id: "ada", name: "Ada Lovelace", email: "ada@example.test", image: "https://lh3.googleusercontent.com/ada" },
      { id: "bob", name: "Bob Ross", email: "bob@example.test", image: null },
    ] });
    await click("Members");
    const photo = await vi.waitFor(() => {
      const image = container.querySelector<HTMLImageElement>('img[src="https://lh3.googleusercontent.com/ada"]');
      expect(image).not.toBeNull();
      return image!;
    });
    const bob = [...container.querySelectorAll("li")].find((row) => row.textContent?.includes("Bob Ross"))!;
    expect(bob.querySelector(".team-detail__avatar")?.textContent).toBe("BR");
    const adaAvatar = photo.parentElement!;
    photo.dispatchEvent(new Event("error"));
    expect(adaAvatar.querySelector("img")).toBeNull();
    expect(adaAvatar.textContent).toBe("AL");
  });

  it("asks before removing an agent from the team", async () => {
    const { removeForkFromTeam } = await import("../api/teams");
    vi.mocked(removeForkFromTeam).mockResolvedValue(undefined as never);
    mocks.fetchTeamAgents.mockResolvedValue([{ sourcePoolId: "casey", forkAgentId: "casey", public: false, assignment: { mode: "list", teamIds: [team.id] } }]);
    mocks.fetchPool.mockResolvedValue([{ id: "casey", name: "Casey" }]);
    await vi.waitFor(() => expect(container.textContent).toContain("Research"));
    const research = [...container.querySelectorAll("article")].find((card) => card.textContent?.includes("Research"))!;
    [...research.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Members")!.click();
    const remove = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[aria-label="Remove Casey from team"]');
      expect(button).not.toBeNull();
      return button!;
    });
    remove.click();
    const confirm = () => container.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(confirm()?.textContent).toContain("If you remove Casey from this team, Casey has no team. Only a superadmin can assign Casey to a team again.");
    expect(removeForkFromTeam).not.toHaveBeenCalled();
    [...confirm()!.querySelectorAll("button")].find((button) => button.textContent === "Remove")!.click();
    await vi.waitFor(() => expect(removeForkFromTeam).toHaveBeenCalledWith("casey", team.id));
    await vi.waitFor(() => expect(confirm()).toBeNull());
  });

  it("adds a searched member with Enter, stages All users, and saves from the footer", async () => {
    const { setTeamMembers } = await import("../api/teams");
    vi.mocked(setTeamMembers).mockResolvedValue({ teamId: team.id, allUsers: false, members: [] });
    mocks.fetchUsers.mockResolvedValue([{ id: "user-2", name: "Dana", email: "dana@example.test", role: "user", approved: true }]);
    await vi.waitFor(() => expect(container.textContent).toContain("Research"));
    const research = [...container.querySelectorAll("article")].find((card) => card.textContent?.includes("Research"))!;
    [...research.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Members")!.click();
    const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]')!;
    const search = await vi.waitFor(() => {
      const input = dialog().querySelector<HTMLInputElement>('[role="combobox"]');
      expect(input?.disabled).toBe(false);
      return input!;
    });
    const save = () => [...dialog().querySelectorAll("button")].find((button) => button.textContent === "Save")!;
    expect(save().disabled).toBe(true);
    search.value = "dana@";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await vi.waitFor(() => expect(dialog().querySelector('[role="option"]')).not.toBeNull());
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(search.value).toBe("");
    expect(dialog().textContent).toContain("dana@example.test");
    const allUsers = dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(allUsers.closest("label")?.textContent).toContain("All users");
    allUsers.click();
    expect(dialog().querySelector('[role="combobox"]')).toBeNull();
    allUsers.click();
    expect(dialog().textContent).toContain("Cancel");
    save().click();
    await vi.waitFor(() => expect(setTeamMembers).toHaveBeenCalledWith(team.id, { mode: "list", userIds: ["user-1", "user-2"] }));
    await vi.waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull());
  });

  it("says why member search is disabled when every user is in the team", async () => {
    mocks.fetchUsers.mockResolvedValue([{ id: "user-1", name: "Member", email: null, role: "user", approved: true }]);
    await vi.waitFor(() => expect(container.textContent).toContain("Research"));
    const research = [...container.querySelectorAll("article")].find((card) => card.textContent?.includes("Research"))!;
    [...research.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Members")!.click();
    await vi.waitFor(() => {
      const search = container.querySelector<HTMLInputElement>('[role="dialog"] [role="combobox"]')!;
      expect(search.disabled).toBe(true);
      expect(search.placeholder).toBe("All users are already in this team");
    });
  });

  it("asks before closing with unsaved member changes", async () => {
    await vi.waitFor(() => expect(container.textContent).toContain("Research"));
    const research = [...container.querySelectorAll("article")].find((card) => card.textContent?.includes("Research"))!;
    [...research.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Members")!.click();
    const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]');
    const button = (root: HTMLElement, label: string) => [...root.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)!;
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Member"));
    dialog()!.querySelector<HTMLButtonElement>('[aria-label="Remove Member"]')!.click();
    button(dialog()!, "Cancel").click();
    const confirm = () => container.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(confirm()?.textContent).toContain("unsaved changes");
    button(confirm()!, "Cancel").click();
    expect(confirm()).toBeNull();
    expect(dialog()).not.toBeNull();
    button(dialog()!, "Cancel").click();
    button(confirm()!, "Discard").click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });

  it("hides the No team directory from regular users", async () => {
    dispose();
    mocks.fetchTeamlessUsers.mockClear();
    mocks.useSession.mockReturnValue(() => ({ data: { user: { role: "user" } } }));
    dispose = render(() => <Teams />, container);
    await vi.waitFor(() => expect(container.textContent).toContain("Research"));
    expect(container.querySelector(".teams-no-team")).toBeNull();
    expect(mocks.fetchTeamlessUsers).not.toHaveBeenCalled();
  });

  it("omits obsolete team privacy controls while preserving member management", async () => {
    await vi.waitFor(() => expect(container.textContent).toContain("Research"));
    expect(container.querySelector(".team-card__private")).toBeNull();
    await click("New team");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await click("Cancel");
    [...container.querySelectorAll("article")].find((card) => card.textContent?.includes("Research"))!.querySelector<HTMLButtonElement>("button")!.click();
    expect(container.querySelector('[aria-label="Private team"]')).toBeNull();
    expect(container.textContent).not.toContain("auto-join");
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(container.textContent).toContain("Member");
  });

});

describe("admin team scoping", () => {
  it("hides create/delete from admins and edit on teams they don't belong to", async () => {
    vi.resetAllMocks();
    mocks.fetchTeams.mockResolvedValue([
      { ...team, id: "own", name: "Own", canManage: true },
      { ...team, id: "other", name: "Other", canManage: false },
    ]);
    mocks.fetchTeamlessUsers.mockResolvedValue([]);
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
