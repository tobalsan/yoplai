// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const { fetchSchedulesMock, updateScheduleMock, sessionUser } = vi.hoisted(() => ({
  fetchSchedulesMock: vi.fn(),
  updateScheduleMock: vi.fn(),
  sessionUser: { id: "alice", role: "user" as string | undefined },
}));

vi.mock("../auth/client", () => ({
  useSession: () => () => ({ data: { user: sessionUser } }),
}));

vi.mock("../api/schedules", () => ({
  fetchSchedules: fetchSchedulesMock,
  updateSchedule: updateScheduleMock,
}));

import { describeSchedule, SchedulesPanel } from "./SchedulesPanel";

let container: HTMLElement;
let dispose: () => void;

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  fetchSchedulesMock.mockReset().mockResolvedValue([{
    id: "job-1", agentId: "scribe", name: "Digest", credentialMode: "team",
    ownerUserId: "alice", schedule: { cron: "0 8 * * *", tz: "UTC" }, payload: { message: "Send digest" },
  }]);
  updateScheduleMock.mockReset().mockResolvedValue({});
  sessionUser.role = "user";
});

afterEach(() => {
  dispose?.();
  container.remove();
});

describe("describeSchedule", () => {
  it("reads cron recurrences in plain language", () => {
    expect(describeSchedule({ cron: "45 5 * * *", tz: "UTC" })).toMatch(/^Every day at /);
    expect(describeSchedule({ cron: "30 7 * * 1,4", tz: "UTC" })).toMatch(/^Monday and Thursday at /);
    expect(describeSchedule({ cron: "0 9 * * 1-5", tz: "UTC" })).toMatch(/^Monday through Friday at /);
    expect(describeSchedule({ cron: "*/15 * * * *", tz: "UTC" })).toBe("Every 15 minutes");
  });

  it("describes one-off runs and falls back to the raw expression", () => {
    expect(describeSchedule({ runAt: "2026-10-05T14:00:00Z" })).toMatch(/^Once, /);
    expect(describeSchedule({ cron: "not a cron", tz: "UTC" })).toBe("not a cron");
  });
});

describe("SchedulesPanel", () => {
  it("recovers from a failed mode change and keeps jobs usable", async () => {
    updateScheduleMock.mockRejectedValueOnce(new Error("Connection lost"));
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await settle();
    const mine = container.querySelector<HTMLButtonElement>('[role="radio"]')!;
    mine.click();
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection lost");
    expect(mine.disabled).toBe(false);
    expect(fetchSchedulesMock).toHaveBeenCalledTimes(2);
    mine.click();
    await settle();
    expect(updateScheduleMock).toHaveBeenCalledTimes(2);
  });

  it("shows creator attribution only on shared jobs with a creator", async () => {
    const job = { id: "job", agentId: "scribe", schedule: { cron: "0 8 * * *" }, payload: {} };
    fetchSchedulesMock.mockResolvedValue([
      { ...job, id: "mine", name: "Own shared", credentialMode: "team", createdByUserId: "alice", createdByDisplayName: "Alice" },
      { ...job, id: "other", name: "Other shared", credentialMode: "team", createdByUserId: "bob", createdByDisplayName: "Bob" },
      { ...job, id: "legacy", name: "Legacy", credentialMode: "team" },
      { ...job, id: "private", name: "Private", credentialMode: "owner", createdByUserId: "alice", createdByDisplayName: "Alice" },
    ]);
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await settle();
    const cards = container.querySelectorAll("li.schedule");
    expect(cards[0]!.textContent).toContain("Created by you");
    expect(cards[1]!.textContent).toContain("Created by Bob");
    expect(cards[2]!.textContent).not.toContain("Created by");
    expect(cards[3]!.textContent).not.toContain("Created by");
    expect(container.querySelector('button[title*="visible to everyone on the agent"]')).not.toBeNull();
  });

  it("lists jobs in plain language and switches their credentials", async () => {
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await settle();
    expect(container.textContent).toContain("Digest");
    expect(container.textContent).toMatch(/Every day at /);
    expect(container.textContent).not.toContain("0 8 * * *");
    expect(container.textContent).toContain("Send digest");
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("If you want to add a new job, just ask Scribe!");

    const group = container.querySelector('[aria-label="Credentials for Digest"]')!;
    const [mine, team] = group.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(team!.getAttribute("aria-checked")).toBe("true");
    mine!.click();
    await settle();
    expect(updateScheduleMock).toHaveBeenCalledWith("scribe", "job-1", { credentialMode: "owner" });
  });

  it("pauses own jobs but locks Team job toggles for non-admins", async () => {
    const job = { agentId: "scribe", schedule: { cron: "0 8 * * *" }, payload: {} };
    fetchSchedulesMock.mockResolvedValue([
      { ...job, id: "mine", name: "Mine", credentialMode: "owner", ownerUserId: "alice", enabled: true },
      { ...job, id: "team", name: "Shared", credentialMode: "team", enabled: true },
    ]);
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await settle();
    const [mine, team] = container.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    expect(team!.disabled).toBe(true);
    expect(team!.title).toContain("Only admins");
    mine!.click();
    expect(mine!.getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector("li.schedule")!.textContent).toContain("Paused");
    await settle();
    expect(updateScheduleMock).toHaveBeenCalledWith("scribe", "mine", { enabled: false });
  });

  it("lets admins resume Team jobs", async () => {
    sessionUser.role = "admin";
    fetchSchedulesMock.mockResolvedValue([
      { id: "team", agentId: "scribe", name: "Shared", credentialMode: "team", enabled: false, schedule: { cron: "0 8 * * *" }, payload: {} },
    ]);
    dispose = render(() => <SchedulesPanel agentId="scribe" agentName="Scribe" />, container);
    await settle();
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.disabled).toBe(false);
    toggle.click();
    await settle();
    expect(updateScheduleMock).toHaveBeenCalledWith("scribe", "team", { enabled: true });
  });
});
